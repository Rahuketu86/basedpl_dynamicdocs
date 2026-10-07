#!/usr/bin/env bash
# Build the BasedPL JupyterLite extension + static site and run the E2E
# tests, entirely locally. Intended to run inside a container built from
# docker/jupyterlite-build.Dockerfile (Rust/wasm-bindgen-cli, the Python
# Jupyter build backend, and Playwright+Chromium already installed there) --
# this script only does the parts that actually change between iterations.
#
# Usage (from the repo root, inside the build container):
#   bash scripts/build_and_test_jupyterlite.sh [--serve-only-port PORT]
#
# With no arguments: builds everything and runs both E2E suites once against
# a throwaway local server, then exits.
# With --serve-only-port PORT: builds everything, then serves dist/ on PORT
# and blocks (Ctrl-C to stop) -- useful for live visual/CDP inspection.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8899
SERVE_AND_BLOCK=false
if [[ "${1:-}" == "--serve-only-port" ]]; then
  PORT="$2"
  SERVE_AND_BLOCK=true
fi

echo "===STAGE:wasm-build==="
bash scripts/prepare_basedpl_wasm.sh
rm -rf build/bpl
cargo build --release --target wasm32-unknown-unknown --manifest-path web/Cargo.toml
WASM=$(find . -type f -path '*/wasm32-unknown-unknown/release/basedpl_web.wasm' -print -quit)
if [ -z "$WASM" ]; then echo "ERROR: basedpl_web.wasm was not found"; exit 1; fi
wasm-bindgen "$WASM" --target web --out-dir build/bpl
cp build/bpl/basedpl_web.js jupyterlite/basedpl-kernel/src/basedpl_web.js
cp build/bpl/basedpl_web_bg.wasm jupyterlite/basedpl-kernel/src/basedpl_web_bg.wasm

echo "===STAGE:verify-example-notebooks==="
rm -rf build/diagnostic
wasm-bindgen "$WASM" --target nodejs --out-dir build/diagnostic
node scripts/verify_example_notebooks.mjs

echo "===STAGE:extension-build==="
(
  cd jupyterlite/basedpl-kernel
  npm install
  npm run build:lib
  jupyter labextension build --development True .
  pip install --no-build-isolation -q -e .
)

echo "===STAGE:site-build==="
python3 build.py

echo "===STAGE:jupyterlite-build==="
rm -rf dist/jupyterlite
(cd jupyterlite && jupyter lite build --output-dir ../dist/jupyterlite)

echo "===STAGE:serve==="
nohup python3 -m http.server "$PORT" --bind 0.0.0.0 --directory dist > /tmp/server.log 2>&1 &
SERVER_PID=$!
sleep 2
curl -sf "http://127.0.0.1:${PORT}/jupyterlite/lab/index.html" > /dev/null \
  || { echo "ERROR: static server did not come up, see /tmp/server.log"; cat /tmp/server.log; exit 1; }

if [ "$SERVE_AND_BLOCK" = true ]; then
  echo "Serving dist/ on 0.0.0.0:${PORT} (pid ${SERVER_PID}). Ctrl-C to stop."
  wait "$SERVER_PID"
  exit 0
fi

echo "===STAGE:e2e-test==="
BASE_URL="http://127.0.0.1:${PORT}/" node tests/e2e/repl.mjs
BASE_URL="http://127.0.0.1:${PORT}/" node tests/e2e/jupyterlite-glyph.mjs
BASE_URL="http://127.0.0.1:${PORT}/" node tests/e2e/example-notebooks.mjs

kill "$SERVER_PID" 2>/dev/null || true
echo "===BUILD_AND_TEST_DONE==="
