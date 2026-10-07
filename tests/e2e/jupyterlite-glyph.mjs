import { chromium } from 'playwright';

const baseUrl = process.env.BASE_URL || 'https://rahuketu86.github.io/basedpl_dynamicdocs/';
const url = new URL('jupyterlite/lab/index.html', baseUrl);
url.searchParams.set('path', 'basedpl-display-tests.ipynb');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 2048, height: 1200 } });

const openGlyph = async () => {
  const glyph = page.getByRole('menuitem', { name: 'Glyph', exact: true });
  await glyph.waitFor({ state: 'visible', timeout: 10_000 });
  await glyph.click();
};

const clickGlyphCommand = async (name) => {
  await openGlyph();
  const item = page.getByRole('menuitem', { name, exact: true });
  await item.waitFor({ state: 'visible', timeout: 5_000 });
  await item.click();
};

// Playwright's `visible` state only checks the DOM bounding box; it does not
// prove the element actually owns its pixels. JupyterLab's own top panel has
// previously painted over this button while Playwright still reported it
// visible, so assert hit-testing directly: whatever is at the button's
// center must be the button itself (or a descendant of it).
const assertOwnsCenterPixel = async (name) => {
  const button = page.getByRole('button', { name, exact: true });
  const box = await button.boundingBox();
  if (!box) throw new Error(`Button "${name}" has no bounding box`);
  const owner = await page.evaluate(({ x, y, name }) => {
    const el = document.elementFromPoint(x, y);
    const btn = el?.closest('button');
    return { tag: el?.tagName, id: el?.id, matches: btn?.textContent?.trim() === name };
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2, name });
  if (!owner.matches) {
    throw new Error(`Button "${name}" is occluded: pixel owned by <${owner.tag} id="${owner.id}">`);
  }
};

// Lumino leaves an explicit inline pixel height on #jp-header-panel as part
// of its own layout bookkeeping; a prior bug left that value stuck at
// whatever it was first fit to, so mode/visibility changes toggled CSS
// classes correctly (passing the checks above) without the actual header
// region -- and #jp-top-panel's position -- ever changing. Assert the real
// geometry, not just visibility state.
const headerHeight = () =>
  page.evaluate(() => document.querySelector('#jp-header-panel')?.getBoundingClientRect().height ?? 0);

try {
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('#jp-main-content-panel').waitFor({ state: 'visible', timeout: 60_000 });
  await page.locator('#jupyterlab-splash').waitFor({ state: 'hidden', timeout: 60_000 });
  await page.locator('#basedpl-input-widget').waitFor({ state: 'visible', timeout: 60_000 });

  const initial = await page.evaluate(() => ({
    widget: document.querySelector('#basedpl-input-widget')?.getBoundingClientRect().toJSON(),
    header: document.querySelector('#jp-header-panel')?.getBoundingClientRect().toJSON(),
    menu: document.querySelector('#jp-top-panel')?.getBoundingClientRect().toJSON(),
    barVisible: !!document.querySelector('.bpl_bar_view:not([hidden])'),
    keyboardVisible: !!document.querySelector('.bpl_keyboard_view:not([hidden])'),
  }));
  if (!initial.keyboardVisible || initial.barVisible) {
    throw new Error('Initial BasedPL view is not Keyboard-only: ' + JSON.stringify(initial));
  }
  if (!initial.widget?.height || !initial.header?.height) {
    throw new Error('BasedPL shell header has no layout height: ' + JSON.stringify(initial));
  }
  if (initial.header.top + initial.header.height > initial.menu.top + 1) {
    throw new Error('BasedPL header is not above JupyterLab menu: ' + JSON.stringify(initial));
  }
  await assertOwnsCenterPixel('Bar');
  const keyboardHeight = await headerHeight();

  await page.getByRole('button', { name: 'Bar', exact: true }).click();
  await page.locator('.bpl_bar_view').waitFor({ state: 'visible', timeout: 5_000 });
  if (await page.locator('.bpl_keyboard_view').isVisible()) {
    throw new Error('Keyboard remains visible after switching to Bar');
  }
  await assertOwnsCenterPixel('Keyboard');
  const barHeight = await headerHeight();
  if (!(barHeight < keyboardHeight)) {
    throw new Error(`Header did not shrink for Bar mode: keyboard=${keyboardHeight} bar=${barHeight}`);
  }

  await page.getByRole('button', { name: 'Keyboard', exact: true }).click();
  await page.locator('.bpl_keyboard_view').waitFor({ state: 'visible', timeout: 5_000 });
  if (await page.locator('.bpl_bar_view').isVisible()) {
    throw new Error('Bar remains visible after switching to Keyboard');
  }
  if (!((await headerHeight()) > barHeight)) {
    throw new Error(`Header did not grow back for Keyboard mode: bar=${barHeight} keyboard=${await headerHeight()}`);
  }

  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await page.locator('#basedpl-input-widget').waitFor({ state: 'hidden', timeout: 5_000 });
  if ((await headerHeight()) !== 0) {
    throw new Error(`Header did not collapse on Hide: height=${await headerHeight()}`);
  }

  await clickGlyphCommand('Show Keyboard');
  await page.locator('#basedpl-input-widget').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('.bpl_keyboard_view').waitFor({ state: 'visible', timeout: 5_000 });
  if (!((await headerHeight()) > barHeight)) {
    throw new Error(`Header did not re-expand on Glyph -> Show Keyboard: height=${await headerHeight()}`);
  }

  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await page.locator('#basedpl-input-widget').waitFor({ state: 'hidden', timeout: 5_000 });

  await clickGlyphCommand('Show Bar');
  await page.locator('#basedpl-input-widget').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('.bpl_bar_view').waitFor({ state: 'visible', timeout: 5_000 });
  if (await page.locator('.bpl_keyboard_view').isVisible()) {
    throw new Error('Keyboard remains visible after Glyph -> Show Bar');
  }
  const reshownBarHeight = await headerHeight();
  if (!(reshownBarHeight > 0 && reshownBarHeight < keyboardHeight)) {
    throw new Error(`Header wrong size on Glyph -> Show Bar: height=${reshownBarHeight}`);
  }

  console.log('JupyterLite E2E passed: shell placement, Bar/Keyboard toggle, Hide, Glyph -> Show Keyboard, Glyph -> Show Bar');
} finally {
  await browser.close();
}
