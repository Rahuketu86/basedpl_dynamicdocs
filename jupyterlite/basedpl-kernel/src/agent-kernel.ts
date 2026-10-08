import init, { BplSession, configure } from './basedpl_web.js';

type JupyterHeader = {
  msg_id: string;
  msg_type: string;
  session: string;
  username: string;
  version: string;
};

type JupyterMessage = {
  channel: 'shell' | 'iopub' | 'stdin' | 'control';
  header: JupyterHeader;
  parent_header: Record<string, unknown>;
  metadata: Record<string, unknown>;
  content: Record<string, unknown>;
};

type ExecuteRequest = JupyterMessage & {
  channel: 'shell';
  header: JupyterHeader & { msg_type: 'execute_request' };
  content: {
    code: string;
    silent?: boolean;
    store_history?: boolean;
    user_expressions?: Record<string, string>;
    allow_stdin?: boolean;
    stop_on_error?: boolean;
  };
};

type KernelRequest = JupyterMessage;

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
const pendingRequests: KernelRequest[] = [];

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

function header(msgType: string, parent: JupyterHeader) {
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
  parent: JupyterHeader,
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

function publishError(parent: JupyterHeader, message: string): void {
  publish('error', parent, {
    ename: 'BasedPLError',
    evalue: message,
    traceback: [message]
  });
}

function publishEvent(parent: JupyterHeader, event: BplEvent): void {
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
    // Match the existing BasedPLKernel behavior: BaseKernel does not expose
    // publishStream, so textual event output is represented as a Jupyter
    // execute_result message.
    publish('execute_result', parent, {
      execution_count: executionCount,
      data: { 'text/plain': text },
      metadata: {}
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

function handle(request: KernelRequest): void {
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
}

self.onmessage = event => {
  const request = event.data as KernelRequest;
  if (!session) {
    pendingRequests.push(request);
    return;
  }
  handle(request);
};

start().then(() => {
  const queued = pendingRequests.splice(0);
  for (const request of queued) handle(request);
}).catch(error => {
  const message = String(error);
  for (const request of pendingRequests.splice(0)) {
    if (request.header.msg_type === 'execute_request') {
      self.postMessage({
        channel: 'shell',
        header: header('execute_reply', request.header),
        parent_header: request.header,
        metadata: {},
        content: {
          status: 'error',
          execution_count: executionCount,
          ename: 'WASMInitError',
          evalue: message,
          traceback: [message]
        }
      });
    }
  }

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
      evalue: message,
      traceback: [message]
    }
  });
});
