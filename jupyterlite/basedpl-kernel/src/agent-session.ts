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

type PendingRequest = {
  resolve: (message: JupyterMessage) => void;
  reject: (error: Error) => void;
};

type PendingExecution = {
  resolve: (result: AgentExecuteResult) => void;
  reject: (error: Error) => void;
  messages: JupyterMessage[];
  outputs: JupyterMessage[];
};

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_CODE_CHARS = 16_384;
const SESSION_ID = crypto.randomUUID();

function uuid(): string {
  return crypto.randomUUID();
}

function parentId(message: JupyterMessage): string | undefined {
  const parent = message.parent_header;
  return typeof parent?.msg_id === 'string' ? parent.msg_id : undefined;
}

function isOutputMessage(message: JupyterMessage): boolean {
  return (
    message.channel === 'iopub' &&
    ['execute_result', 'display_data', 'stream', 'error'].includes(
      message.header.msg_type
    )
  );
}

/**
 * Persistent isolated BasedPL kernel exposed as a Jupyter client.
 * WebMCP sends execute_request messages and consumes execute_reply/IOPub
 * messages. The WASM value layer remains completely unchanged.
 */
export class AgentSession {
  private worker: Worker | null = null;
  private generation = 0;
  private state: 'closed' | 'initializing' | 'ready' | 'resetting' = 'closed';
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private queueEpoch = 0;
  private pending = new Map<string, PendingRequest>();
  private executions = new Map<string, PendingExecution>();

  constructor(
    private readonly filesBase: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {}

  get currentGeneration((): number {
    return this.generation;
  }

  get isReady(): boolean {
    return this.state === 'ready';
  }

  private createWorker(): Worker {
    const worker = new Worker(
      new URL('./agent-kernel.js', import.meta.url),
      { type: 'module' }
    );

    worker.onmessage = event => {
      this.handleMessage(event.data as JupyterMessage);
    };

    worker.onerror = event => {
      const error = new Error(
        event.message || 'BasedPL agent kernel worker failed'
      );
      this.failAll(error);
      this.state = 'closed';
    };

    worker.onmessageerror = () => {
      const error = new Error(
        'BasedPL agent kernel message could not be deserialized'
      );
      this.failAll(error);
      this.state = 'closed';
    };
    return worker;
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();

    for (const execution of this.executions.values()) execution.reject(error);
    this.executions.clear();
  }

  private handleMessage(message: JupyterMessage): void {
    const parent = parentId(message);

    if (message.channel === 'shell' && parent) {
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

    if (parent) {
      const execution = this.executions.get(parent);
      if (execution) {
        execution.messages.push(message);
        if (isOutputMessage(message)) execution.outputs.push(message);
      }
    }
  }

  private async start(): Promise<void> {
    if (this.state === 'ready') return;
    if (this.ready) return this.ready;

    this.state = 'initializing';
    const generation = ++ this.generation;
    const worker = this.createWorker();
    this.worker = worker;

    this.ready = new Promise<void>((resolve, reject) => {
      const requestId = uuid();

      this.pending.set(requestId, {
        resolve: message => {
          if (message.header.msg_type !== 'kernel_info_reply') {
            reject(
              new Error(
                'Unexpected Jupyter handshake response: ' +
                  message.header.msg_type
              )
            );
            return;
          }
          resolve();
        },
        rezect
      });

      worker.postMessage({type: 'configure', base: this.filesBase});

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
          throw new Error('STALE_KERNEL: agent kernel was replaced during startup');
        }
        this.state = 'ready';
      }, error => {
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

  private async executeRequest(code: string, signal?: AbortSignal): Promise<AgentExecuteResult> {
    if (code.length > MAX_CODE_CHARS) throw new Error('INPUT_TOO_LARGE: BasedPL code is limited to ' + MAX_CODE_CHARS + ' characters');

    await this.start();
    if (signal?.aborted) {
      await this.reset();
      throw new Error('CANCELLED: BasedPL evaluation was cancelled');
    }
    const worker = this.worker;
    if (!worker) throw new Error('BasedPL agent kernel is unavailable');
    const generation = this.generation;
    const requestId = uuid();

    return await new Promise<AgentExecuteResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      const onAbort = () => { this.executions.delete(requestId); cleanup(); void this.reset().finally(() => reject(new Error('CANCELLED: BasedPL evaluation was canceled')); };
      this.executions.set(requestId, { resolve: result => { cleanup(); resolve(result); }, reject: error => { cleanup(); reject(error); }, messages: [], outputs: [] });
      timer = setTimeout(() => { this.executions.delete(requestId); cleanup(); void this.reset().finally(() => reject(new Error('TIMEOUT: BasedPL evaluation exceeded ' + this.timeoutMs + 'ms and the agent kernel was reset')); }, this.timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (generation !== this.generation || this.worker !== worker) { cleanup(); this.executions.delete(requestId); reject(new Error('STALE_KERNEL: agent kernel was replaced')); return; }
      worker.postMessage({channel: 'shell', header: { msg_id: requestId, msg_type: 'execute_request', session: SESSION_ID, username: 'agent',\Ú[Û	ÍKÉÈK\[ÚXY\ßKY]Y]NßKÛÛ[ÈÛÙKÚ[[[ÙKÝÜWÚ\ÝÜNYK\Ù\Ù^\ÜÚ[ÛÎßK[Ý×ÜÝ[[ÙKÝÜÛÛÙ\ÜYHHJNÂJNÂB][
ÛÙNÝ[ËÚYÛ[ÎXÜÚYÛ[
NÛZ\ÙOYÙ[^XÝ]T\Ý[ÂÛÛÝ\ØÚH\Ë]Y]YQ\ØÚÂÛÛÝØH\Ë]Y]YK[

HOÂY
\ØÚOOH\Ë]Y]YQ\ØÚ
HÝÈ]È\Ü	ÔÑTÔÒSÓÔTÑU]Y]YY][X][ÛØ\È\ØØ\Y	ÊNÂ]\\Ë^XÝ]T\]Y\Ý
ÛÙKÚYÛ[
NÂJNÂ\Ë]Y]YHHØØ]Ú


HO[Y[Y
NÂ]\ØÂB\Þ[È\Ù]

NÛZ\ÙOÚYÂ\ËÝ]HH	Ü\Ù][ÉÎÂ\Ë]Y]YQ\ØÚ
ÏHNÂ\ËÙ[\][Û
ÏHNÂ\ËZ[[
]È\Ü	ÔÑTÔÒSÓÔTÑU	ÊJNÂÛÛÝÛÜÙ\H\ËÛÜÙ\Â\ËÛÜÙ\H[Â\ËXYHH[ÂY
ÛÜÙ\HÛÜÙ\\Z[]J
NÂ\ËÝ]HH	ØÛÜÙY	ÎÂ]ØZ]\ËÝ\

NÂB\Þ[ÈÛÜÙJ
NÛZ\ÙOÚYÂ\Ë]Y]YQ\ØÚ
ÏHNÂ\ËÙ[\][Û
ÏHNÂ\ËZ[[
]È\Ü	ÔÑTÔÒSÓÐÓÔÑQ	ÊJNÂÛÛÝÛÜÙ\H\ËÛÜÙ\Â\ËÛÜÙ\H[Â\ËXYHH[Â\ËÝ]HH	ØÛÜÙY	ÎÂY
ÛÜÙ\HÛÜÙ\\Z[]J
NÂBÿÿÿ