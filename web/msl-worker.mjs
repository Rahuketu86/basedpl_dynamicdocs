// BasedPL as a memexsolvelite language: a Web Worker speaking memexsolvelite's `msl-lang/1` protocol
// (github.com/Rahuketu86/memexsolvelite, PROTOCOL.md). memexsolvelite pins this file by its fingerprint and runs it from
// a blob, so it is self-contained: it finds its files through `init.base`, and it pins them in turn. build.py fills in
// the fingerprints of the wasm-bindgen glue and the wasm below, and publishes this file at `msl/v<version>/` with both.
// The JupyterLite kernel in jupyterlite/basedpl-kernel and the REPL (web/worker.js) are separate and unchanged.
const VERSION = '__BPL_VERSION__';
const GLUE = { file: 'basedpl_web.js', integrity: '__GLUE_INTEGRITY__' };
const WASM = { file: 'basedpl_web_bg.wasm', integrity: '__WASM_INTEGRITY__' };

let session = null, ready = null, base = null, interrupt = null;
const post = m => self.postMessage(m);

async function sha256(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let s = '';
  for (const b of d) s += String.fromCharCode(b);
  return 'sha256-' + btoa(s);
}

/** Fetch one of this version's files and check it against its pinned fingerprint. */
async function fetchPinned({ file, integrity }) {
  const url = new URL(file, base).href;
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`couldn't load ${url}: HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  const got = await sha256(bytes);
  if (got !== integrity) throw new Error(`${url} does not match this worker (fingerprint ${got}, expected ${integrity})`);
  return bytes;
}

async function start() {
  const [glue, wasm] = await Promise.all([fetchPinned(GLUE), fetchPinned(WASM)]);
  const glueUrl = URL.createObjectURL(new Blob([glue], { type: 'text/javascript' }));
  const mod = await import(glueUrl);
  URL.revokeObjectURL(glueUrl);
  await mod.default({ module_or_path: wasm });
  mod.configure(base);              // relative paths in •nget / •nput / •load resolve against the files' folder
  mod.set_interrupt(interrupt);     // null when the page isn't cross-origin isolated: then memexsolvelite restarts the worker
  session = new mod.BplSession();
}

const INFO = {
  implementation: 'basedpl', implementation_version: VERSION,
  banner: `BasedPL ${VERSION} (WebAssembly, msl-lang/1)`,
  help_links: [{ text: 'BasedPL docs', url: 'https://answerdotai.github.io/basedpl/' }],
  language_info: { name: 'basedpl', version: VERSION, mimetype: 'text/x-basedpl', file_extension: '.bpl', codemirror_mode: 'apl' }
};

/** Mirror jupyterlite/basedpl-kernel: `display` events are results (the last one is the cell's value, earlier ones are
 * displays); other textual events are output, here as stdout (msl-lang/1 has streams). */
function execute(id, code, quiet) {
  if (interrupt) Atomics.store(interrupt, 0, 0);   // the protocol: a worker clears the flag when it starts the next execute
  const r = JSON.parse(session.eval(code));
  const shown = [];
  for (const event of r.events ?? []) {
    const data = {};
    for (const [k, v] of Object.entries(event?.data ?? {})) if (typeof v === 'string') data[k] = v;
    if (event?.kind === 'display') shown.push(data);
    else if (data['text/plain']) post({ id, event: 'stream', name: 'stdout', text: data['text/plain'].endsWith('\n') ? data['text/plain'] : data['text/plain'] + '\n' });
  }
  const result = shown.length && !quiet ? shown.pop() : null;
  for (const data of shown) post({ id, event: 'display', display: { data, metadata: {} } });
  const interrupted = r.error && interrupt && Atomics.load(interrupt, 0) === 1;
  const error = interrupted ? { ename: 'KeyboardInterrupt', evalue: '', traceback: ['KeyboardInterrupt'] }
    : r.error ? { ename: 'BasedPLError', evalue: r.error, traceback: [r.error] } : null;
  return { result: error ? null : result, error };
}

/** Same rules as the JupyterLite kernel: a backtick before a name completes glyphs by name, otherwise names. */
function complete(code, pos) {
  const before = code.slice(0, pos);
  const glyph = before.match(/`([A-Za-z_][A-Za-z0-9_]*)?$/);
  const word = before.match(/[A-Za-z_][A-Za-z0-9_]*$/);
  if (glyph) {
    const prefix = glyph[1] ?? '';
    return { matches: [...session.complete_glyphs(prefix)].map(String), cursor_start: pos - prefix.length - 1, cursor_end: pos };
  }
  const prefix = word ? word[0] : '';
  return { matches: [...session.complete(prefix)].map(String), cursor_start: pos - prefix.length, cursor_end: pos };
}

self.onmessage = async ev => {
  const m = ev.data;
  if (m.op === 'init') {
    base = m.base;
    interrupt = m.interrupt ? new Int32Array(m.interrupt) : null;
    ready = start();
    try { await ready; post({ event: 'ready', protocol: 'msl-lang/1', info: INFO }); }
    catch (e) { ready = null; post({ event: 'ready', protocol: 'msl-lang/1', info: { ...INFO, banner: `BasedPL failed to load: ${e?.message ?? e}` } }); }
    return;
  }
  if (m.op === 'interrupt') return;     // the flag in the shared buffer stops a running eval; this message has nothing to add
  const { id, op, args } = m;
  const fail = (ename, evalue) => post({ id, failure: { ename, evalue, traceback: [] } });
  if (!session) return fail('Unavailable', 'BasedPL did not load (see the kernel banner)');
  try {
    if (op === 'execute') return post({ id, reply: execute(id, args.code, args.quiet || args.silent) });
    if (op === 'complete') return post({ id, reply: complete(args.code, args.cursor_pos ?? args.code.length) });
    if (op === 'is_complete') return post({ id, reply: { status: 'unknown' } });
    if (op === 'evaluate') {
      const out = {};
      for (const [k, expr] of Object.entries(args ?? {})) {
        const r = JSON.parse(session.eval(String(expr)));
        const last = (r.events ?? []).filter(e => e?.kind === 'display').pop();
        out[k] = r.error ? { status: 'error', ename: 'BasedPLError', evalue: r.error, traceback: [r.error] }
          : { status: 'ok', data: { 'text/plain': String(last?.data?.['text/plain'] ?? r.value ?? '') }, metadata: {} };
      }
      return post({ id, reply: out });
    }
    if (op === 'hosts' || op === 'host_settle' || op === 'shutdown') return post({ id, reply: null });
    return fail('NotImplementedError', `BasedPL has no ${op}`);
  } catch (e) { fail('BasedPLKernelError', String(e?.message ?? e)); }
};
