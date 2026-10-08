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
  if (!modelContext) return null;

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



  return async () => {
    controller.abort();
    await session.close();
  };
}
