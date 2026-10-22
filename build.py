#!/usr/bin/env python3
import json
import os
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "scripts"))
import refresh_reference_glyphs as reference  # noqa: E402
SRC = ROOT / "src" / "index.html"
DIST = ROOT / "dist"

if not SRC.exists():
    raise SystemExit(f"Missing source: {SRC}")

html = SRC.read_text(encoding="utf-8")
if "<!doctype html>" not in html.lower():
    raise SystemExit("Source is not an HTML document.")
if "BasedPL" not in html:
    raise SystemExit("BasedPL reference content is missing.")

REF_DATA = ROOT / "reference-data.json"
if not REF_DATA.exists():
    raise SystemExit(f"Missing reference data: {REF_DATA}")

# The glyph cards, keyboard and follow-ups are generated from the pinned upstream BasedPL by
# `scripts/refresh_reference_glyphs.py --build` (CI and scripts/build_and_test_jupyterlite.sh run it
# right after the WASM build). Use that output when it exists, so a deploy can never ship data that
# disagrees with the interpreter it ships; otherwise fall back to the committed copies.
GENERATED = ROOT / "build" / "reference.json"
if GENERATED.exists():
    html = reference.apply_reference(html, json.loads(GENERATED.read_text(encoding="utf-8")))
    reference_data = reference.reference_data_text(reference.read_data(html))
    print(f"Reference data generated from upstream ({GENERATED.relative_to(ROOT)})")
else:
    reference_data = REF_DATA.read_text(encoding="utf-8")
    print("Reference data: using the committed copy (no build/reference.json)")

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
(DIST / "reference-data.json").write_text(reference_data, encoding="utf-8")

# The WASM bundle is produced by CI before this script runs.
WASM_BUILD = ROOT / "build" / "bpl"
if WASM_BUILD.exists():
    target = DIST / asset_dir
    target.mkdir(parents=True, exist_ok=True)
    for path in WASM_BUILD.iterdir():
        if path.is_file() and path.name != "symbols.json":  # build-time input for the reference data, not a runtime asset
            shutil.copy2(path, target / path.name)
    shutil.copy2(ROOT / "web" / "worker.js", target / "worker.js")
    vendor_src = ROOT / "web" / "vendor"
    if vendor_src.exists():
        shutil.copytree(vendor_src, target / "vendor", dirs_exist_ok=True)
else:
    raise SystemExit(f"Missing WASM build: {WASM_BUILD}")

print(f"Built {DIST / 'index.html'} and {DIST / asset_dir}")
