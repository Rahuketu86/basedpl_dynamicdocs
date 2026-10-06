import init, { BplSession } from './basedpl_web.js';

let session;

async function start() {
  await init();
  session = new BplSession();
  postMessage({ type: 'ready' });
}
start().catch(error => postMessage({ type: 'fatal', error: String(error) }));

self.onmessage = event => {
  if (!session) return;
  if (event.data?.type === 'eval') {
    try {
      const result = session.eval(event.data.code || '');
      const data = result ? result : {};
      postMessage({
        type: 'result',
        code: event.data.code || '',
        output: data.output || '',
        error: data.error || ''
      });
    } catch (error) {
      postMessage({ type: 'result', code: event.data.code || '', error: String(error), output: '' });
    }
  }
};
