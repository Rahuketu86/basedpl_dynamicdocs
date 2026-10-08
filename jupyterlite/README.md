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

The simplest entry point is the repo root's `scripts/pipeline.sh` -- a single
self-contained script (just needs Docker, nothing else) that builds the dev
image on first run, syncs the working tree into a long-lived container, and
either runs the full suite or serves for live inspection:

    scripts/pipeline.sh              # build once, run the full e2e suite, exit
    scripts/pipeline.sh --serve      # build, then serve on :8899 and block
    scripts/pipeline.sh --reset      # remove the container for a truly clean rebuild

It's a thin wrapper around the two pieces below -- reach for those directly
if you want more control (e.g. a different host/port setup, or to drive the
container by hand).

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

One real gotcha if you drive the container by hand instead of through
`pipeline.sh`: use a plain, non-login shell (`sh -c "..."`, or `docker exec`'s
default) to run commands inside it, not `bash -lc`/`sh -lc`. A login shell
sources `/etc/profile`, which unconditionally resets `PATH` and drops the
image's `/opt/venv/bin` (where `jupyter` lives) off it without restoring it
-- confirmed the hard way: this produces a silent, confusing "jupyter:
command not found" that looks like a broken image, not a shell-invocation
mistake.

`scripts/verify_example_notebooks.mjs` is also runnable standalone, once
`build/diagnostic/` exists (`wasm-bindgen "$WASM" --target nodejs --out-dir
build/diagnostic`), for a near-instant recheck of the example notebooks
without a browser at all.

## Keyboard and completion engine

The Option-chord keyboard and live backtick-completion popup run on
BasedPL's own vendored `input.js` (`src/input.js`/`src/layout.js`, fetched
from upstream at the pinned `REV` by `scripts/prepare_basedpl_wasm.sh` --
see the root README's "Interpreter integration" section), not a hand-ported
reimplementation. `index.ts` requests the real glyph table from the active
kernel's worker once per kernel start (`BasedPLKernel.getSymbols()` ->
`worker.ts`'s `symbols` message -> the `symbols()` wasm export), then calls
`input(rows, layout)` to get `{press, reset, matches, entry, inCode,
bplStart}`. This replaced an earlier hand-ported `press()`/`usKey()` and a
~70-entry hardcoded glyph-name table that had drifted from the real symbol
set.

The main keydown handler is a direct port of BasedPL's own vendored `lb.js`'s
keydown handler (`src/lb.js`, present but not mounted -- see below), not an
independent reimplementation: an earlier from-scratch version of this same
logic went through several real bugs (popup state getting dropped instead of
just hidden on an empty query, Tab depending on stale stored state instead of
recomputing fresh) that `lb.js`'s own structure avoids by construction.
Concretely, its Tab/Enter/delimiter-commit check recomputes `entry(e)` fresh
on *every* keydown and can commit a single match or (re)open the popup even
if tracking state was never set or got cleared -- this makes Tab
self-healing: confirmed live by typing a query fast enough that tracking
state couldn't possibly have "landed" yet, and pressing Tab immediately
after anyway still committed correctly.

A bare backtick shows the full, unfiltered symbol list immediately (same as
real `lb.js`/`input.js`: `matches('')` prefix-matches every name), not a
narrowed-down nothing -- an early version special-cased this to avoid
flooding the popup, which turned out to be an unwanted deviation from the
real reference behavior, not a correctness fix.

The visual Mac-keyboard grid (the full QWERTY-shaped layout, as opposed to
the compact glyph bar) is driven by `src/keyboard_rows.js`, a small
hand-authored `keyboard` row-shape dataset matching the REPL's own
`DATA.keyboard` -- deliberately **not** part of the vendored `layout.json`
(which only has `option`/`alt_aliases`/`states`/`unshifted`; there's no
`keyboard` field in the real upstream file at all). This used to live
*inside* `layout.js` before vendoring overwrote it with the real upstream
file and silently deleted it, crashing plugin activation outright
(`keyboardRows is not iterable`) and taking the whole bar/keyboard/Glyph
menu/header widget down with it. If you ever need to touch the keyboard
grid's shape again, edit `keyboard_rows.js`, not `layout.js` -- re-running
`scripts/prepare_basedpl_wasm.sh` will always overwrite `layout.js` wholesale
from upstream, but never touches `keyboard_rows.js`.

`lb.js` is also vendored alongside `input.js`/`layout.json` (same pinned
`REV`) but its own `editor()`/bar-mounting code is **not** called here: it
mounts its own generic toolbar/popup DOM and self-guards against
double-mounting by checking for an existing `.ngn_lb` element on the page --
which this extension's own bar already is. Calling it would either silently
no-op (if it sees our bar first) or duplicate the toolbar. Its *keydown
handler* is what got ported (above); its DOM-mounting and editor-reading
code did not transfer over as-is, for the editor-adapter reasons below.

### Editor adapter: why not CodeMirror's own API

`editor()`/`snapshotEditor()` read and write the active cell through plain
DOM `Selection`/`Range` APIs -- ported from the Chrome extension's
`content.js`, **not** from CodeMirror6's own `EditorView`/`state` API
(`cell.editor.editor`, `view.state.selection.main`, `view.dispatch(...)`),
which is what this used to do. That approach caused real, confirmed problems
on this exact page during the extension's own development (see the saved
`basedpl_extension` session): a framework's live internal model can be a
step out of sync with what external code observes, in ways a `Selection`/
`Range` reader never is, since that always reflects genuine browser cursor
state rather than CodeMirror's own bookkeeping. One concrete symptom this
caused: chord-typing's `insert()` crashed JupyterLab's own `setSelections`
(`ed.getPositionAt(offset)` returning `undefined` for an in-range offset) --
confirmed live, not theoretical.

"Lines" = direct children of the editable root (`.cm-content`'s real DOM
shape is one `div.cm-line` per line), the same assumption `content.js`'s
generic contenteditable adapter makes -- it's not CodeMirror-specific at
all, which is exactly the point: it should keep working if JupyterLab ever
changes its internal CodeMirror integration, since it never touches that
internal API in the first place. Verified against a multi-line cell
specifically (the actual new risk surface of this change): chord-typing at
the end of a cell's *second* line correctly targeted that line, not the
first.

One real testing gotcha worth recording: `document.execCommand('insertText',
...)` dispatched standalone (decoupled from a real keydown, e.g. from an
out-of-band debugging script) can get silently **reverted** by CodeMirror6 a
short while after -- content appears to insert, then reverts with no error,
because CodeMirror's own DOM reconciliation overrides a mutation it didn't
originate via its own transaction system. This is a simulation artifact, not
an application bug: genuine keystrokes (real hardware, or a real
`Input.dispatchKeyEvent`/`page.keyboard.press` style simulation) go through
CodeMirror's own input handling and don't have this problem. Don't trust an
`execCommand`-based test's "it reverted" result as evidence of an app bug
without re-checking with real per-key events first.

### The completion popup lives at `document.body`, not inside the widget

`tip` (the completion popup element) is appended to `document.body`
directly, **not** to `host` (the header widget's own node). It used to be a
child of `host`, which seemed harmless -- the popup still rendered, with the
right content, `hidden` toggling correctly -- but it was invisible on
screen regardless of `z-index`. Confirmed via
`document.elementFromPoint()` at the popup's own rendered coordinates: it
resolved to the notebook cell underneath, not the popup, even at
`z-index: 10000`. `host` lives inside the Lumino-managed header widget's DOM
subtree, and something in that ancestor chain (JupyterLab/Lumino panels
commonly use `transform`/`will-change` for compositing) creates its own
stacking context, which traps a `position: fixed` descendant's `z-index`
comparison *within* that context -- so no matter how high it's set locally,
the whole header-widget subtree can still paint behind the main notebook
content panel's own stacking context. This is the same reason the REPL's own
completion popup, and the Chrome extension's popup, both append at the top
level (`document.body`/`documentElement`) instead of some nested container.
All the `.bpl_tip*` CSS rules are deliberately unscoped (not prefixed with
`.bpl-header-widget`) so this move needed no CSS changes.

If a popup/overlay you add here ever "looks right in dev tools but isn't
visible on screen," check `elementFromPoint()` at its own coordinates before
assuming the logic is broken -- `hidden`/computed-style state can be
completely correct while this stacking-context trap still hides it.

### Native completer toggle

A "Live Backtick Completion" item in the Glyph menu (checked by default,
`localStorage` key `bpl_completion_engine`) switches between the live popup
above and JupyterLab's native notebook completer (`completer:invoke-notebook`,
backed by the real `Session::complete()`/`complete_glyphs()` -- unchanged,
see the root README). When live completion is on, the backtick keydown
handler claims the keystroke via `stopImmediatePropagation()` (no
`preventDefault`, so the character still types normally) so our own
tracking starts before JupyterLab's own keybinding dispatch runs.

That alone isn't airtight: CodeMirror6's own completer reacts to the
resulting document *change* itself, not to DOM keydown propagation, so it
can still open independently of this handler regardless of
`stopImmediatePropagation()`. A synthetic-Escape dismissal was tried and
removed -- it didn't actually close the native completer, and worse, it got
caught by this extension's *own* Escape handler (which didn't yet check
`event.isTrusted`) and cancelled the live popup as a side effect. Current
state: the native completer may still visually co-appear alongside the live
popup in some cases. Accepted as a known cosmetic gap, not a functional one
-- the live popup's own show/narrow/commit behavior is unaffected either
way. The Escape handler now checks `ev.isTrusted` regardless, as a general
hardening (a synthetic Escape from anywhere shouldn't be able to cancel a
real completion session).

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
