import init, { BplSession, configure } from './basedpl_web.js';

type ExecuteRequest = {
  channel: 'shell';
  header: {
    msg_id: string;
    msg_type: 'execute_request';
    session: string;
    username: string;
    version: '5.3';
  };
  parent_header: Record<string, unknown>;
  metadata: Record<string, unknown>;
  content: {
    code: string;
    silent?: boolean;
    store_history?: boolean;
    user_expressions?: Record<string, string>;
    allow_stdin?: boolean;
    stop_on_error?: boolean;
  };
};

type KernelRequest = ExecuteRequest | {
  channel: 'shell';
  header: {
    msg_id: string;
    msg_type: 'kernel_info_request';
    session: string;
    username: string;
    version: '5.3';
  };
  parent_header: Record<string, unknown>;
  metadata: Record<string, unknown>;
  content: Record<string, never>;
};

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

let session: BplSession | null = null;
let executionCount = 0;
let wasmReady = false;
let pendingBase: string | null = null;

async function start(): Promise<void> {
  await init();
  wasmReady = true;
  if (pendingBase !== null) configure(pendingBase);
  session = new BplSession();

  self.postMessage({
    channel: 'iopub',
    header: {
      msg_id: crypto.randomUUID(),
      msg_type: 'status',
      session: 'basedpl-agent-kernel',
      username: 'agent',
      version: '5.3'
    },
    parent_header: {},
    metadata: {},
    content: { execution_state: 'idle' }
  });
}

function header(msgType: string, parent: ExecuteRequest['header']) {
  return {
    msg_id: crypto.randomUUID(),
    msg_type: msgType,
    session: parent.session,
    username: 'agent',
    version: '5.3'
  };
}

function publish(
  msgType: string,
  parent: ExecuteRequest['header'],
  content: Record<string, unknown>
): void {
  self.postMessage({
    channel: 'iopub',
    header: header(msgType, parent),
    parent_header: parent,
    metadata: {},
    content
  });
}

function publishError(parent: ExecuteRequest['header'], message: string): void {
  publish('error', parent, {
    ename: 'BasedPLError',
    evalue: message,
    traceback: [message]
  });
}

function publishEvent(parent: ExecuteRequest['header'], event: BplEvent): void {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.data ?? {})) {
    if (typeof value === 'string') data[key] = value;
  }

  const text = typeof data['text/plain'] === 'string'
    ? data['text/plain']
    : '';

  if (event.kind === 'display') {
    publish('display_data', parent, {
      data,
      metadata: {}
    });
  } else if (text) {
    publish('stream', parent, {
      name: 'stdout',
      text
    });
  }
}

function execute(request: ExecuteRequest): void {
  if (!session) {
    publishError(request.header, 'BasedPL WASM is not ready');
    return;
  }

  const content = request.content;
  const storeHistory = content.store_history !== false;

  if (storeHistory) executionCount += 1;

  publish('status', request.header, { execution_state: 'busy' });

  try {
    const result = JSON.parse(session.eval(content.code)) as BplResult;

    if (!content.silent) {
      for (const event of result.events ?? []) {
        publishEvent(request.header, event);
      }

      // Some BasedPL evaluations expose a value without a display event.
      // Preserve that value using the standard Jupyter execute_result MIME
      // bundle rather than inventing a new result protocol.
      if (result.value !== null && !(result.events ?? []).some(
        event => event.kind === 'display'
      )) {
        publish('execute_result', request.header, {
          execution_count: executionCount,
          data: { 'text/plain': result.value },
          metadata: {}
        });
      }

      if (result.output) {
        publish('stream', request.header, {
          name: 'stdout',
          text: result.output
        });
      }
    }

    if (result.error) {
      publishError(request.header, result.error);

      self.postMessage({
        channel: 'shell',
        header: header('execute_reply', request.header),
        parent_header: request.header,
        metadata: {},
        content: {
          status: 'error',
          execution_count: executionCount,
          ename: 'BasedPLError',
          evalue: result.error,
          traceback: [result.error]
        }
      });
    } else {
      self.postMessage({
        channel: 'shell',
        header: header('execute_reply', request.header),
        parent_header: request.header,
        metadata: {},
        content: {
          status: 'ok',
          execution_count: executionCount,
          user_expressions: {}
        }
      });
    }
  } catch (error) {
    const message = String(error);
    publishError(request.header, message);

    self.postMessage({
      channel: 'shell',
      header: header('execute_reply', request.header),
      parent_header: request.header,
      metadata: {},
      content: {
        status: 'error',
        execution_count: executionCount,
        ename: 'BasedPLKernelError',
        evalue: message,
        traceback: [message]
      }
    });
  }

  publish('status', request.header, { execution_state: 'idle' });
}

self.onmessage = event => {
  const request = event.data as KernelRequest;

  if (request.header?.msg_type === 'kernel_info_request') {
    self.postMessage({
      channel: 'shell',
      header: header('kernel_info_reply', request.header),
      parent_header: request.header,
      metadata: {},
      content: {
        protocol_version: '5.3',
        implementation: 'BasedPL',
        implementation_version: '0.1.31',
        language_info: {
          codemirror_mode: { name: 'apl' },
          file_extension: '.bpl',
          mimetype: 'text/x-apl',
          name: 'basedpl',
          pygments_lexer: 'apl',
          version: '0.1.31'
        },
        banner: 'BasedPL agent kernel running in JupyterLite'
      }
    });
    return;
  }

  if (request.header?.msg_type === 'execute_request') {
    execute(request);
  }
};

start().catch(error => {
  self.postMessage({
    channel: 'iopub',
    header: {
      msg_id: crypto.randomUUID(),
      msg_type: 'error',
      session: 'basedpl-agent-kernel',
      username: 'agent',
      version: '5.3'
    },
    parent_header: {},
    metadata: {},
    content: {
      ename: 'WASMInitError',
      evalue: String(error),
      traceback: [String(error)]
    }
  });
});
