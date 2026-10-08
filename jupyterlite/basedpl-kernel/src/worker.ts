import init, { BplSession, configure, symbols } from './basedpl_web.js';

type Request =
  | { id: number; type: 'eval'; code: string }
  | { id: number; type: 'complete'; prefix: string; glyphs?: boolean }
  | { id: number; type: 'symbols' };

type ConfigureMessage = { type: 'configure'; base: string };

let session: BplSession | null = null;
// `configure()` (the wasm export) can't be called before `init()` resolves,
// but kernel.ts sends the "configure" message as soon as the worker is
// constructed -- which can race ahead of `init()` finishing. Buffer it if
// so, and apply it right after `init()` resolves instead.
let wasmReady = false;
let pendingBase: string | null = null;

async function start(): Promise<void> {
  await init();
  wasmReady = true;
  if (pendingBase !== null) configure(pendingBase);
  session = new BplSession();
  self.postMessage({ type: 'ready' });
}

start().catch(error => {
  self.postMessage({ type: 'fatal', error: String(error) });
});

self.onmessage = event => {
  const request = event.data as Request | ConfigureMessage;
  if (request.type === 'configure') {
    if (wasmReady) configure(request.base);
    else pendingBase = request.base;
    return;
  }
  if (!session) {
    self.postMessage({ id: request.id, type: 'error', error: 'BasedPL WASM is not ready' });
    return;
  }

  try {
    if (request.type === 'symbols') {
      // Called once per kernel start, not per keystroke -- the real glyph
      // table, fed to the vendored `input.js` engine on the frontend. See
      // jupyterlite/README.md.
      self.postMessage({ id: request.id, type: 'result', result: JSON.parse(symbols()) });
    } else if (request.type === 'eval') {
      self.postMessage({
        id: request.id,
        type: 'result',
        result: JSON.parse(session.eval(request.code))
      });
    } else if (request.type === 'complete') {
      self.postMessage({
        id: request.id,
        type: 'complete',
        matches: request.glyphs
          ? session.complete_glyphs(request.prefix)
          : session.complete(request.prefix)
      });
    }
  } catch (error) {
    self.postMessage({ id: request.id, type: 'error', error: String(error) });
  }
};
