#!/usr/bin/env bash
set -euo pipefail

REV="88333e3785f4e8c391ed93dba0c001cb350c9440"  # v0.1.31 -- matches the officially published/tested `basedpl` npm package
DEST="${1:-build/basedpl}"

rm -rf "$DEST"
git clone --quiet https://github.com/AnswerDotAI/basedpl.git "$DEST"
git -C "$DEST" checkout --quiet "$REV"

python3 - "$DEST/src/execution.rs" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()

needle = "        self.countdown.set(CHECKS_PER_CLOCK - 1);\n        let now = Instant::now();\n"
replacement = """        self.countdown.set(CHECKS_PER_CLOCK - 1);
        if self.poll.is_none() && self.timeout.is_none() {
            if self.interrupt.0.load(Ordering::Relaxed) {
                return Err(span.error(ErrorKind::Interrupt, "evaluation interrupted"));
            }
            return Ok(());
        }
        let now = Instant::now();
"""
if text.count(needle) != 1:
    raise SystemExit(f"Expected timing pattern exactly once, found {text.count(needle)}")
path.write_text(text.replace(needle, replacement))
PY

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
