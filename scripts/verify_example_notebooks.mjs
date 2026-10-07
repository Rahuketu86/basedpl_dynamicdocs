import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { BplSession } from '../build/diagnostic/basedpl_web.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(repoRoot, 'jupyterlite/files/examples');
let failures = 0;
let skipped = 0;

// `•nget`/`•nput`/`•load`/`•image "path"` go through host_web.rs's
// XMLHttpRequest-based file reader, which needs a browser DOM global that
// plain Node doesn't have (no `configure_browser` host, no
// `XMLHttpRequest`). `•plot` panics under plain Node too (confirmed: a hard
// `unreachable` WASM trap, not a graceful BPL error) -- it likely needs a
// DOM canvas for text-label layout. This script's nodejs-target BplSession
// can't exercise any of these; they're only exercised for real by the
// browser-based Playwright E2E run against the built site.
const BROWSER_ONLY = /•nget|•nput|•load|•plot|•image\s*"/;

for (const name of readdirSync(dir).sort()) {
  if (!name.endsWith('.ipynb')) continue;
  const nb = JSON.parse(readFileSync(`${dir}/${name}`, 'utf8'));
  const session = new BplSession();
  let cellNum = 0;
  // Names assigned by a skipped (browser-only) cell. A later cell that
  // references one of these would fail on "undefined name", not because of
  // an actual bug -- e.g. xml.ipynb's image-processing pipeline is a linear
  // chain of variables from one `•image "path"` read. This is narrower than
  // skipping the rest of the notebook outright: data.ipynb's independent
  // JSON/CSV sections after its own file-read cells don't reference `sales`/
  // `text` again, so they still get checked for real.
  const taintedNames = new Set();
  const assignedNames = code => [...code.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*←/g)].map(m => m[1]);
  const referencesTainted = code => [...taintedNames].some(n => new RegExp(`(?<![A-Za-z0-9_])${n}(?![A-Za-z0-9_])`).test(code));
  for (const cell of nb.cells) {
    if (cell.cell_type !== 'code') continue;
    cellNum++;
    const code = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
    if (!code.trim()) continue;
    if (BROWSER_ONLY.test(code) || referencesTainted(code)) {
      for (const n of assignedNames(code)) taintedNames.add(n);
      skipped++;
      continue;
    }
    // A WASM panic (not just a graceful BPL `result.error`) throws here --
    // catch it so one bad cell doesn't abort the whole run before the other
    // notebooks get checked.
    try {
      const result = JSON.parse(session.eval(code));
      if (result.error) {
        failures++;
        console.log(`FAIL ${name} cell#${cellNum}: ${JSON.stringify(code)}\n  -> ${result.error}`);
      }
    } catch (e) {
      failures++;
      console.log(`PANIC ${name} cell#${cellNum}: ${JSON.stringify(code)}\n  -> ${e}`);
    }
  }
  console.log(`${name}: ${cellNum} code cells checked`);
}

console.log(`(${skipped} browser-only cell(s) skipped (file I/O / •plot), see tests/e2e/example-notebooks.mjs)`);
console.log(failures === 0 ? 'ALL NOTEBOOK CELLS OK' : `${failures} CELL(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
