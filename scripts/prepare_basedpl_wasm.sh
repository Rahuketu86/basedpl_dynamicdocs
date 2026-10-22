#!/usr/bin/env bash
set -euo pipefail

REV="6a9f58b620a6cbc0881da72a881e67e682b423b1"  # v0.1.64 -- matches the officially published/tested `basedpl` npm package
DEST="${1:-build/basedpl}"

# Reuse a checkout that is already at the pinned revision (CI runs this again after a WASM
# cache hit, and local rebuilds shouldn't re-clone); otherwise start fresh.
if [ -d "$DEST/.git" ] && [ "$(git -C "$DEST" rev-parse HEAD 2>/dev/null)" = "$REV" ]; then
    echo "prepare_basedpl_wasm: $DEST is already at $REV"
else
    rm -rf "$DEST"
    git clone --quiet https://github.com/AnswerDotAI/basedpl.git "$DEST"
    git -C "$DEST" checkout --quiet "$REV"
fi

# No local compatibility patch needed as of this REV: upstream refactored
# timing into a host/host_web module split (src/host_web.rs now does
# `pub(crate) use web_time::Instant;`), which fixes the wasm32
# Instant::now() panic a local patch used to work around here, at the root.
# If a future REV bump reintroduces a similar WASM-only panic, that's the
# place to look first before reaching for a new patch.

# Vendor the real keyboard/completion engine at the same pinned REV -- never bump
# these independently of the WASM pin above, see README.md's "Interpreter
# integration" section. `layout.json` is upstream's own static file; `input.js`
# and `lb.js` are bare expressions (python/basedpl/notebooks.py concatenates them
# into a larger eval'd script), so each gets an `export default` wrapper for the
# two forms consumed here: ESM (JupyterLite kernel, TypeScript) and raw text
# (REPL, fetched + `(0, eval)()`'d at runtime, same as upstream's own
# nbs/playground/page.js::addBar()).
JL_SRC="jupyterlite/basedpl-kernel/src"
WEB_VENDOR="web/vendor"
mkdir -p "$JL_SRC" "$WEB_VENDOR"

python3 - "$DEST/python/basedpl" "$JL_SRC" "$WEB_VENDOR" <<'PY'
from pathlib import Path
import sys

src, jl_src, web_vendor = (Path(p) for p in sys.argv[1:4])

for name, export_name in (("input.js", "input"), ("lb.js", "lb")):
    text = (src / name).read_text()
    (jl_src / name).write_text(f"const {export_name} = ({text});\nexport default {export_name};\n")
    (web_vendor / name).write_text(text)

layout_json = (src / "layout.json").read_text()
(jl_src / "layout.js").write_text(f"export default {layout_json};\n")
(web_vendor / "layout.json").write_text(layout_json)
PY

# Vendor what scripts/refresh_reference_glyphs.py needs to generate the Reference tab's glyph
# cards, keyboard and dead-key follow-ups from upstream at this same pinned REV (it runs files
# from this repo, never straight from the checkout):
#   - upstream's own keyboards.py, unmodified: it derives the docs keyboard map from layout.json
#   - keyboards.json trimmed to the US layout (the only one the docs map uses; ~13 KB, not 80 KB)
#   - the names of the glyph docs pages, which is what each card's "docs" link must point at
SCRIPT_VENDOR="scripts/vendor"
mkdir -p "$SCRIPT_VENDOR"
python3 - "$DEST" "$SCRIPT_VENDOR" <<'PY'
import json
import sys
from pathlib import Path

dest, out = Path(sys.argv[1]), Path(sys.argv[2])
src = dest / "python" / "basedpl"

(out / "keyboards.py").write_text((src / "keyboards.py").read_text(encoding="utf-8"), encoding="utf-8")
us = {"us": json.loads((src / "keyboards.json").read_text(encoding="utf-8"))["us"]}
(out / "keyboards.json").write_text(json.dumps(us, ensure_ascii=False) + "\n", encoding="utf-8")
pages = sorted(p.stem for p in (dest / "nbs" / "glyphs").glob("*.qmd"))
(out / "glyph_pages.json").write_text(json.dumps(pages, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print(f"vendored keyboards.py, US keyboards.json and {len(pages)} glyph page names -> {out}")
PY
