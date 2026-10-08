export type AgentValue = {
  kind: 'null' | 'apl-text';
  text: string | null;
  output: string;
  events: unknown[];
  truncated: boolean;
  error: string | null;
};

export type AgentEvalResult = {
  result: AgentValue;
  meta: {
    durationMs: number;
    stateChanged: boolean;
  };
};

type WorkerReady = {
  type: 'ready';
  requestId: string;
  generation: number;
  runtime: {
    name: string;
    version: string;
  };
  capabilities: {
    eval: boolean;
    fileRead: boolean;
    fileWrite: boolean;
    network: boolean;
  };
};

type WorkerMessage =
  | WorkerReady
  | {
      type: 'result';
      requestId: string;
      generation: number;
      result: AgentValue;
      meta: AgentEvalResult['meta'];
    }
  | {
      type: 'error' | 'fatal';
      requestId?: string;
      generation: number;
      error: {
        code: string;
        message: string;
      };
    }
  | {
      type: 'shutdown';
      requestId: string;
      generation: number;
    };

type Pending = {
  resolve: (message: WorkerMessage) => void;
  reject: (error: Error) => void;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_CODE_CHARS = 16_384;

export class AgentSession {
  private worker: Worker | null = null;
  private pending = new Map<string, Pending>();
  private nextRequestId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private ready: Promise<void> | null = null;
  private state: 'closed' | 'initializing' | 'ready' | 'resetting' = 'closed';

  constructor(
    private readonly filesBase: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {}

  get currentGeneration(): number {
    return this.generation;
  }

  get isReady(): boolean {
    return this.state === 'ready';
  }

  private newRequestId(prefix: string): string {
    return `${prefix}-${this.nextRequestId++}`;
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL('./agent-worker.js', import.meta.url), {
      type: 'module'
    });

    worker.onmessage = event => this.handleMessage(event.data as WorkerMessage);
    worker.onerror = event => {
      const error = new Error(event.message || 'BasedPL agent worker failed');
      this.failAll(error);
      this.state = 'closed';
    };
    worker.onmessageerror = () => {
      const error = new Error('BasedPL agent worker message could not be deserialized');
      this.failAll(error);
      this.state = 'closed';
    };

    return worker;
  }

  private handleMessage(message: WorkerMessage): void {
    if (message.generation !== this.generation) return;

    if (message.type === 'fatal') {
      const error = new Error(message.error.message);
      if (message.requestId) {
        const pending = this.pending.get(message.requestId);
        if (pending) {
          this.pending.delete(message.requestId);
          pending.reject(error);
        }
      }
      this.failAll(error);
      this.state = 'closed';
      return;
    }

    if (message.type === 'ready') {
      const pending = this.pending.get(message.requestId);
      if (pending) {
        this.pending.delete(message.requestId);
        pending.resolve(message);
      }
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) return;

    this.pending.delete(message.requestId);

    if (message.type === 'error') {
      pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
    } else {
      pending.resolve(message);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async start(): Promise<void> {
    if (this.state === 'ready') return;
    if (this.ready) return this.ready;

    this.state = 'initializing';
    this.generation += 1;
    const generation = this.generation;
    this.worker = this.createWorker();

    this.ready = new Promise<void>((resolve, reject) => {
      const requestId = this.newRequestId('init');
      this.pending.set(requestId, {
        resolve: message => {
          if (message.type !== 'ready') {
            reject(new Error('Unexpected agent worker initialization response'));
            return;
          }
          resolve();
        },
        reject
      });

      this.worker!.postMessage({
        type: 'init',
        requestId,
        generation,
        filesBase: this.filesBase
      });
    }).then(
      () => {
        this.state = 'ready';
      },
      error => {
        this.state = 'closed';
        throw error;
      }
    ).finally(() => {
      this.ready = null;
    });

    return this.ready;
  }

  private async execute(
    code: string,
    signal?: AbortSignal
  ): Promise<AgentEvalResult> {
    if (code.length > MAX_CODE_CHARS) {
      throw new Error(`INPUT_TOO_LARGE: BasedPL code is limited to ${MAX_CODE_CHARS} characters`);
    }

    await this.start();

    if (signal?.aborted) {
      await this.reset();
      throw new Error('CANCELLED: BasedPL evaluation was cancelled');
    }

    const worker = this.worker;
    if (!worker) throw new Error('BasedPL agent worker is unavailable');

    const generation = this.generation;
    const requestId = this.newRequestId('eval');

    return await new Promise<AgentEvalResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        cleanup();
        void this.reset().finally(() =>
          reject(new Error('CANCELLED: BasedPL evaluation was cancelled'))
        );
      };

      this.pending.set(requestId, {
        resolve: message => {
          cleanup();

          if (message.type !== 'result') {
            reject(new Error('Unexpected BasedPL evaluation response'));
            return;
          }

          resolve({
            result: message.result,
            meta: message.meta
          });
        },
        reject: error => {
          cleanup();
          reject(error);
        }
      });

      timer = setTimeout(() => {
        cleanup();
        void this.reset().finally(() =>
          reject(new Error(`TIMEOUT: BasedPL evaluation exceeded ${this.timeoutMs}ms and the agent session was reset`))
        );
      }, this.timeoutMs);

      signal?.addEventListener('abort', onAbort, { once: true });

      worker.postMessage({
        type: 'eval',
        requestId,
        generation,
        code
      });
    });
  }

  eval(code: string, signal?: AbortSignal): Promise<AgentEvalResult> {
    const job = this.queue.then(() => this.execute(code, signal));
    this.queue = job.catch(() => undefined);
    return job;
  }

  async reset(): Promise<void> {
    this.state = 'resetting';
    this.generation += 1;
    this.failAll(new Error('SESSION_RESET'));

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    this.ready = null;
    await this.start();
  }

  async close(): Promise<void> {
    this.generation += 1;
    this.failAll(new Error('SESSION_CLOSED'));

    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    this.state = 'closed';

    if (worker) worker.terminate();
  }
}
