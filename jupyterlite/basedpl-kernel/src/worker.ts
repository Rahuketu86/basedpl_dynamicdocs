import init, { BplSession } from './basedpl_web.js';

type Request =
  | { id: number; type: 'eval'; code: string }
  | { id: number; type: 'complete'; prefix: string; glyphs?: boolean };

let session: BplSession | null = null;

async function start(): Promise<void> {
  await init();
  session = new BplSession();
  self.postMessage({ type: 'ready' });
}

start().catch(error => {
  self.postMessage({ type: 'fatal', error: String(error) });
});

self.onmessage = event => {
  const request = event.data as Request;
  if (!session) {
    self.postMessage({ id: request.id, type: 'error', error: 'BasedPL WASM is not ready' });
    return;
  }

  try {
    if (request.type === 'eval') {
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
