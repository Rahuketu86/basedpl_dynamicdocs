export type JupyterHeader = {
  msg_id: string;
  msg_type: string;
  session: string;
  username: string;
  version: string;
};

export type JupyterMessage = {
  channel: 'shell' | 'iopub' | 'stdin' | 'control';
  header: JupyterHeader;
  parent_header: Partial<JupyterHeader> | Record<string, unknown>;
  metadata: Record<string, unknown>;
  content: Record<string, unknown>;
};

export type AgentExecuteResult = {
  execute_reply: JupyterMessage;
  messages: JupyterMessage[];
  outputs: JupyterMessage[];
};

type Pending = {
  resolve: (message: JupyterMessage) => void;
  reject: (error: Error) => void;
};

type Execution = {
  resolve: (result: AgentExecuteResult) => void;
  reject: (error: Error) => void;
  messages: JupyterMessage[];
  outputs: JupyterMessage[];
};

const TIMEOUT_MS = 5000;
const MAX_CODE_CHARS = 16384;
const SESSION_ID = crypto.randomUUID();

const parentId = (message: JupyterMessage): string | undefined =>
  typeof message.parent_header?.msg_id === 'string'
    ? message.parent_header.msg_id
    : undefined;

const isOutput = (message: JupyterMessage): boolean =>
  message.channel === 'iopub' &&
  ['execute_result', 'display_data', 'stream', 'error'].includes(
    message.header.msg_type
  );

export class AgentSession {
  private worker: Worker | null = null;
  private generation = 0;
  private state: 'closed' | 'initializing' | 'ready' | 'resetting' = 'closed';
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private queueEpoch = 0;
  private pending = new Map<string, Pending>();
  private executions = new Map<string, Execution>();

  constructor(
    private readonly filesBase: string,
    private readonly timeoutMs = TIMEOUT_MS
  ) {}

  private failAll(error: Error): void {
    for (const p of this.pending.values()) p.reject(error);
    for (const e of this.executions.values()) e.reject(error);
    this.pending.clear();
    this.executions.clear();
  }

  private createWorker(): Worker {
    const worker = new Worker(
      new URL('./agent-kernel.js', import.meta.url),
      { type: 'module' }
    );

    worker.onmessage = event => this.handleMessage(event.data as JupyterMessage);
    worker.onerror = event => {
      this.failAll(new Error(event.message || 'BasedPL agent kernel failed'));
      this.state = 'closed';
    };
    worker.onmessageerror = () => {
      this.failAll(new Error('BasedPL agent kernel message error'));
      this.state = 'closed';
    };

    return worker;
  }

  private handleMessage(message: JupyterMessage): void {
    const parent = parentId(message);
    if (!parent) return;

    if (message.channel === 'shell') {
      const execution = this.executions.get(parent);
      if (execution && message.header.msg_type === 'execute_reply') {
        execution.messages.push(message);
        this.executions.delete(parent);
        execution.resolve({
          execute_reply: message,
          messages: execution.messages,
          outputs: execution.outputs
        });
        return;
      }

      const pending = this.pending.get(parent);
      if (pending) {
        this.pending.delete(parent);
        pending.resolve(message);
        return;
      }
    }

    const execution = this.executions.get(parent);
    if (execution) {
      execution.messages.push(message);
      if (isOutput(message)) execution.outputs.push(message);
    }
  }

  private async start(): Promise<void> {
    if (this.state === 'ready') return;
    if (this.ready) return this.ready;

    this.state = 'initializing';
    const generation = ++this.generation;
    const worker = this.createWorker();
    this.worker = worker;

    this.ready = new Promise<void>((resolve, reject) => {
      const requestId = crypto.randomUUID();

      this.pending.set(requestId, {
        resolve: message => {
          if (message.header.msg_type !== 'kernel_info_reply') {
            reject(new Error(
              'Unexpected Jupyter handshake response: ' +
              message.header.msg_type
            ));
            return;
          }
          resolve();
        },
        reject
      });

      // Only worker bootstrap uses a non-Jupyter message. All runtime
      // interaction below is standard Jupyter kernel messaging.
      worker.postMessage({ type: 'configure', base: this.filesBase });

      worker.postMessage({
        channel: 'shell',
        header: {
          msg_id: requestId,
          msg_type: 'kernel_info_request',
          session: SESSION_ID,
          username: 'agent',
          version: '5.3'
        },
        parent_header: {},
        metadata: {},
        content: {}
      } satisfies JupyterMessage);
    }).then(() => {
      if (generation !== this.generation || this.worker !== worker) {
        throw new Error('STALE_KERNEL: agent kernel was replaced');
      }
      this.state = 'ready';
    }).catch(error => {
      if (this.worker === worker) {
        worker.terminate();
        this.worker = null;
      }
      this.state = 'closed';
      throw error;
    }).finally(() => {
      this.ready = null;
    });

    return this.ready;
  }

  private async executeRequest(
    code: string,
    signal?: AbortSignal
  ): Promise<AgentExecuteResult> {
    if (code.length > MAX_CODE_CHARS) {
      throw new Error(
        'INPUT_TOO_LARGE: BasedPL code is limited to ' +
        MAX_CODE_CHARS +
        ' characters'
      );
    }

    await this.start();
    if (signal?.aborted) {
      await this.reset();
      throw new Error('CANCELLED: BasedPL evaluation was cancelled');
    }

    const worker = this.worker;
    if (!worker) throw new Error('BasedPL agent kernel is unavailable');

    const generation = this.generation;
    const requestId = crypto.randomUUID();

    return new Promise<AgentExecuteResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        this.executions.delete(requestId);
        cleanup();
        void this.reset().finally(() =>
          reject(new Error('CANCELLED: BasedPL evaluation was cancelled'))
        );
      };

      this.executions.set(requestId, {
        resolve: result => {
          cleanup();
          resolve(result);
        },
        reject: error => {
          cleanup();
          reject(error);
        },
        messages: [],
        outputs: []
      });

      timer = setTimeout(() => {
        this.executions.delete(requestId);
        cleanup();
        void this.reset().finally(() =>
          reject(new Error(
            'TIMEOUT: BasedPL evaluation exceeded ' +
            this.timeoutMs +
            'ms and the agent kernel was reset'
          ))
        );
      }, this.timeoutMs);

      signal?.addEventListener('abort', onAbort, { once: true });

      if (generation !== this.generation || this.worker !== worker) {
        cleanup();
        this.executions.delete(requestId);
        reject(new Error('STALE_KERNEL: agent kernel was replaced'));
        return;
      }

      worker.postMessage({
        channel: 'shell',
        header: {
          msg_id: requestId,
          msg_type: 'execute_request',
          session: SESSION_ID,
          username: 'agent',
          version: '5.3'
        },
        parent_header: {},
        metadata: {},
        content: {
          code,
          silent: false,
          store_history: true,
          user_expressions: {},
          allow_stdin: false,
          stop_on_error: true
        }
      } satisfies JupyterMessage);
    });
  }

  eval(code: string, signal?: AbortSignal): Promise<AgentExecuteResult> {
    const epoch = this.queueEpoch;
    const job = this.queue.then(() => {
      if (epoch !== this.queueEpoch) {
        throw new Error('SESSION_RESET: queued evaluation was discarded');
      }
      return this.executeRequest(code, signal);
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  async reset(): Promise<void> {
    this.state = 'resetting';
    this.queueEpoch += 1;
    this.generation += 1;
    this.failAll(new Error('SESSION_RESET'));

    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    if (worker) worker.terminate();

    this.state = 'closed';
    await this.start();
  }

  async close(): Promise<void> {
    this.queueEpoch += 1;
    this.generation += 1;
    this.failAll(new Error('SESSION_CLOSED'));

    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    this.state = 'closed';
    if (worker) worker.terminate();
  }
}
