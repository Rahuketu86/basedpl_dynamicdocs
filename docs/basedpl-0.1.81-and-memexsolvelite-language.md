# BasedPL 0.1.81 and BasedPL as a memexsolvelite language (P3 A2)

**Status (2026-10-29):**
- **BasedPL upgraded from v0.1.64 to v0.1.81** in basedpl_dynamicdocs: commit `2c36bc5`, pushed. It is tested on beast11;
  the Pages build and Cloudflare deploy are still to be run.
- **BasedPL as a memexsolvelite language** (P3 A2, the basedpl half): commit `c1d3948`, pushed. The worker, its
  interrupt support, the published `msl/v0.1.81/` files, a pinned Rust in CI and a browser test are all in. It is
  tested on beast11, not yet deployed.
- **The Cloudflare size limit, fixed:** commit `5497715`, pushed. The 0.1.81 wasm was over Cloudflare's 25 MiB limit
  per file, so Cloudflare kept serving an older build (see *Part 3*).
- **Not done yet:** the memexsolvelite half. Its manifest entry waits for the deployed site, whose fingerprint differs
  from beast11's (see *Fingerprints*).

**This document records:**
- what went wrong in the first upgrade attempt, and the fixes;
- the architecture, and how the two sites fit together;
- the design and the decisions behind it, with the alternatives;
- the implementation, file by file;
- the refactoring done along the way;
- the tests and their results;
- the risks and open issues, and what comes next.

The same text is in both repos: `docs/basedpl-0.1.81-and-memexsolvelite-language.md` in basedpl_dynamicdocs, and
`05_P3_A2_BASEDPL.ipynb` in memexsolvelite.

## Background

basedpl_dynamicdocs (deployed at `basedpl.rahulsaraf.online` on Cloudflare, and on GitHub Pages) is a keyboard-first
BasedPL reference with a browser REPL and a JupyterLite site. All three run the real BasedPL Rust interpreter, compiled
to WebAssembly through a small wrapper crate (`web/src/lib.rs`, the `BplSession` class). The interpreter is pinned to
an upstream release in `scripts/prepare_basedpl_wasm.sh` (`REV`), and the same script vendors upstream's keyboard and
completion engine (`input.js`, `lb.js`, `layout.json`) and its `keyboards.py` from that same checkout.

Earlier work in this repo, which this builds on:

| Commit | What |
|---|---|
| `cd4371a` | v0.1.31 → v0.1.64; the old WASM `Instant::now()` patch dropped (fixed upstream) |
| `fa27e3f` | `web/Cargo.lock` committed and every build `--locked`, after a newer `rustymath` broke a CI build |
| `0b1c8c1` | The Reference tab's glyph cards, keyboards and agent-tool data generated from upstream (`scripts/refresh_reference_glyphs.py`), instead of hand-written copies whose docs links had gone dead |

memexsolvelite runs languages as Web Workers speaking its `msl-lang/1` protocol (`PROTOCOL.md`). P3 A1 (`0fcd666`) let
it load a language from **another site**: its manifest lists the worker with a pinned fingerprint, and it runs the
checked bytes from a `blob:` URL. A2 was planned as "basedpl as the first real language".

## Part 1: the upgrade to v0.1.81

### The first attempt, and why it failed

The first attempt ran in a memexsolvelite session (2026-10-29, about 02:24 to 02:45). Here is what happened, in order:

1. It bumped `REV` to v0.1.81 (`bf27ca6`) and the kernel version strings, then started the beast11 pipeline.
2. **Failure 1:** `cargo build --locked` stopped at once with "cannot update the lock file ... because --locked was
   passed". `web/Cargo.lock` still pinned basedpl 0.1.64. That is the lockfile doing its job: the bump has to update
   it in the same change.
3. It ran `cargo update -p basedpl` on beast11 and copied the lockfile back. That also moved `rustymath` from 0.1.42 to
   0.1.53, upstream's new minimum, and added upstream's new dependencies.
4. **Failure 2:** the wrapper no longer compiled: ``expected `Session`, found `Turn` `` at `Session::new()`.
5. It began patching `web/src/lib.rs` before reading the new API, and was interrupted.
6. **Scope:** in the same change it had added unrelated work, the memexsolvelite worker and a `build.py` step. That gave
   a version bump that should stand alone more ways to fail.

**Lessons, applied in the second attempt:**
- **Read the whole API the wrapper uses** at the new revision before building, rather than fixing compile errors one at a
  time. Upstream's own wasm crate (`wasm/src/lib.rs`) is the best guide, because upstream migrates it in the same release.
- **Diff the vendored files too**, not just the Rust. Two more failures were waiting there (below), and the first attempt
  would have hit them next.
- **Update `Cargo.lock` as part of the bump**, deliberately, with `cargo update -p basedpl`.
- **Keep a version bump alone** in its commit. The worker was set aside and done afterwards as its own commit.
- **Watch the raw build log**, not only the PASS/FAIL summary: a lowercase cargo `error:` doesn't show in a summary
  that filters for `ERROR` and `FAIL`.

### What changed upstream, and the fixes

| Upstream change (v0.1.64 → v0.1.81) | Effect here | Fix |
|---|---|---|
| **One session per process.** `Session::new()` now returns a `basedpl::Turn`: a turn at the process's single session, cleared as a new session starts. It dereferences to `Session`, and the session's methods now take `&self`. | The wrapper didn't compile. | `BplSession` holds a `Turn`, as upstream's own wasm crate does (`pub struct Session(basedpl::Turn)`). Nothing else changed: `eval_with`, `show`, `complete`, `EvalOptions`, `Evaluation`, `Output::written()`, `protocol::output`, `symbols::{rows, matches}` and `configure_browser` are unchanged. |
| The same change, in behaviour: each `new BplSession()` clears the one session. | Two sessions in one wasm instance would share state. | Every caller was checked. Each makes one session per worker (REPL, JupyterLite kernel, agent kernel), or one per notebook in sequence (`verify_example_notebooks.mjs`, where a fresh state is what it wants). The REPL's "reset" already did `new BplSession()`, which is now exactly a reset. Each Web Worker has its own wasm instance, so its own session. |
| `rustymath >= 0.1.53`; new dependencies. | `--locked` refused the build. | `cargo update --manifest-path web/Cargo.toml -p basedpl`; lockfile committed with the bump. |
| `keyboards.py` now does `from .assets import GENERATED` (the folder its macOS keyboard bundles are written to). | The Reference data generator loads the vendored file on its own, so the relative import would fail. | `refresh_reference_glyphs.py` loads the **unmodified** file as part of a stand-in package that provides just that one name. The vendored file stays byte-for-byte upstream's. |
| Dead keys in `input.js`: Option-5 and Option-6 now type `₅` and `⁶` as their own character (they typed `_` and `^`). Option can now be held through follow-ups (`5x51` → `ₓ₁`). | The generated keyboards and the keyboard tests changed. | The tests type a dead key's own character with **Space**, upstream's documented way, which works on both versions. `₅` and `⁶` are follow-ups, which the keyboards leave to the follow-up table, so keys 5 and 6 now show just their digit. |
| New glyph `⁝` (tricolon, Option-Shift-;), with its own docs page. | One new symbol (100 in all). | Picked up by the generator: 101 cards, and `⁝` on the `;` key of all three keyboards. |

Nothing changed in the REPL's or JupyterLite's own code beyond the version strings.

**An error in the first draft, corrected:** the README at first said that repeating a dead key's chord "can now type a
follow-up instead". A direct check with the real engine showed that repeating and Space give the same result on every
dead key. What actually changed is the dead key's own character (`₅`, `⁶`), and the README now says that.

## Part 2: BasedPL as a memexsolvelite language

### Architecture

```
 memexsolvelite (memexsolvelite.rahulsaraf.online, cross-origin isolated: COOP + COEP credentialless)
   │ site/jupyter-lite.json → memexKernels: [{name: "basedpl", worker_url, integrity, ...}]   (the allowlist)
   │ remote-language.ts:
   │   1. fetch worker_url (CORS, no credentials)
   │   2. sha256 == entry.integrity ?            ── no → refuse, naming both fingerprints
   │   3. run the checked bytes as a blob: module worker
   │   4. post {op: 'init', protocol: 'msl-lang/1', interrupt: SharedArrayBuffer, base}
   ▼
 msl-worker.mjs  (one self-contained module; its real address is unknown, it runs from blob:)
   │   fetch base + basedpl_web.js and base + basedpl_web_bg.wasm, check each one's sha256 (pinned in the worker)
   │   import the glue from a blob:, instantiate the wasm from the checked bytes
   │   set_interrupt(Int32Array over init.interrupt); new BplSession()
   ▼
 basedpl_web (the same wasm the REPL and JupyterLite use)  →  BasedPL Session (a Turn)
   eval ─ poll every ≤10 ms ─▶ Atomics.load(flag, 0) == 1 → stop with an interrupt error

 basedpl.rahulsaraf.online/msl/
   index.json                         {version, path, entry}   which version is current
   v0.1.81/msl-worker.mjs             the worker, its fingerprints filled in by build.py
   v0.1.81/basedpl_web.js             wasm-bindgen glue (--target web)
   v0.1.81/basedpl_web_bg.wasm        the interpreter
   v0.1.81/memexsolvelite-entry.json  the manifest entry, ready to paste
 _headers: /msl/*  Access-Control-Allow-Origin: *, Cross-Origin-Resource-Policy: cross-origin
```

**The chain of trust:** memexsolvelite pins the worker, and the worker pins the glue and the wasm. Every byte that runs
with memexsolvelite's origin was fingerprinted, so nothing can be swapped between the check and the run. This is the
recommendation in `PROTOCOL.md` ("a language should do [this] for its wasm").

**What stays separate:** the REPL (`web/worker.js`) and the JupyterLite kernel (`jupyterlite/basedpl-kernel`) are
unchanged, and they use the same wasm. The worker is a third, independent consumer.

### Design and decisions

| # | Decision | Alternatives | Why this one |
|---|---|---|---|
| 1 | **A hand-written worker** in the basedpl repo (`web/msl-worker.mjs`), written directly against `msl-lang/1`. | A shared `lang-worker` helper in memexsolvelite, as the P3 plan proposed, which the worker would import. | The worker must be **one self-contained module**: it runs from `blob:`, so it can't import a helper by relative path, and a helper bundled in would have to be pinned too. It is about 110 lines. The helper is still worth extracting once a second real language exists (*Next steps*). |
| 2 | **The worker pins its glue and wasm** with SHA-256 fingerprints that `build.py` fills in. | Trust whatever the host serves. | `PROTOCOL.md` pins only the module. Without this, the wasm would be only as trustworthy as the host. |
| 3 | **A path per version** (`msl/v0.1.81/`). | A `latest/` path. | memexsolvelite pins a fingerprint, so a `latest/` path breaks the pin at every update. A versioned path makes each update deliberate. |
| 4 | **A pinned Rust toolchain in CI** (`RUST_TOOLCHAIN: "1.99.0"`, also in the WASM cache key). | Keep "stable", and put the wasm's hash in the path. | With "stable", a cache miss after a Rust release rebuilds different bytes under the same path, and memexsolvelite would refuse the worker. Pinning keeps the same version's bytes, and so its fingerprints, stable across rebuilds. A hash in the path would mean updating the entry on every unrelated rebuild. |
| 5 | **Interrupt through a poll callback** reading memexsolvelite's shared flag (`set_interrupt(flag)` in `lib.rs`). | No interrupt: rely on memexsolvelite restarting the worker after 2 s. | A restart loses the session's state: every name defined so far. With the poll, a running cell stops in milliseconds, and the session keeps its state. |
| 6 | **The poll exists only when a flag was given.** | Always poll. | The REPL and JupyterLite never call `set_interrupt`, so their evaluation is exactly as before (no poll, no clock reads). |
| 7 | **The worker clears the flag when an execute starts**, and reports an error as `KeyboardInterrupt` only if the flag is set when the eval ends. | Map BasedPL's "evaluation interrupted" message. | This is the protocol's rule ("a worker clears the flag when it starts the next execute"). Checking the flag rather than parsing the error text is robust to upstream rewording. |
| 8 | **The same output rules as the JupyterLite kernel:** `display` events are results (the last one is the cell's value, earlier ones are displays), other text is stdout, a BasedPL error is the reply's `error`. | Invent new rules. | A cell gives the same result in either kernel. |
| 9 | **The entry is written by `build.py`**, with the real site URL (`https://basedpl.rahulsaraf.online`, overridable with `BASEDPL_SITE`). | A separate helper script that prints a fingerprint, as the P3 plan proposed. | The build knows the exact bytes it publishes, so the entry can't disagree with them. `msl/index.json` says which version is current. |
| 10 | **Headers through Cloudflare's `_headers`.** | A Worker script. | The Cloudflare deploy is an assets-only Worker, and those apply `_headers`. GitHub Pages ignores the file but already sends `Access-Control-Allow-Origin: *`, and the worker fetches in CORS mode. |
| 11 | **Served from `basedpl.rahulsaraf.online`**, the existing basedpl site. | A separate site for languages. | Your decision: same site, no new hosting. |
| 12 | **Done as its own commit, after the upgrade.** | One commit, as the first attempt did. | Version bumps stay separately revertable and testable. |

### Implementation

**`web/src/lib.rs`** (the wasm wrapper, shared by all three consumers):
- `BplSession { session: Turn }` (Part 1).
- A `thread_local!` holding the host's `Int32Array`. It lives there rather than in the poll closure, because a `Poll`
  must be `Send + Sync` and a JavaScript object isn't. This is the same pattern upstream's wasm crate uses for its
  output callback.
- `#[wasm_bindgen] pub fn set_interrupt(flag: Option<Int32Array>)`.
- `fn interrupt_poll() -> Option<Poll>`: `None` without a flag, otherwise a closure doing `Atomics.load(flag, 0) == 1`.
  `eval` passes it as `EvalOptions.poll`. BasedPL calls the poll at most every 10 ms while it checks for interruption,
  and stops with its interrupt error when the poll returns true.

**`web/msl-worker.mjs`** (published as `msl/v<version>/msl-worker.mjs`):
- `onmessage` is set synchronously, before any `await`, as the protocol requires, so `init` is never lost.
- `init`: keeps `base` and an `Int32Array` over `init.interrupt` (or `null` when the page isn't isolated). It then
  loads the glue and the wasm through `base`, checks both fingerprints, imports the glue from a `blob:` URL, and
  instantiates the wasm from the checked bytes. Then it calls `configure(base)`, `set_interrupt(flag)` and
  `new BplSession()`. It always answers `ready` with `kernel_info`. If loading failed, the banner says why, and later
  requests fail with `Unavailable`.
- `execute` (`code`, `quiet`/`silent`): clears the flag, evaluates, posts stdout `stream` events and earlier displays as
  `display` events, and replies `{result, error}`.
- `complete`: a backtick before a name completes glyphs by name (`` `om `` → `⍵`). Otherwise it completes session names.
- `evaluate`: user expressions, each as a `UserExpressionRecord`.
- `is_complete` replies `unknown`. `hosts`, `host_settle` and `shutdown` reply `null`. `interrupt` is a no-op, because
  the flag does the work. Any other op gets `NotImplementedError`, as the protocol says.

**`build.py`:** after the existing site build, it:
- reads the BasedPL version from the pinned checkout's `Cargo.toml`;
- copies the glue and the wasm to `dist/msl/v<version>/`;
- fills `__BPL_VERSION__`, `__GLUE_INTEGRITY__` and `__WASM_INTEGRITY__` into the worker, refusing to build if a marker
  is missing;
- writes `memexsolvelite-entry.json` (the worker's fingerprint, the real URL), `dist/msl/index.json` and `dist/_headers`.

**CI** (`pages.yml`, `basedpl-wasm-test.yml`): `env.RUST_TOOLCHAIN: "1.99.0"`, `dtolnay/rust-toolchain@master` with
`toolchain: ${{ env.RUST_TOOLCHAIN }}`, and the toolchain in the WASM cache key. `e2e.yml` runs the new browser test
against the deployed site.

### Fingerprints

- On beast11, all three builds gave the same worker fingerprint, `sha256-f1pWxGKsC50xxWABP7pAdzjdrtUU0RJvA0h0gP5BNYU=`,
  so the build is deterministic on one machine.
- **The deployed fingerprint will differ.** Rust embeds source paths (in panic messages, for example), and CI builds in
  a different directory than beast11. So memexsolvelite's entry must be taken from the deployed
  `https://basedpl.rahulsaraf.online/msl/index.json`, not from a local build.
- **When the fingerprint changes:** after a BasedPL bump (the path changes too), and after a change to
  `RUST_TOOLCHAIN`, `wasm-bindgen`, `web/src/lib.rs`, `Cargo.lock` or `web/msl-worker.mjs`. Each such deploy needs the
  new entry pasted into memexsolvelite's manifest. Each deploy also replaces `dist/`, so only the current version is
  served.

## Part 3: Cloudflare's 25 MiB limit per file

**What happened:** after the Pages run went green and `deploy-cloudflare.yml` ran, `basedpl.rahulsaraf.online` still
served `0b1c8c1`, from before both new commits, and `/msl/` returned 404. GitHub Pages served the new build.

**The cause:** Cloudflare Workers accept at most 25 MiB (26,214,400 bytes) per static asset, and refuse the whole
deploy over one larger file. BasedPL v0.1.81's browser wasm is 27,999,584 bytes; v0.1.64's was 21,080,353 bytes.
GitHub Pages has no such limit, which is why it took the build.

**The fix** (`5497715`):
- **Strip the name section:** every browser build runs wasm-bindgen with `--remove-name-section
  --remove-producers-section`, which takes the wasm to 21,756,030 bytes. This is what upstream's own npm release does
  (`cargo wasm --strip`). The cost: a trap's stack shows `wasm-function[N]` instead of Rust names. The README says to
  rebuild locally without the flags to read them. The Node diagnostic build keeps its names.
- **The WASM cache key gets a `stripped` marker**, because the key didn't cover the workflow file, so a cache hit would
  have restored the old 28 MB build.
- **`scripts/check_asset_sizes.py`** runs after the site and JupyterLite builds, in CI and on beast11, and fails the
  build when a file is over the limit. A file that's too big now turns the Pages run red, instead of leaving a stale
  Cloudflare site with nothing visible.

**Lesson:** the beast11 pipeline tested everything except the deploy target's constraints. The size check now covers
the one that bit. The headroom is about 4.4 MB, so a future upstream release could hit the limit again. The check will
catch it, and the next step would be `wasm-opt`, or splitting the files.

**The fingerprint changed again** with the smaller wasm, so memexsolvelite's entry must be taken from the deployed site
after the next Cloudflare deploy. The entry wasn't in memexsolvelite yet, so nothing broke.

## Refactoring and cleanup along the way

- **The worker work was set aside, then restored:** the first attempt's worker and `build.py` step were moved to
  `build/pending-a2/` (gitignored) during the upgrade, then re-applied on top of it. `build/pending-a2/` is now
  redundant and can be deleted.
- **`build.py`:** the worker step's imports (`base64`, `hashlib`, `re`) moved to the top of the file, and the entry's
  `<site>` placeholder was replaced by the real URL.
- **`refresh_reference_glyphs.py`:** the loader for `keyboards.py` now builds a stand-in package, so upstream's file
  stays unmodified.
- **`tests/reference-data.mjs`:** both dead-key paths (the keyboard check and the chord replay) type a dead key's own
  character with Space, a `' ': 'Space'` key code was added, and a stale comment was fixed.
- **The README:**
  - the pin (v0.1.81, `bf27ca6`);
  - the lockfile procedure for a bump (`cargo update -p basedpl`, and what the `--locked` error means);
  - the v0.1.64 → v0.1.81 notes;
  - a new section, "BasedPL as a memexsolvelite language";
  - layout entries for the new files.
- **Not refactored, on purpose:** the event-to-output mapping now exists three times:
  - `jupyterlite/basedpl-kernel/src/kernel.ts`;
  - `web/worker.js`;
  - `web/msl-worker.mjs`.

  They run in different environments (a TypeScript extension, a raw Worker, a module that must be self-contained), so
  sharing one copy needs a build step. See *Next steps*.

## Tests

All runs used the beast11 pipeline (`scripts/build_and_test_jupyterlite.sh` in the warm `basedpl-kb-build` container).
It stops at the first failure, and the final run reached `===BUILD_AND_TEST_DONE===`.

| Suite | What it checks | Result |
|---|---|---|
| WASM build | the wrapper against v0.1.81 with `--locked` | pass |
| `tests/reference-data.mjs` | docs links exist; slugs are upstream's names; every symbol has a card; the keyboard matches the real typing engine (47 keys); all 83 chords type their glyph; search | 10/10 |
| `scripts/verify_example_notebooks.mjs` | the five example notebooks' code cells in the Node wasm build (64 cells) | pass |
| `tests/e2e/repl.mjs` | the REPL: bar and keyboard, `3`, `2+4`, `⍳5`, `+/ 1 2 3` | pass |
| `tests/e2e/jupyterlite-glyph.mjs` | JupyterLite's glyph bar and keyboard | pass |
| `tests/e2e/reference.mjs` | the Reference tab, REPL and notebook page: 101 cards, docs links, search, the three keyboards key by key | 22/22 |
| `tests/e2e/msl-worker.mjs` (**new**) | loads the worker as memexsolvelite does, from a cross-origin isolated page: fingerprint, `ready`, `⍳5`, state across cells, stdout, a BasedPL error, `` `om `` completion, **interrupt of an endless loop `{⍵+1}⍣≡0` (stopped about 300 ms after the flag), state kept after it**, no page errors | 12/12 |
| `tests/e2e/example-notebooks.mjs` | the five example notebooks run in JupyterLite in the browser | pass |

**Two failures along the way, both in the new test, not the product:**
1. It wrote a string as `'hi'`. In BasedPL that is a character literal, and strings use double quotes, so it was a
   syntax error.
2. It expected `⎕←"hi"` to write `hi`. It writes `"hi"`, because `⎕←` shows the value as BasedPL displays it.

**Not tested yet:**
- the deployed site, until the Pages and Cloudflare runs are done;
- memexsolvelite loading the worker, until its manifest has the entry.

## Risks and open issues

1. **Only the current version is served.** Each deploy replaces `dist/`, so after a bump, a memexsolvelite still pinned
   to the old version can't load BasedPL until its entry is updated.
2. **The fingerprint changes with any toolchain-level change** (see *Fingerprints*). The failure is safe, because
   memexsolvelite refuses the changed module and names both fingerprints, but it needs a manual update.
3. **No stdin.** BasedPL's `⎕` input and `•nget "-"` give an IO error. The worker doesn't wire `EvalOptions.input` to
   memexsolvelite's stdin buffer yet.
4. **Relative file paths** in `•nget`, `•nput` and `•load` resolve against the worker's own folder on the basedpl site,
   not against memexsolvelite's files.
5. **Not implemented:** `inspect`, `symbols`, `kernel_op`, and host functions (`hosts` is accepted, but BasedPL code
   can't call them). `is_complete` answers `unknown`.
6. **Without cross-origin isolation** there's no interrupt buffer, and memexsolvelite falls back to restarting the worker
   after 2 s, which loses the state. memexsolvelite's own site is isolated (`COEP: credentialless`).
7. **The interrupt depends on BasedPL polling.** It stops loops and function calls, which check for interruption. A
   single long native operation that never checks would still run until memexsolvelite's restart.
8. **Three copies of the output mapping** (see *Refactoring*) can drift apart.
9. **About 4.4 MB of headroom** under Cloudflare's 25 MiB limit (*Part 3*). `scripts/check_asset_sizes.py` fails the
   build before a deploy could go stale.

## Next steps

1. **Deploy:** wait for the Pages run for `5497715` (a full WASM rebuild, since the cache key changed), then
   `deploy-cloudflare.yml` with a blank `run_id`. Check `https://basedpl.rahulsaraf.online/msl/index.json`, then run
   `e2e.yml` against the deployed site.
2. **memexsolvelite's half of A2:**
   - paste the deployed entry into `site/jupyter-lite.json` → `memexKernels`;
   - add a memexsolvelite e2e check that runs a BasedPL cell, interrupts one, and completes `` `om ``;
   - redeploy, and try it in the browser.
3. **Keep older versions available** (optional): copy the previous `msl/v*/` folders into each deploy from the last
   successful artifact, so a bump doesn't break an existing pin.
4. **Cross-machine reproducible wasm** (optional): build with `--remap-path-prefix`, so beast11 and CI produce the same
   fingerprint, and the entry can be checked before deploying.
5. **stdin:** wire `EvalOptions.input` to memexsolvelite's stdin buffer (`input` event, `Atomics.wait`).
6. **`inspect` and `symbols`:** BasedPL has `Session::inspect`, `names` and `preview`, which can back them.
7. **Host functions:** bind JS functions as BPL names, like upstream's wasm crate's `bind()`, so `hosts` and
   `host_call` work.
8. **The shared `lang-worker` helper** (from the P3 plan), once a second real language exists. It would hold the
   protocol, streams, stdin, interrupt and asset checks, and be bundled into each worker at build time, so workers stay
   self-contained.
9. **One output mapping:** generate the three copies from one source at build time, or have the REPL and the kernel
   consume the msl worker.
