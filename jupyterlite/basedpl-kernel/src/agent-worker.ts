import init, { BplSession, configure, symbols } from './basedpl_web.js';

type InitRequest = {
  type: 'init';
  requestId: string;
  generation: number;
  filesBase: string;
};

type EvalRequest = {
  type: 'eval';
  requestId: string;
  generation: number;
  code: string;
};

type SymbolsRequest = {
  type: 'symbols';
  requestId: string;
  generation: number;
};

type ShutdownRequest = {
  type: 'shutdown';
  requestId: string;
  generation: number;
};

type Request = InitRequest | EvalRequest | SymbolsRequest | ShutdownRequest;

type EvalPayload = {
  output: string;
  value: string | null;
  events: unknown[];
  error: string | null;
};

const MAX_OUTPUT_CHARS = 16_384;
const MAX_EVENTS = 100;

let wasmReady: Promise<void> | null = null;
let session: BplSession | null = null;
let initialized = false;

function startWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = init().then(() => undefined);
  }
  return wasmReady;
}

function truncateText(value: string, max: number): {
  value: string;
  truncated: boolean;
} {
  if (value.length <= max) return { value, truncated: false };
  return {
    value: value.slice(0, max),
    truncated: true
  };
}

async function handle(request: Request): Promise<void> {
  if (request.type === 'shutdown') {
    self.postMessage({
      type: 'shutdown',
      requestId: request.requestId,
      generation: request.generation
    });
    self.close();
    return;
  }

  if (request.type === 'init') {
    try {
      await startWasm();
      configure(request.filesBase);
      session = new BplSession();
      initialized = true;

      self.postMessage({
        type: 'ready',
        requestId: request.requestId,
        generation: request.generation,
        runtime: {
          name: 'BasedPL',
          version: '0.1.31'
        },
        capabilities: {
          eval: true,
          fileRead: true,
          fileWrite: false,
          network: false
        }
      });
    } catch (error) {
      self.postMessage({
        type: 'fatal',
        requestId: request.requestId,
        generation: request.generation,
        error: {
          code: 'WASM_INIT_FAILED',
          message: String(error)
        }
      });
    }
    return;
  }

  if (request.type === 'symbols') {
    if (!initialized || !session) {
      self.postMessage({
        type: 'error',
        requestId: request.requestId,
        generation: request.generation,
        error: {
          code: 'NOT_READY',
          message: 'BasedPL agent worker is not initialized'
        }
      });
      return;
    }

    self.postMessage({
      type: 'symbols',
      requestId: request.requestId,
      generation: request.generation,
      symbols: JSON.parse(symbols())
    });
    return;
  }

  if (!initialized || !session) {
    self.postMessage({
      type: 'error',
      requestId: request.requestId,
      generation: request.generation,
      error: {
        code: 'NOT_READY',
        message: 'BasedPL agent worker is not initialized'
      }
    });
    return;
  }

  const started = performance.now();

  try {
    const raw = JSON.parse(session.eval(request.code)) as EvalPayload;
    const output = truncateText(raw.output || '', MAX_OUTPUT_CHARS);
    const events = Array.isArray(raw.events)
      ? raw.events.slice(0, MAX_EVENTS)
      : [];

    self.postMessage({
      type: 'result',
      requestId: request.requestId,
      generation: request.generation,
      result: {
        kind: raw.value == null ? 'null' : 'apl-text',
        text: raw.value == null ? null : raw.value,
        output: output.value,
        events,
        truncated: output.truncated || (raw.events?.length ?? 0) > MAX_EVENTS,
        error: raw.error
      },
      meta: {
        durationMs: Math.round(performance.now() - started),
        stateChanged: true
      }
    });
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId: request.requestId,
      generation: request.generation,
      error: {
        code: 'EVAL_ERROR',
        message: String(error)
      }
    });
  }
}

self.onmessage = event => {
  void handle(event.data as Request);
};

void startWasm().catch(() => {
  // The init request reports the actionable error to the parent. Keeping the
  // initial promise lazy also lets the worker load without an implicit session.
});
