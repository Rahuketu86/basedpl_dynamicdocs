# BasedPL JupyterLite

This directory contains the browser-native BasedPL JupyterLite kernel.

The kernel is an adapter around the existing BplSession WASM API. It does
not contain a second APL interpreter.

The intended architecture is:

Reference / REPL / JupyterLite
        \\       |       /
             BasedPL
             Session
                |
              WASM

The first milestone is execution, MIME-aware display, completion and
persistent kernel state. The notebook keyboard and richer stdin integration
are subsequent frontend work.

## Example notebooks

`files/examples/` ships five notebooks adapted from the upstream BasedPL docs
(`data.ipynb`, `regex.ipynb`, `distributions.ipynb`, `xml.ipynb`,
`plot.ipynb`), plus the real data files some of them read
(`sales.csv`/`sales.tsv`, `regex.bpl`, `puppy.jpg`). They're adapted, not
copied verbatim, in two ways:

- `]help` cells are dropped. That's an nbdev doc-generation magic, not
  executable BPL -- it only makes sense in upstream's own notebook-to-docs
  build, not a plain kernel.
- A couple of examples use syntax or an API shape from a newer BasedPL
  revision than this build's pin; see "Interpreter integration" in the repo
  root README for why that pin isn't bumped casually. Where that mattered
  (`(?i)cat` has no JS-native-regex equivalent, since the browser build
  compiles `•r` patterns with JavaScript's `RegExp`, not Rust's regex crate)
  the example is rewritten to the same effect, with a note explaining why.

`scripts/verify_example_notebooks.mjs` runs every code cell directly through
a Node-target `BplSession` as a fast correctness check (no browser needed).
It can't exercise everything, though: `•nget`/`•nput`/`•load`/`•image
"path"` need the browser's `XMLHttpRequest`-based file host (see below),
and `•plot` panics under plain Node (it appears to need a DOM canvas for
text-label layout) -- those cells are skipped there and are only exercised
for real by `tests/e2e/example-notebooks.mjs`, which drives each notebook
end-to-end in a real browser.

## File I/O (`•nget`/`•nput`/`•load`)

These resolve relative paths against a base URL that the browser build must
be told explicitly, via the WASM module's `configure(base)` export --
without it, every file read/write just errors, regardless of whether the
file exists. `kernel.ts` computes that base (`.../jupyterlite/files/`, one
level up from the lab page) and sends it to the worker as a `{type:
"configure", base}` message right after constructing the worker.

Two things worth knowing if you touch this again:

- It's sent via `postMessage`, not baked into the worker's own URL as a
  query param. `new Worker(new URL('./worker.js', import.meta.url), {type:
  'module'})` has to stay written exactly like that, inline -- webpack 5
  only recognizes that *exact* literal expression as a worker-asset
  reference and statically bundles/resolves it. Splitting it into `const
  url = new URL(...); ...; new Worker(url, ...)` (e.g. to append a query
  param) silently breaks that detection: `import.meta.url` stops resolving
  to a real URL (it stringifies to the literal text `"[object Module]"`
  instead), so the worker loads a broken, nonexistent path. Nothing throws
  anywhere visible -- the kernel just never comes up, which looks exactly
  like every cell hanging at "Busy" forever, including cells with no file
  I/O in them at all.
- `•nput` (writing) isn't demonstrated in the example notebooks: this site
  is static-hosted with no writable backend, so a write would just fail.
  `•nget`/`•load`/`•image "path"` (reading) do work, against the bundled
  files above.

## Local build + test loop

`scripts/build_and_test_jupyterlite.sh` builds the WASM module, the
extension, the main site and the JupyterLite site, then runs all the E2E
suites against a local static server -- the same thing
`.github/workflows/pages.yml` + `.github/workflows/e2e.yml` do in CI,
runnable locally (or on a beefier remote machine) for a much faster
iteration loop than waiting on CI each time. `docker/jupyterlite-build.Dockerfile`
bakes in everything that's slow and doesn't change often (Rust +
`wasm-bindgen-cli`, the Python/Jupyter build backend, Playwright + Chromium),
so once that image is built once, further iterations only pay for the parts
that actually changed:

    docker build -f docker/jupyterlite-build.Dockerfile -t basedpl-jupyterlite-build .
    # then, in a container from that image, with the repo at /work/repo:
    bash scripts/build_and_test_jupyterlite.sh                      # build + run all E2E once
    bash scripts/build_and_test_jupyterlite.sh --serve-only-port 8899  # build, then serve + block for live inspection

`scripts/verify_example_notebooks.mjs` is also runnable standalone, once
`build/diagnostic/` exists (`wasm-bindgen "$WASM" --target nodejs --out-dir
build/diagnostic`), for a near-instant recheck of the example notebooks
without a browser at all.

## JupyterLab shell integration

The bar/keyboard widget is attached via JupyterLab's own `header` shell
region (`app.shell.add(inputWidget, 'header', {rank: 501})`), not a
fixed-position page overlay -- that was tried first and discarded, since it
fights JupyterLab's own layout/scrolling instead of living inside it. Sizing
that region correctly took a few non-obvious fixes, in case this needs
revisiting:

- The widget's own height comes from measuring its real rendered content
  (`bar.scrollHeight`/`offsetHeight`), not a fixed guess -- a fixed
  `min-height` per mode doesn't track the actual content height (which also
  changes at the `@media(max-width: 1100px)` breakpoint), leaving a visible
  gap between the keyboard and the menu bar below it.
- That alone doesn't make the header *region* (`#jp-header-panel`) itself
  grow or shrink, though: it positions its child with `position: absolute`,
  and an absolutely-positioned child's size never propagates up to inflate
  its ancestor's size -- that's just CSS, regardless of Lumino. Call
  `.fit()` on the real widget instances (`inputWidget.parent`, then
  `app.shell`) to make the ancestor re-derive its size, in that order.
  Don't reach for `BoxLayout.setSizeBasis`/`setStretch` from an imported
  `@lumino/widgets` copy here: this extension's webpack build can end up
  consuming `@lumino/widgets` as a shared singleton at a host-declared
  version range incompatible with what the extension requires, silently
  giving you a private bundled copy with its own separate attached-property
  storage -- the call succeeds but has no visible effect, since the real
  shell's layout engine reads from a different copy's storage.
- Once Lumino has fit a widget, it leaves an explicit inline pixel `height`
  (and, one level up, `min-height`) on its node as part of its own
  absolute-position bookkeeping -- and that, not any CSS rule, is what the
  node's rendered size actually is. A later `fit()` reads that same stale
  value back unless it's cleared first, on *both* levels of the tree (the
  widget's own node, and `inputWidget.parent.node` one level up): a
  hide/show round trip in particular pins the header panel itself to an
  explicit `height: 0px`, not just the widget inside it.

`tests/e2e/jupyterlite-glyph.mjs` asserts the real header height changes on
every mode/hide/show transition, not just that the right CSS class is
present -- Playwright's `visible` state only checks the DOM bounding box, so
a regression here can otherwise pass that check while the header stays
visually collapsed or stuck at the wrong size.
