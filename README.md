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
    scripts/prepare_basedpl_wasm.sh Reproducible local BasedPL compatibility patch
    .github/workflows/pages.yml     Production Pages build
    .github/workflows/basedpl-wasm-test.yml
                                    PR WASM build/runtime regression tests
    build.py                        Reference-page generator

## Interpreter integration

The application pins:

    AnswerDotAI/basedpl
    44352d9b63ef7532055f373c6cc32984430f71f5

The wrapper uses the real Rust API:

- Session::new()
- Session::eval_with()
- Session::show()
- Session::complete()

One Session lives inside the worker, so interpreter state persists between REPL evaluations.

The worker protocol is intentionally small:

    main page -- {type:"eval", code:"⍳5"} --> worker
    worker --> BplSession::eval() --> JSON text --> JSON.parse()
    worker <-- {type:"result", output, events, value, error} --

The WASM wrapper deliberately returns the evaluation envelope as JSON text.
This keeps the Node and browser wasm-bindgen targets on the same deterministic
wire format instead of depending on JavaScript object serialization.

The UI also has a compact APL keyboard, command history, completion popup, Enter-to-evaluate, Tab-to-complete, Escape-to-close, and cursor-aware glyph insertion.

### REPL value rendering

`BplSession::eval()` returns a JSON envelope containing `output`, `events`,
`error`, and `value`. The Rust `Session::show()` API returns the evaluated
value as display text, while BasedPL's `OutputSink` produces display events.
The Worker parses the envelope and forwards all of it to the page. The browser
UI renders captured output/display events and shows `error` when present.

A deployed browser E2E test in `tests/e2e/repl.mjs` exercises the actual GitHub
Pages URL and verifies visible output for `3`, `2+4`, `⍳5`, and `+/ 1 2 3`.
The Pages workflow runs that test only after the deployment job succeeds.

## WASM compatibility fixes

### 1. getrandom

The WASM dependency graph requires JavaScript-backed randomness:

    getrandom = { version = "0.4.3", features = ["wasm_js"] }

Without this, the initial WASM build failed during dependency compilation.

### 2. UUID

UUID functionality also needs its browser backend:

    uuid = { version = "1.27.0", features = ["js"] }

This fixed the next WASM dependency failure.

### 3. std::time::Instant in the default evaluator

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

The patch is applied by scripts/prepare_basedpl_wasm.sh to a fresh checkout of the pinned upstream revision. The upstream BasedPL repository is not modified.

The script verifies that the expected source pattern occurs exactly once and fails if upstream changes make the patch ambiguous.

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
3. checks out the pinned BasedPL revision
4. applies the deterministic compatibility patch
5. builds the WASM wrapper
6. creates browser and Node bindings
7. tests interpreter-only execution
8. tests the public eval path, including ⍳5

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

.github/workflows/pages.yml uses the same preparation script as the PR workflow, so deployment and testing use the same BasedPL revision and WASM compatibility patch.

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
