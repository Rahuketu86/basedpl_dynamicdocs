#!/usr/bin/env python3
"""Fail if any file in the built site is over Cloudflare Workers' limit of 25 MiB per static asset.

Cloudflare refuses the whole deploy over one such file, and keeps serving the previous build, while GitHub Pages
takes it, so the problem only shows as a stale Cloudflare site. Checking here, after the site and JupyterLite builds,
turns it into a failed build instead. (BasedPL v0.1.81's wasm was 28 MB with its name section; see README.md.)

    python3 scripts/check_asset_sizes.py [dist]
"""
import sys
from pathlib import Path

LIMIT = 25 * 1024 * 1024
dist = Path(sys.argv[1] if len(sys.argv) > 1 else "dist")
files = [p for p in dist.rglob("*") if p.is_file()]
if not files:
    sys.exit(f"{dist} has no files")
too_big = sorted((p.stat().st_size, p) for p in files if p.stat().st_size > LIMIT)
largest = max(files, key=lambda p: p.stat().st_size)
for size, path in too_big:
    print(f"over Cloudflare's 25 MiB limit: {path} ({size:,} bytes)")
if too_big:
    sys.exit(1)
print(f"asset sizes ok: {len(files)} files, largest {largest.relative_to(dist)} ({largest.stat().st_size:,} bytes, limit {LIMIT:,})")
