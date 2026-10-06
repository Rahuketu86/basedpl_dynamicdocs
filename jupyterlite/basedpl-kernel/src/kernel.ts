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

type BplSession = {
  eval(code: string): string;
  complete(prefix: string): unknown;
};

let bplModule: Promise<any> | undefined;

async function loadBpl(): Promise<any> {
  if (!bplModule) {
    bplModule = import('./basedpl_web.js');
  }
  return bplModule;
}

export class BasedPLKernel extends BaseKernel {
  private session: BplSession | null = null;

  private async getSession(): Promise<BplSession> {
    if (!this.session) {
      const mod = await loadBpl();
      this.session = new mod.BplSession();
    }
    return this.session;
  }

  async kernelInfoRequest(): Promise<KernelMessage.IInfoReplyMsg['content']> {
    return {
      implementation: 'BasedPL',
      implementation_version: '0.1.24',
      language_info: {
        codemirror_mode: 'apl',
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
    const session = await this.getSession();
    const result: BplResult = JSON.parse(session.eval(content.code));

    if (!content.silent) {
      for (const event of result.events ?? []) {
        const data = event.data ?? {};
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
          this.publishStream({ name: 'stdout', text });
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
    const session = await this.getSession();
    const beforeCursor = content.code.slice(0, content.cursor_pos);
    const match = beforeCursor.match(/[A-Za-z_][A-Za-z0-9_]*$/);
    const prefix = match?.[0] ?? beforeCursor;
    const cursorStart = match
      ? content.cursor_pos - prefix.length
      : content.cursor_pos;

    const raw = session.complete(prefix);
    const matches = Array.isArray(raw)
      ? raw.map(item => String(item))
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

  inputReply(content: KernelMessage.IInputReplyMsg['content']): void {
    super.inputReply(content);
  }

  dispose(): void {
    this.session = null;
    super.dispose();
  }
}
