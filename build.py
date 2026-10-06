#!/usr/bin/env python3
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

DIST.mkdir(parents=True, exist_ok=True)
for path in DIST.iterdir():
    if path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)

shutil.copy2(SRC, DIST / "index.html")
print(f"Built {DIST / 'index.html'}")
