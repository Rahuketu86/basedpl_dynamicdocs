// Browser check of BasedPL as a memexsolvelite language (web/msl-worker.mjs, published by build.py at msl/v<version>/).
// It loads the worker the way memexsolvelite's src/minikernel/remote-language.ts does: fetch it, check its fingerprint
// against the entry, run the checked bytes from a blob: module worker, send `init` with `base`. The test page is served
// cross-origin isolated (as memexsolvelite is), so the interrupt buffer exists. Run it against a local build or a site:
//   BASE_URL=http://127.0.0.1:8899/ node tests/e2e/msl-worker.mjs
import { chromium } from 'playwright';

const baseUrl = process.env.BASE_URL || 'https://rahuketu86.github.io/basedpl_dynamicdocs/';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

try {
  // A blank page on the site's origin, with the headers that make it cross-origin isolated.
  const testUrl = new URL('msl-worker-test.html', baseUrl).href;
  await page.route(testUrl, route => route.fulfill({
    status: 200, contentType: 'text/html',
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    body: '<!doctype html><title>msl worker test</title>'
  }));
  await page.goto(testUrl);
  check('test page is cross-origin isolated (so the interrupt buffer exists)', await page.evaluate(() => crossOriginIsolated));

  const index = await (await fetch(new URL('msl/index.json', baseUrl))).json();
  const entry = index.entry;
  // The entry names the production site; load the same path from the site under test.
  const workerUrl = new URL(`msl/${index.path}msl-worker.mjs`, baseUrl).href;
  check('the entry points at basedpl.rahulsaraf.online', entry.worker_url === `https://basedpl.rahulsaraf.online/msl/${index.path}msl-worker.mjs`, entry.worker_url);

  const results = await page.evaluate(async ({ workerUrl, integrity }) => {
    const out = {};
    const bytes = await (await fetch(workerUrl, { mode: 'cors', credentials: 'omit', cache: 'no-cache' })).arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    out.fingerprint = 'sha256-' + btoa(String.fromCharCode(...digest));
    out.integrity = integrity;
    const worker = new Worker(URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' })), { type: 'module' });
    const interrupt = new SharedArrayBuffer(4);
    const flag = new Int32Array(interrupt);
    let nextId = 1;
    const pending = new Map(), events = new Map();
    let readyResolve;
    const ready = new Promise(r => { readyResolve = r; });
    worker.onmessage = ({ data }) => {
      if (data.event === 'ready') return readyResolve(data);
      if (data.event) return (events.get(data.id) ?? events.set(data.id, []).get(data.id)).push(data);
      pending.get(data.id)?.(data);
    };
    const request = (op, args) => new Promise(resolve => {
      const id = nextId++;
      pending.set(id, msg => resolve({ ...msg, events: events.get(id) ?? [] }));
      worker.postMessage({ id, op, args });
    });
    worker.postMessage({ op: 'init', protocol: 'msl-lang/1', interrupt, stdin: null, base: new URL('.', workerUrl).href });
    out.ready = await ready;
    out.iota = await request('execute', { code: '⍳5' });
    out.assign = await request('execute', { code: 'x←5' });
    out.state = await request('execute', { code: 'x+1' });
    out.output = await request('execute', { code: '⎕←"hi"\n2+3' });
    out.error = await request('execute', { code: 'undefinedname+1' });
    out.complete = await request('complete', { code: '`om', cursor_pos: 3 });
    // A loop that never ends on its own: interrupt it after 300 ms, as memexsolvelite does.
    const started = performance.now();
    const running = request('execute', { code: '{⍵+1}⍣≡0' });
    setTimeout(() => { Atomics.store(flag, 0, 1); worker.postMessage({ op: 'interrupt' }); }, 300);
    out.interrupt = await Promise.race([running, new Promise(r => setTimeout(() => r({ timedOut: true }), 5000))]);
    out.interruptMs = Math.round(performance.now() - started);
    out.after = await request('execute', { code: 'x' });   // the session survives the interrupt
    worker.terminate();
    return out;
  }, { workerUrl, integrity: entry.integrity });

  const text = r => r?.reply?.result?.['text/plain'];
  check("the worker matches the entry's fingerprint", results.fingerprint === results.integrity, `${results.fingerprint} vs ${results.integrity}`);
  check('ready, speaking msl-lang/1, with this BasedPL version', results.ready?.protocol === 'msl-lang/1'
    && results.ready?.info?.implementation_version === index.version && !/failed/.test(results.ready?.info?.banner ?? ''),
    JSON.stringify(results.ready?.info?.banner));
  check('⍳5 gives 0 1 2 3 4', text(results.iota) === '0 1 2 3 4', JSON.stringify(text(results.iota)));
  check('state carries between executes (x←5, then x+1 is 6)', text(results.state) === '6', JSON.stringify(text(results.state)));
  // ⎕← writes the value as BasedPL displays it, so a string keeps its quotes.
  check("explicit output comes as stdout, the value as the result", results.output.events.some(e => e.event === 'stream'
    && e.name === 'stdout' && e.text === '"hi"\n') && text(results.output) === '5', JSON.stringify(results.output));
  check('a BasedPL error comes back as the reply\'s error', results.error?.reply?.error?.ename === 'BasedPLError'
    && results.error.reply.result === null, JSON.stringify(results.error?.reply?.error));
  check('`om completes to ⍵', results.complete?.reply?.matches?.includes('⍵') && results.complete.reply.cursor_start === 0,
    JSON.stringify(results.complete?.reply));
  check('the interrupt flag stops a running loop with KeyboardInterrupt', results.interrupt?.reply?.error?.ename === 'KeyboardInterrupt',
    `${JSON.stringify(results.interrupt?.reply?.error ?? results.interrupt)} after ${results.interruptMs} ms`);
  check('the session survives an interrupt (x is still 5)', text(results.after) === '5', JSON.stringify(text(results.after)));
  check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (error) {
  console.error('E2E ERROR:', error);
  failures++;
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nmemexsolvelite language E2E passed: load, execute, output, errors, completion, interrupt');
process.exit(failures ? 1 : 0);
