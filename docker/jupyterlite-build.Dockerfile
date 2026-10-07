# Reusable local/remote build+test environment for the BasedPL JupyterLite
# extension. Bakes in everything that's slow and doesn't change often
# (Rust + wasm-bindgen-cli, the Python/Jupyter build backend, Playwright +
# Chromium), so iterating on jupyterlite/basedpl-kernel/src/*.ts only pays
# for: clone/copy -> cargo build (wasm) -> npm build -> jupyter lite build
# -> playwright test, not a ~10 minute toolchain install every run.
#
# Build once:
#   docker build -f docker/jupyterlite-build.Dockerfile -t basedpl-jupyterlite-build .
#
# Then for each iteration, run scripts/build_and_test_jupyterlite.sh inside a
# container from this image (mount or clone the repo first) -- see that
# script for the exact steps. The versions below must stay in lockstep with:
#   - web/Cargo.toml            (wasm-bindgen = "=0.2.129")
#   - jupyterlite/requirements.txt (jupyterlab==4.5.11, jupyterlite-core==0.7.6)
#   - environment-wasm-build.yml   (the hatch build-backend trio)
#   - .github/workflows/pages.yml (playwright@1.55.0)

FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip git curl build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Rust + wasm32 target, pinned wasm-bindgen-cli matching web/Cargo.toml.
ENV RUSTUP_HOME=/opt/rust CARGO_HOME=/opt/rust PATH="/opt/rust/bin:${PATH}"
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain stable --target wasm32-unknown-unknown \
    && cargo install wasm-bindgen-cli --version 0.2.129

# Python env for the JupyterLite build (jupyterlab/jupyterlite-core versions
# must match jupyterlite/requirements.txt; hatch packages are the build
# backend required by `pip install --no-build-isolation -e .`).
ENV VIRTUAL_ENV=/opt/venv PATH="/opt/venv/bin:${PATH}"
RUN python3 -m venv /opt/venv \
    && pip install -U pip -q \
    && pip install -q \
         "jupyterlite-core[lab]==0.7.6" \
         "jupyterlab==4.5.11" \
         jupyter_server \
         "hatchling>=1.5" \
         "hatch-jupyter-builder>=0.5" \
         "hatch-nodejs-version>=0.3.2" editables

# Playwright + Chromium, pinned to the same version CI uses. Installed into
# /work/node_modules (NOT `npm install -g`) because Node's ESM resolver
# (`import ... from 'playwright'`, used by tests/e2e/*.mjs) does not consult
# NODE_PATH or global npm packages at all -- only CommonJS `require()` does.
# It does walk up parent directories looking for node_modules though, so
# putting it one level above where the repo gets cloned (/work/repo) makes
# the import resolve correctly without any extra install step per iteration.
#
# The package.json/lockfile used to install it are deleted afterwards (the
# node_modules dir itself is kept): the extension's own
# `pip install -e .` triggers hatch_jupyter_builder's `jlpm install` inside
# jupyterlite/basedpl-kernel, and Yarn walks up looking for a project root --
# a leftover /work/package.json gets misread as an ancestor monorepo root
# ("doesn't seem to be part of the project declared in /work"), which breaks
# that nested jlpm install. Node's module resolution only needs the
# node_modules directory to exist, not a package.json next to it.
WORKDIR /work
RUN npm init -y \
    && npm install playwright@1.55.0 \
    && npx playwright install --with-deps chromium \
    && rm -f package.json package-lock.json
