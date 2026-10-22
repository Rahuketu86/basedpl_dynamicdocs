# BasedPL APL Reference + Browser REPL

A keyboard-first APL/BasedPL reference site with an embedded browser REPL backed by the real BasedPL Rust interpreter compiled to WebAssembly.

The project does not use Pyodide, a Python implementation of APL, or a JavaScript reimplementation of the interpreter.

## Architecture

    Browser
      ├── Reference tab
      │     ├── glyph keyboard
      │     ├── search/reference
      │     ├── examples
      │     └── notes
      └── REPL tab
            ├── compact BasedPL keyboard
            ├── history/completion
            └── Web Worker
                  └── basedpl_web.wasm
                        └── BasedPL Rust Session

The interpreter runs in a Web Worker so evaluation does not block the UI thread.

## Repository layout

    src/index.html                  Main reference + REPL UI
    web/Cargo.toml                  WASM wrapper crate
    web/src/lib.rs                  wasm-bindgen API around BasedPL Session
    web/worker.js                   Persistent browser worker
    web/vendor/                     Vendored input.js/lb.js/layout.json (see below)
    scripts/prepare_basedpl_wasm.sh Pinned-revision checkout + keyboard/completion engine vendoring
    jupyterlite/                    JupyterLite kernel + extension (see jupyterlite/README.md)
    docker/jupyterlite-build.Dockerfile
                                    Local/remote dev image for fast JupyterLite iteration
    scripts/pipeline.sh             Single-command Docker build + test (wraps the two below)
    scripts/build_and_test_jupyterlite.sh
                                    Build + test the JupyterLite side end-to-end, outside CI
    .github/workflows/pages.yml     Production Pages build + deploy (build+deploy only; no E2E)
    .github/workflows/e2e.yml       Manual-only browser E2E against the deployed site
    .github/workflows/basedpl-wasm-test.yml
                                    PR WASM build/runtime regression tests
    .github/workflows/deploy-cloudflare.yml
                                    Manual: redeploy the latest successful Pages build to Cloudflare
    build.py                        Reference-page generator
    scripts/refresh_reference_glyphs.py
                                    Generates the glyph cards, keyboard and follow-ups from upstream
    scripts/vendor/                 Upstream keyboards.py + US key map + docs page names (vendored by prepare)
    reference-data.json             The same data for the WebMCP agent tools (generated, see below)
    tests/reference-data.mjs        Browser-free checks of that data against upstream
    tests/e2e/reference.mjs         Browser check: Reference tab, REPL and notebook page

## Interpreter integration

The application pins:

    AnswerDotAI/basedpl
    v0.1.64  (6a9f58b620a6cbc0881da72a881e67e682b423b1)

This is an officially tagged, released revision -- the same commit the
`basedpl` npm package ships from -- not an arbitrary commit. Bumping this pin
is a deliberate, separate task: it's a large revision jump each time (the
BasedPL evaluator gets refactored internally fairly often), so treat it as
its own change with its own full regression pass (`scripts/build_and_test_jupyterlite.sh`,
not just the WASM diagnostic smoke test below), not a drive-by edit.

`scripts/prepare_basedpl_wasm.sh` also vendors `python/basedpl/{input.js,
lb.js,layout.json}` from this exact same checkout -- these are upstream's own
real Option-chord keyboard/backtick-completion engine and key layout (the
same one upstream's own WASM-backed playground uses), not a hand-ported
reimplementation. They're pinned to `REV` together with the WASM build and
must never be bumped independently of it: the engine's chord state machine
and the interpreter's actual glyph set have to agree. The real glyph table
itself (name/monad/dyad/aliases/shortcut per glyph) isn't a vendorable file at
all -- it's computed at runtime from the primitive/operator registry -- so
`web/src/lib.rs` exposes it as a `symbols()` wasm export instead, called once
per worker/kernel start (never per keystroke; see jupyterlite/README.md for
why). See `jupyterlite/README.md`'s "Keyboard and completion engine" section
for how the REPL and JupyterLite both consume this.

`web/Cargo.lock` is committed and every build passes `--locked`. Upstream
BasedPL declares open-ended dependency ranges (e.g. `rustymath >=0.1.42, <1`)
and ships no lockfile, so without ours each CI run resolves whatever is newest
that day. That broke the first v0.1.64 deploy: a newer `rustymath` changed the
output of its `facts!` macro, and basedpl's `primitive_facts` macro (which
still expected the old shape) failed to compile with "no rules expected
`comparisons`". The lockfile pins the exact set that was built and tested
(`rustymath 0.1.42`). It is part of the WASM cache key. When you bump the pin
in `scripts/prepare_basedpl_wasm.sh`, regenerate it deliberately (build once
without `--locked`, run the full regression, then commit the new lockfile
alongside the bump) -- `--locked` will make CI fail loudly rather than drift
silently if the two disagree.

Two upstream changes between v0.1.31 and v0.1.64 are worth knowing about when
touching glyph data:

- `⍝` was renamed from `comment` to `lamp`, and its docs page moved
  (`nbs/glyphs/comment.qmd` -> `lamp.qmd`). The Reference tab's hand-written
  `DATA.glyphs` in `src/index.html` carries a `name` and a `slug` per glyph
  (the slug builds the upstream docs link), so both were updated; leaving
  the old slug would have produced a dead documentation link. The live
  keyboard/completion popup is unaffected since it reads names from
  `symbols()` at runtime.
- Each `symbols()` row gained a `hanzi` field: a `[simplified, traditional]`
  pair of Chinese-character spellings for the glyph, where traditional falls
  back to the simplified form when there is no distinct one (so `π` is
  `["周", "周"]`). This is part of upstream's new notation support. Nothing
  in this repo reads it; it is simply present in the JSON now. The glyph
  count (99) and chord shortcuts are unchanged.

The wrapper uses the real Rust API:

- Session::new()
- Session::eval_with()
- Session::show()
- Session::complete()
- basedpl::symbols::{rows, matches, layout} -- the real glyph table and
  chord-engine data, not a hand-curated list (see "Keyboard and completion
  engine" in jupyterlite/README.md)
- basedpl::protocol::output(&Output) -- JSON-encodes one evaluation output
  event (`{"kind": ..., "data": {...}}`, with `MimeData::Bytes` base64-encoded
  the same way Jupyter messages do). This replaced `Output::json()`, which
  the v0.1.31 bump removed outright -- `Output` changed shape from an opaque
  method to public `kind`/`data` fields plus `text()`/`written()`, and the
  JSON-encoding responsibility moved to this free function. Same wire shape,
  just relocated; not a breaking change for anything downstream of `eval()`.

One Session lives inside the worker, so interpreter state persists between REPL evaluations.

The worker protocol is intentionally small:

    main page -- {type:"eval", code:"⍳5"} --> worker
    worker --> BplSession::eval() --> JSON text --> JSON.parse()
    worker <-- {type:"result", output, events, value, error} --

The WASM wrapper deliberately returns the evaluation envelope as JSON text.
This keeps the Node and browser wasm-bindgen targets on the same deterministic
wire format instead of depending on JavaScript object serialization.

The UI also has a compact APL keyboard, command history, completion popup, Enter-to-evaluate, Tab-to-complete, Escape-to-close, and cursor-aware glyph insertion.

Physical Option-key chord typing and backtick-name completion in the REPL run on the same vendored `input.js` engine described in `jupyterlite/README.md`'s "Keyboard and completion engine" section (fed by the `symbols()` wasm export at worker-ready), not a hand-curated glyph list -- one integrated engine, always on, same as the Mac/Bar keyboard.

### REPL value rendering

`BplSession::eval()` returns a JSON envelope containing `output`, `events`,
`error`, and `value`. The Rust `Session::show()` API returns the evaluated
value as display text, while BasedPL's `OutputSink` produces display events.
The Worker parses the envelope and forwards all of it to the page. The browser
UI renders captured output/display events and shows `error` when present.

A deployed browser E2E test in `tests/e2e/repl.mjs` exercises the actual GitHub
Pages URL and verifies visible output for `3`, `2+4`, `⍳5`, and `+/ 1 2 3`.
This (and the JupyterLite/example-notebook E2E tests) run from
`.github/workflows/e2e.yml`, triggered manually from the Actions tab --
deliberately **not** part of the Pages build/deploy workflow. A real-browser
E2E run takes several minutes and has no business gating or blocking a
deploy; it also means a flaky/slow E2E run can no longer make
`deploy-cloudflare.yml`'s "latest successful Pages build" lookup
(which checks the whole `pages.yml` run's status) skip a perfectly good,
already-deployed build.

## Reference, REPL and notebook glyph data (generated from upstream)

The Reference tab's glyph cards, the Mac keyboard shown in the Reference tab, the REPL and the
JupyterLite notebook page, the dead-key follow-ups, and `reference-data.json` (what the WebMCP agent
tools search and fetch docs with) used to be written by hand. They drifted from the language: upstream
renamed its docs pages after Unicode names (`add` -> `plus`, `floor` -> `downstile`), so about 70 of
the 103 "docs" links went dead; chords changed (Option-l now types `↦`, not `→`); some glyphs were
retired (`⍲ ⍱ → ⌾`) and new ones added (`| ⊼ ⊽ ↦ ᵇ`). They are now **generated** from the pinned
upstream revision, so they cannot disagree with the interpreter this build ships:

| Generated | From |
|---|---|
| each card's name, docs slug, Option-key chord, function names | the interpreter's own symbol table (`symbols()`, dumped to `build/bpl/symbols.json` by the WASM build) |
| the Mac keyboard map and the dead-key follow-ups | upstream's own `keyboards.py` run over `layout.json` (the code behind upstream's docs keyboard page) |
| JupyterLite's keyboard (`keyboard_rows.js`), `reference-data.json` | the same result, so all three surfaces show one keyboard |
| the check that every docs link exists | the page names of the pinned revision's `nbs/glyphs/` |

Hand-written text is kept only where upstream has none -- operator and syntax descriptions, notes, and
the examples. Old names and descriptions stay searchable through a hidden `aka` field (so "floor",
"dash", "gcd", or a retired glyph like `⍲` still finds its card). Two upstream details are mirrored
on purpose: key faces list the primitives typed with no Option (`+` on the `=` key, `<` `,` on the comma key)
ahead of the Option glyphs, and leave out the super/subscript digits, which only exist as dead-key follow-ups
(they are in the follow-up table); in the browser Option-Shift-3 types `#`, not `³` (`alt_aliases` in `layout.json`; upstream's
docs say the same), so the keyboards omit that chord; and glyphs upstream retired are dropped, or
replaced in place where there is a direct successor (`⍲ -> ⊼`, `⍱ -> ⊽`, `→ -> ↦`).

It is part of the build: `.github/workflows/pages.yml` and `scripts/build_and_test_jupyterlite.sh` dump
the symbol table, run `python3 scripts/refresh_reference_glyphs.py --build`, and `build.py` deploys
the generated data. The same script also keeps the committed copies (`src/index.html`'s `DATA`,
`reference-data.json`, `jupyterlite/basedpl-kernel/src/keyboard_rows.js`) current for local work:

    bash scripts/prepare_basedpl_wasm.sh                 # vendors the upstream inputs at the pinned REV
    python3 scripts/refresh_reference_glyphs.py          # rewrite the committed copies
    python3 scripts/refresh_reference_glyphs.py --check  # exit 1 if they are stale or a docs link is dead
    node tests/reference-data.mjs build/bpl/symbols.json # docs links, keyboard vs the typing engine, search

The local pipeline (`scripts/pipeline.sh`) runs the `--check` and the data test as a gate, and the
browser check (`tests/e2e/reference.mjs`) covers the Reference tab, the REPL and the notebook page.

**When you bump the pinned revision** in `scripts/prepare_basedpl_wasm.sh`: run `prepare`, run
`refresh_reference_glyphs.py`, commit what changed (including `scripts/vendor/` and `web/Cargo.lock`),
and read the script's "replaced / added / dropped" lines -- a glyph upstream retires with no entry in
`SUCCESSORS` (top of that script) is dropped, which you may want to turn into a replacement.

## WASM compatibility fixes

### 1. getrandom

The WASM dependency graph requires JavaScript-backed randomness:

    getrandom = { version = "0.4.3", features = ["wasm_js"] }

Without this, the initial WASM build failed during dependency compilation.

### 2. UUID

UUID functionality also needs its browser backend:

    uuid = { version = "1.27.0", features = ["js"] }

This fixed the next WASM dependency failure.

### 3. std::time::Instant in the default evaluator (resolved upstream as of v0.1.64, no longer applied)

As of the pinned v0.1.64, upstream fixed this at the root -- `src/host_web.rs`
now does `pub(crate) use web_time::Instant;` (part of a `host`/`host_web`
module split), so `Instant::now()` no longer panics on wasm32 regardless of
whether a timeout/poll is set. `scripts/prepare_basedpl_wasm.sh` no longer
applies the patch described below. Left here for history, in case a similar
WASM-only panic ever reappears in a future bump -- this was the original
failure and fix:

The first runtime failure was:

    RuntimeError: unreachable
      ...
      std::time::Instant::now
      basedpl::execution::Execution::check

Upstream BasedPL's Execution::check() calls Instant::now() even when the evaluation has neither a timeout nor a polling callback.

For normal browser evaluation, EvalOptions::default() has:

    timeout = None
    poll = None

The local compatibility patch therefore changes the timing check to return early when both are absent:

    self.countdown.set(CHECKS_PER_CLOCK - 1);

    if self.poll.is_none() && self.timeout.is_none() {
        if self.interrupt.0.load(Ordering::Relaxed) {
            return Err(span.error(
                ErrorKind::Interrupt,
                "evaluation interrupted",
            ));
        }
        return Ok(());
    }

    let now = Instant::now();

Timeout and poll behavior is otherwise unchanged.

(Historical: the patch was applied by scripts/prepare_basedpl_wasm.sh to a fresh checkout of the pinned upstream revision, verifying the expected source pattern occurred exactly once and failing if upstream changes made the patch ambiguous. The upstream BasedPL repository was never modified. None of this runs anymore as of v0.1.64.)

## Diagnostic versus public evaluation

A temporary diagnostic(code) method in the wrapper calls the interpreter but deliberately does not call Session::show().

This lets CI distinguish:

    diagnostic()
      parser → evaluator → Value

    eval()
      parser → evaluator → Value → Session::show() → JS value

This distinction was useful while diagnosing the original runtime trap.

## ⍳5 regression

The original browser report was:

    ⍳5
    RuntimeError: unreachable

The upstream iota implementation constructs the result through Value::positions() for an exact scalar integer. The expected result is:

    0 1 2 3 4

The regression workflow now tests both paths.

### Interpreter-only test

    s.diagnostic("⍳5")

This tests:

    parser → evaluator → iota → Value

without rendering.

### Actual public REPL path

    s.eval("⍳5")

This tests:

    parser
     → evaluator
     → iota
     → Value
     → Session::show()
     → serde-wasm-bindgen

Both paths now pass in the generated Node WASM artifact on CI. This is important: the remaining browser-side RuntimeError was not reproduced by the corrected WASM build, so the deployed site must use the newly built assets before judging the fix.

## CI

.github/workflows/basedpl-wasm-test.yml:

1. installs stable Rust and wasm32-unknown-unknown
2. installs wasm-bindgen-cli 0.2.129
3. checks out the pinned BasedPL revision and vendors its keyboard/completion
   engine (no local compatibility patch needed as of v0.1.64 -- see
   "Interpreter integration" above)
4. builds the WASM wrapper
5. creates browser and Node bindings
6. tests interpreter-only execution
7. tests the public eval path, including ⍳5

The latest regression run passed both the interpreter-only and public eval tests for:

    12+4
    +/ 12 4 3
    ⍳5

A generated .wasm file alone is not considered a successful integration test.

## Why there is no BasedPL fork

A fork is not currently necessary. The integration repository owns the browser-specific compatibility layer:

    upstream BasedPL
          │ pinned revision
          ▼
    build/basedpl
          │ local WASM patch
          ▼
    basedpl-web wrapper
          ▼
    Web Worker
          ▼
    Browser REPL

This keeps upstream untouched, makes the compatibility delta reviewable, and makes upgrades explicit. A fork would become reasonable if the compatibility changes become substantial or are accepted upstream.

## Production Pages build

.github/workflows/pages.yml uses the same preparation script as the PR workflow, so the deployed build and the PR regression test always use the same pinned BasedPL revision. (Browser E2E against the deployed site is a separate, manually-triggered workflow -- see `.github/workflows/e2e.yml` above.)

After the WASM fix is merged to main, GitHub Pages must rebuild the worker and wasm-bindgen assets. A browser can otherwise continue executing an older worker/wasm pair from cache.

The static reference can also be generated locally:

    python build.py

The generated site is written to dist/index.html.

## Debugging WASM RuntimeError: unreachable

Do not assume every unreachable is the original clock bug.

For this project the debugging sequence is:

1. reproduce the exact expression in the generated Node WASM artifact
2. run it through diagnostic()
3. run it through public eval()
4. determine whether evaluation or rendering/serialization fails
5. inspect the resulting WASM stack/source path
6. add the failing expression to CI before declaring the fix complete
7. rebuild/deploy both the worker JavaScript and WASM assets
8. hard-refresh or use a new asset revision when testing a Pages deployment

This avoids accumulating speculative interpreter patches.

## Current status

- The getrandom WASM configuration is fixed.
- The UUID WASM configuration is fixed.
- The upstream Instant::now() browser trap is fixed locally without forking BasedPL.
- The deterministic local patch is now merged to main.
- The new WASM regression suite passes ⍳5 through both evaluation and public rendering.
- GitHub Pages is rebuilding from the fixed main revision.

If a browser still reports RuntimeError: unreachable after the new Pages deployment completes, the next step should be to capture the exact browser stack and verify that the browser loaded the new worker/wasm assets rather than immediately changing the interpreter again.
