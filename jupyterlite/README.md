# BasedPL JupyterLite

This directory contains the browser-native BasedPL JupyterLite kernel.

The kernel is an adapter around the existing BplSession WASM API. It does
not contain a second APL interpreter.

The intended architecture is:

Reference / REPL / JupyterLite
        \\       |       /
             BasedPL
             Session
                |
              WASM

The first milestone is execution, MIME-aware display, completion and
persistent kernel state. The notebook keyboard and richer stdin integration
are subsequent frontend work.
