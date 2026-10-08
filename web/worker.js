import init, { BplSession, symbols } from './basedpl_web.js';

let session;

async function start() {
  await init();
  session = new BplSession();
  // Called once, not per keystroke: the real glyph table (name/monad/dyad/
  // aliases/shortcut), fed to the vendored `input.js` engine on the main
  // thread. See jupyterlite/README.md for why this isn't a per-keystroke call.
  postMessage({ type: 'ready', symbols: JSON.parse(symbols()) });
}

start().catch(error => postMessage({ type: 'fatal', error: String(error) }));

self.onmessage = event => {
  if (!session) return;
  if (event.data?.type === 'eval') {
    try {
      const raw = session.eval(event.data.code || '');
      const data = JSON.parse(raw);
      postMessage({
        type: 'result',
        code: event.data.code || '',
        output: data.output || '',
        value: data.value == null ? '' : String(data.value),
        events: Array.isArray(data.events) ? data.events : [],
        error: data.error || ''
      });
    } catch (error) {
      postMessage({
        type: 'result',
        code: event.data.code || '',
        output: '',
        value: '',
        events: [],
        error: String(error)
      });
    }
  }
};
