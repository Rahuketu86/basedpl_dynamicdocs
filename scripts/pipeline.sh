#!/usr/bin/env bash
set -euo pipefail

# Builds and tests the whole project (WASM + REPL + JupyterLite extension +
# site + all e2e suites) inside Docker, the same way this repo's CI and this
# project's own development loop do -- runnable on any machine with Docker
# (this repo's own Mac, a beefier remote box, etc.), with no other local
# toolchain required (no Rust, no wasm-bindgen, no Node, no Python).
#
# First run builds docker/jupyterlite-build.Dockerfile (slow: Rust +
# wasm-bindgen-cli + the Python/Jupyter build backend + Playwright/Chromium).
# Every run after that reuses the same long-lived container and its build
# caches (cargo's target/, node_modules/), so re-running after a small code
# change only rebuilds what actually changed -- the full from-scratch build
# took 15-20+ minutes during development; an incremental rebuild of just this
# project's own small crates/TS is a fraction of that.
#
# Usage:
#   scripts/pipeline.sh              # build once, run the full e2e suite, exit
#   scripts/pipeline.sh --serve      # build, then serve on :8899 and block (Ctrl-C to stop)
#   scripts/pipeline.sh --serve 9000 # build, then serve on a different port
#   scripts/pipeline.sh --reset      # remove the container (fresh image/caches next run)
#
# The container keeps running (detached, `sleep infinity`) between invocations
# so its build caches persist -- it is NOT removed after a normal run. Remove
# it explicitly with --reset if you want a truly clean rebuild, or `docker rm
# -f basedpl-pipeline` directly.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="basedpl-jupyterlite-build"
CONTAINER="basedpl-pipeline"
PORT="8899"

MODE="test"
if [[ "${1:-}" == "--serve" ]]; then
  MODE="serve"
  PORT="${2:-8899}"
elif [[ "${1:-}" == "--reset" ]]; then
  echo "Removing container '$CONTAINER' (image '$IMAGE' is kept; delete it yourself with 'docker rmi $IMAGE' if you also want a clean image rebuild)..."
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "Done."
  exit 0
fi

cd "$REPO_ROOT"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "==> Building $IMAGE (first run only -- this is the slow one)"
  docker build -f docker/jupyterlite-build.Dockerfile -t "$IMAGE" .
fi

if ! docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "==> Creating container '$CONTAINER' (port $PORT mapped for --serve)"
  docker run -d --name "$CONTAINER" -p "${PORT}:${PORT}" "$IMAGE" sleep infinity
elif [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" != "true" ]]; then
  echo "==> Starting existing container '$CONTAINER'"
  docker start "$CONTAINER" >/dev/null
fi

echo "==> Syncing working tree into the container"
tar \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='build' \
  --exclude='dist' \
  --exclude='jupyterlite/basedpl-kernel/node_modules' \
  --exclude='jupyterlite/basedpl-kernel/lib' \
  --exclude='jupyterlite/basedpl-kernel/jupyterlite_basedpl_kernel' \
  -cf - . | docker exec -i "$CONTAINER" sh -c 'mkdir -p /work/repo && tar -xf - -C /work/repo'

if [[ "$MODE" == "serve" ]]; then
  echo "==> Building, then serving on http://localhost:${PORT}/ (Ctrl-C to stop)"
  # A plain (non-login) shell -- `sh -lc` sources /etc/profile, which resets
  # PATH and drops the image's venv (`jupyter` etc.) off it. Confirmed the
  # hard way during development: silent "jupyter: command not found" failures.
  exec docker exec -i "$CONTAINER" sh -c "cd /work/repo && bash scripts/build_and_test_jupyterlite.sh --serve-only-port ${PORT}"
else
  echo "==> Building and running the full e2e suite"
  docker exec "$CONTAINER" sh -c "cd /work/repo && bash scripts/build_and_test_jupyterlite.sh"
  echo "==> Done. Container '$CONTAINER' is left running (build caches persist) -- re-run this script anytime, or 'scripts/pipeline.sh --reset' to remove it."
fi
