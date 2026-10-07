import { chromium } from 'playwright';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Runs every notebook in jupyterlite/files/examples/ end-to-end in a real
// browser (unlike scripts/verify_example_notebooks.mjs, which can't exercise
// •plot -- that panics under plain Node, apparently needing a DOM for text
// layout). This is the only check that runs the full notebooks for real.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const examplesDir = join(repoRoot, 'jupyterlite/files/examples');
const baseUrl = process.env.BASE_URL || 'https://rahuketu86.github.io/basedpl_dynamicdocs/';

const notebooks = readdirSync(examplesDir).filter(f => f.endsWith('.ipynb')).sort();

const browser = await chromium.launch({ headless: true });
let failures = 0;

try {
  for (const name of notebooks) {
    const nb = JSON.parse(readFileSync(join(examplesDir, name), 'utf8'));
    const cellCount = nb.cells.length;
    console.log(`${name}: starting (${cellCount} cells)`);

    // A fresh, isolated context per notebook -- not just a fresh page.
    // JupyterLite persists the previously-open tab layout in IndexedDB
    // across loads (a documented "workspace" feature); reusing one page
    // across notebooks left the *previous* notebook's tab restored and
    // focused on top, leaving the new notebook's cells present in the DOM
    // but genuinely hidden behind it, however long we waited.
    const context = await browser.newContext({ viewport: { width: 2048, height: 1200 } });
    try {
      const page = await context.newPage();
      const consoleErrors = [];
      const workerUrls = [];
      page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
      page.on('pageerror', err => consoleErrors.push(`pageerror: ${err.message}`));
      // `page.on('pageerror')` only covers the main frame; an uncaught
      // exception thrown inside a dedicated Worker might not surface there
      // at all. Track which workers actually get created, at least, so we
      // can tell whether the BasedPL kernel class runs in its own worker
      // (as opposed to just spawning one itself, which it also does).
      page.on('worker', w => workerUrls.push(w.url()));

      const url = new URL('jupyterlite/lab/index.html', baseUrl);
      url.searchParams.set('path', `examples/${name}`);
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.locator('#jp-main-content-panel').waitFor({ state: 'visible', timeout: 60_000 });
      await page.locator('#jupyterlab-splash').waitFor({ state: 'hidden', timeout: 60_000 });
      await page.locator('.jp-Cell').first().waitFor({ state: 'visible', timeout: 60_000 });

      // Click the first cell to focus the notebook, then Shift+Enter through
      // every cell (code cells execute and advance; markdown cells just
      // render and advance). This is more robust than driving the Run menu --
      // it's the same interaction path a person actually uses, with no
      // dependency on exact menu wording or menu/focus timing.
      await page.locator('.jp-Cell').first().click();
      for (let i = 0; i < cellCount; i++) {
        await page.keyboard.press('Shift+Enter');
      }

      // Wait for the kernel to finish: the status bar reads "BasedPL | Idle"
      // once done -- as one combined text node, not an isolated "Idle"
      // element, so this has to be a substring check, not an exact match. A
      // notebook this size (up to ~40 cells, each its own keypress plus
      // Playwright's actionability wait) can take a while, on top of the WASM
      // kernel's own first-run startup cost (seen reading "Initializing").
      await page.waitForTimeout(3_000);
      try {
        await page.waitForFunction(
          () => document.querySelector('#jp-main-statusbar')?.textContent?.includes('| Idle'),
          { timeout: 90_000 }
        );
      } catch (e) {
        failures++;
        const statusBar = await page.locator('#jp-main-statusbar').textContent().catch(() => '(unavailable)');
        console.log(`FAIL ${name}: never reached Idle -- status bar: ${JSON.stringify(statusBar)}`);
        console.log(`  console/page errors: ${JSON.stringify(consoleErrors.slice(0, 10))}`);
        console.log(`  workers spawned: ${JSON.stringify(workerUrls)}`);
        await page.screenshot({ path: `/tmp/example-notebook-timeout-${name}.png` }).catch(() => {});
        continue;
      }

      const errorText = await page.evaluate(() => {
        const hit = Array.from(document.querySelectorAll('.jp-OutputArea-output'))
          .find(el => el.textContent?.includes('BasedPLKernelError'));
        return hit ? hit.textContent.slice(0, 300) : null;
      });

      if (errorText) {
        failures++;
        console.log(`FAIL ${name}: ${errorText}`);
      } else {
        console.log(`${name}: all cells ran without error`);
      }
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}

console.log(failures === 0 ? 'ALL EXAMPLE NOTEBOOKS OK' : `${failures} NOTEBOOK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
