import type { KernelMessage } from '@jupyterlab/services';
import { BaseKernel } from '@jupyterlite/services';

type BplEvent = {
  kind?: string;
  data?: Record<string, unknown>;
};

type BplResult = {
  output: string;
  value: string | null;
  events: BplEvent[];
  error: string | null;
};

type Pending = {
  resolve: (value: any) => void;
  reject: (reason: unknown) => void;
};

export class BasedPLKernel extends BaseKernel {
  private worker: Worker;
  private ready: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(options: any) {
    super(options);
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module'
    });

    this.ready = new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
        if (event.data?.type === 'ready') {
          this.worker.removeEventListener('message', onMessage);
          resolve();
        } else if (event.data?.type === 'fatal') {
          this.worker.removeEventListener('message', onMessage);
          reject(new Error(event.data.error));
        }
      };
      this.worker.addEventListener('message', onMessage);
    });

    this.worker.onmessage = event => {
      const message = event.data;
      if (message.type === 'ready' || message.type === 'fatal') return;

      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);

      if (message.type === 'error') {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message);
      }
    };
  }

  private async request(
    type: 'eval' | 'complete',
    payload: Record<string, unknown>
  ): Promise<any> {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...payload });
    });
  }

  async kernelInfoRequest(): Promise<KernelMessage.IInfoReplyMsg['content']> {
    return {
      implementation: 'BasedPL',
      implementation_version: '0.1.24',
      language_info: {
        codemirror_mode: { name: 'apl' },
        file_extension: '.bpl',
        mimetype: 'text/x-apl',
        name: 'basedpl',
        pygments_lexer: 'apl',
        version: '0.1.24'
      },
      protocol_version: '5.3',
      status: 'ok',
      banner: 'BasedPL APL kernel running in JupyterLite',
      help_links: [
        {
          text: 'BasedPL',
          url: 'https://answerdotai.github.io/basedpl/'
        }
      ]
    };
  }

  async executeRequest(
    content: KernelMessage.IExecuteRequestMsg['content']
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    let response: { result: BplResult };

    try {
      response = await this.request('eval', { code: content.code });
    } catch (error) {
      const message = String(error);
      this.publishExecuteError({
        ename: 'BasedPLKernelError',
        evalue: message,
        traceback: [message]
      });
      return {
        status: 'error',
        execution_count: this.executionCount,
        ename: 'BasedPLKernelError',
        evalue: message,
        traceback: [message]
      };
    }

    const result = response.result;

    if (!content.silent) {
      for (const event of result.events ?? []) {
        const data: KernelMessage.IMimeBundle = {};
        for (const [key, value] of Object.entries(event.data ?? {})) {
          if (typeof value === 'string') data[key] = value;
        }
        const text = typeof data['text/plain'] === 'string'
          ? data['text/plain']
          : '';

        if (event.kind === 'display') {
          this.publishExecuteResult({
            execution_count: this.executionCount,
            data,
            metadata: {}
          });
        } else if (text) {
          // BaseKernel in JupyterLite 0.7 does not expose publishStream.
          // Publish textual output as a normal notebook result.
          this.publishExecuteResult({
            execution_count: this.executionCount,
            data: { 'text/plain': text },
            metadata: {}
          });
        }
      }
    }

    if (result.error) {
      this.publishExecuteError({
        ename: 'BasedPLError',
        evalue: result.error,
        traceback: [result.error]
      });
      return {
        status: 'error',
        execution_count: this.executionCount,
        ename: 'BasedPLError',
        evalue: result.error,
        traceback: [result.error]
      };
    }

    return {
      status: 'ok',
      execution_count: this.executionCount,
      user_expressions: {}
    };
  }

  async completeRequest(
    content: KernelMessage.ICompleteRequestMsg['content']
  ): Promise<KernelMessage.ICompleteReplyMsg['content']> {
    const beforeCursor = content.code.slice(0, content.cursor_pos);
    const match = beforeCursor.match(/[A-Za-z_][A-Za-z0-9_]*$/);
    const prefix = match?.[0] ?? beforeCursor;
    const cursorStart = match
      ? content.cursor_pos - prefix.length
      : content.cursor_pos;

    const response = await this.request('complete', { prefix });
    const matches = Array.isArray(response.matches)
      ? response.matches.map((item: unknown) => String(item))
      : [];

    return {
      status: 'ok',
      matches,
      cursor_start: cursorStart,
      cursor_end: content.cursor_pos,
      metadata: {}
    };
  }

  async inspectRequest(): Promise<KernelMessage.IInspectReplyMsg['content']> {
    return { status: 'ok', found: false, data: {}, metadata: {} };
  }

  async isCompleteRequest(): Promise<KernelMessage.IIsCompleteReplyMsg['content']> {
    return { status: 'complete' };
  }

  async commInfoRequest(): Promise<KernelMessage.ICommInfoReplyMsg['content']> {
    return { status: 'ok', comms: {} };
  }

  inputReply(_content: KernelMessage.IInputReplyMsg['content']): void {
    // BasedPL does not currently request stdin.
  }

  async commOpen(_msg: KernelMessage.ICommOpenMsg): Promise<void> {
    // No comm targets.
  }

  async commMsg(_msg: KernelMessage.ICommMsgMsg): Promise<void> {
    // No comm targets.
  }

  async commClose(_msg: KernelMessage.ICommCloseMsg): Promise<void> {
    // No comm targets.
  }

  dispose(): void {
    this.pending.forEach(({ reject }) =>
      reject(new Error('BasedPL kernel disposed'))
    );
    this.pending.clear();
    this.worker.terminate();
    super.dispose();
  }
}
