#!/usr/bin/env python3
import os
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src" / "index.html"
DIST = ROOT / "dist"

if not SRC.exists():
    raise SystemExit(f"Missing source: {SRC}")

html = SRC.read_text(encoding="utf-8")
if "<!doctype html>" not in html.lower():
    raise SystemExit("Source is not an HTML document.")
if "BasedPL" not in html:
    raise SystemExit("BasedPL reference content is missing.")

# Give every deployed WASM bundle a unique URL. This avoids stale mobile-browser
# caches serving an older worker/JS/WASM combination after a Pages deployment.
version = os.environ.get("GITHUB_SHA", "dev")[:12]
asset_dir = f"bpl/{version}"
html = html.replace("const BPL_WASM_URL='./bpl/worker.js';",
                    f"const BPL_WASM_URL='./{asset_dir}/worker.js';")

DIST.mkdir(parents=True, exist_ok=True)
for path in DIST.iterdir():
    if path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)

(DIST / "index.html").write_text(html, encoding="utf-8")

# The WASM bundle is produced by CI before this script runs.
WASM_BUILD = ROOT / "build" / "bpl"
if WASM_BUILD.exists():
    target = DIST / asset_dir
    target.mkdir(parents=True, exist_ok=True)
    for path in WASM_BUILD.iterdir():
        if path.is_file():
            shutil.copy2(path, target / path.name)
    shutil.copy2(ROOT / "web" / "worker.js", target / "worker.js")
    vendor_src = ROOT / "web" / "vendor"
    if vendor_src.exists():
        shutil.copytree(vendor_src, target / "vendor", dirs_exist_ok=True)
else:
    raise SystemExit(f"Missing WASM build: {WASM_BUILD}")

print(f"Built {DIST / 'index.html'} and {DIST / asset_dir}")
