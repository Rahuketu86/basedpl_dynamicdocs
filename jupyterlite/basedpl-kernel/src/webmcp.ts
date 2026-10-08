import { AgentSession } from './agent-session.js';

type WebMCPDocument = Document & {
  modelContext?: {
    registerTool(
      tool: {
        name: string;
        title?: string;
        description: string;
        inputSchema: Record<string, unknown>;
        annotations?: Record<string, boolean>;
        execute: (
          input: Record<string, unknown>,
          context: { signal: AbortSignal }
        ) => Promise<unknown> | unknown;
      },
      options?: { signal?: AbortSignal }
    ): Promise<void>;
    getTools?: () => Promise<Array<{ name: string }>>;
  };
};

const EVAL_SCHEMA = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      description: 'BasedPL code to evaluate in the persistent agent session.'
    }
  },
  required: ['code'],
  additionalProperties: false
};

export async function registerBasedPLWebMCP(
  filesBase: string
): Promise<(() => Promise<void>) | null> {
  const modelContext = (document as WebMCPDocument).modelContext;
  const status = document.createElement('div');
  status.id = 'basedpl-webmcp-status';
  status.setAttribute('aria-live', 'polite');
  Object.assign(status.style, {
    position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647',
    maxWidth: '360px', padding: '10px 12px', borderRadius: '8px',
    border: '1px solid #bbb', background: 'rgba(255,255,255,.96)',
    color: '#222', font: '12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif',
    boxShadow: '0 3px 14px rgba(0,0,0,.18)', whiteSpace: 'pre-wrap'
  });
  const setStatus = (message: string, ok = true) => {
    status.textContent = message;
    status.style.borderColor = ok ? '#2e7d32' : '#c62828';
  };
  document.body.appendChild(status);

  const modelContext = (document as WebMCPDocument).modelContext;
  if (!modelContext) {
    setStatus('WebMCP: document.modelContext unavailable', false);
    console.warn('BasedPL WebMCP: document.modelContext unavailable');
    return null;
  }

  setStatus('WebMCP: available\\nRegistering BasedPL tools…');
  console.info('BasedPL WebMCP: document.modelContext available; registering tools');

  const session = new AgentSession(filesBase);
  const controller = new AbortController();

  await modelContext.registerTool(
    {
      name: 'basedpl_eval',
      title: 'Evaluate BasedPL',
      description:
        'Evaluate BasedPL/APL code in a persistent, isolated BasedPL WASM session. ' +
        'The session is separate from the user\'s Jupyter notebook session. ' +
        'It can read the site\'s public example files but cannot write files or access the network.',
      inputSchema: EVAL_SCHEMA,
      annotations: {
        readOnlyHint: false,
        consequentialHint: false,
        untrustedContentHint: true
      },
      execute: async (input, context) => {
        const code = typeof input.code === 'string' ? input.code : '';
        if (!code) throw new Error('INVALID_REQUEST: code is required');

        return await session.eval(code, context.signal);
      }
    },
    { signal: controller.signal }
  );
  console.info('BasedPL WebMCP: registered basedpl_eval');

  await modelContext.registerTool(
    {
      name: 'basedpl_reset',
      title: 'Reset BasedPL Session',
      description:
        'Discard the current persistent BasedPL agent session and create a fresh isolated WASM interpreter.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: false,
        consequentialHint: false,
        untrustedContentHint: false
      },
      execute: async () => {
        await session.reset();
        return {
          status: 'reset',
          message: 'A fresh BasedPL agent session is ready.'
        };
      }
    },
    { signal: controller.signal }
  );
  console.info('BasedPL WebMCP: registered basedpl_reset');

  if (modelContext.getTools) {
    try {
      const tools = await modelContext.getTools();
      const names = tools.map(tool => tool.name);
      console.info('BasedPL WebMCP: visible tools after registration', names);
      setStatus('WebMCP: registered ✓\\n' + names.map(name => '• ' + name).join('\\n'));
    } catch (error) {
      console.warn(
        'BasedPL WebMCP: getTools() verification failed; tools may still be registered',
        error
      );
      setStatus('WebMCP: registered, verification failed\\nCheck console for details.', false);
    }
  } else {
    console.info(
      'BasedPL WebMCP: getTools() unavailable in this browser; registration completed'
    );
    setStatus('WebMCP: registered ✓\\nbasedpl_eval\\nbasedpl_reset\\n(getTools unavailable)');
  }

  return async () => {
    controller.abort();
    await session.close();
  };
}
