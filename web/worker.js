import init, { BplSession, symbols } from './basedpl_web.js';

let session;
let executionCount = 0;

const makeHeader = (msgType, parent) => ({
  msg_id: crypto.randomUUID(),
  msg_type: msgType,
  session: parent?.session || 'basedpl-root',
  username: parent?.username || 'basedpl',
  version: '5.3'
});

const publishJupyter = (msgType, parent, content) => {
  postMessage({
    channel: 'iopub',
    header: makeHeader(msgType, parent),
    parent_header: parent || {},
    metadata: {},
    content
  });
};

const publishJupyterError = (parent, message) => {
  publishJupyter('error', parent, {
    ename: 'BasedPLError',
    evalue: message,
    traceback: [message]
  });
};

const publishBasedPLEvents = (parent, events) => {
  for (const event of events || []) {
    const data = {};
    for (const [key, value] of Object.entries(event?.data || {})) {
      if (typeof value === 'string') data[key] = value;
    }

    const text = typeof data['text/plain'] === 'string' ? data['text/plain'] : '';

    if (event?.kind === 'display') {
      publishJupyter('display_data', parent, { data, metadata: {} });
    } else if (text) {
      // Match the BasedPL JupyterLite kernel semantics: textual events are
      // represented as execute_result messages rather than a custom stream.
      publishJupyter('execute_result', parent, {
        execution_count: executionCount,
        data: { 'text/plain': text },
        metadata: {}
      });
    }
  }
};

const handleJupyter = request => {
  if (!session) return;

  const msgType = request?.header?.msg_type;
  if (msgType === 'kernel_info_request') {
    postMessage({
      channel: 'shell',
      header: makeHeader('kernel_info_reply', request.header),
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
        banner: 'BasedPL root page kernel'
      }
    });
    return;
  }

  if (msgType !== 'execute_request') return;

  const content = request.content || {};
  if (content.store_history !== false) executionCount += 1;

  publishJupyter('status', request.header, { execution_state: 'busy' });

  try {
    const result = JSON.parse(session.eval(String(content.code || '')));
    if (!content.silent) publishBasedPLEvents(request.header, result.events);

    if (result.error) {
      publishJupyterError(request.header, result.error);
      postMessage({
        channel: 'shell',
        header: makeHeader('execute_reply', request.header),
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
      postMessage({
        channel: 'shell',
        header: makeHeader('execute_reply', request.header),
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
    publishJupyterError(request.header, message);
    postMessage({
      channel: 'shell',
      header: makeHeader('execute_reply', request.header),
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
  } finally {
    publishJupyter('status', request.header, { execution_state: 'idle' });
  }
};

async function start() {
  await init();
  session = new BplSession();
  postMessage({ type: 'ready', symbols: JSON.parse(symbols()) });
}

start().catch(error => postMessage({ type: 'fatal', error: String(error) }));

self.onmessage = event => {
  const data = event.data;

  if (data?.type === 'reset') {
    try {
      session = new BplSession();
      executionCount = 0;
      postMessage({ type: 'reset', ok: true });
    } catch (error) {
      postMessage({ type: 'reset', ok: false, error: String(error) });
    }
    return;
  }

  if (data?.channel === 'shell' && data?.header?.msg_type) {
    handleJupyter(data);
    return;
  }

  if (!session) return;

  // Existing REPL compatibility protocol. Keep this intact so the deployed
  // website's current keyboard/completion UI remains unaffected.
  if (data?.type === 'eval') {
    try {
      const raw = session.eval(data.code || '');
      const result = JSON.parse(raw);
      postMessage({
        type: 'result',
        code: data.code || '',
        output: result.output || '',
        value: result.value == null ? '' : String(result.value),
        events: Array.isArray(result.events) ? result.events : [],
        error: result.error || ''
      });
    } catch (error) {
      postMessage({
        type: 'result',
        code: data.code || '',
        output: '',
        value: '',
        events: [],
        error: String(error)
      });
    }
  }
};
