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

try {
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('#jp-main-content-panel').waitFor({ state: 'visible', timeout: 60_000 });
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

  await page.getByRole('button', { name: 'Bar', exact: true }).click();
  await page.locator('.bpl_bar_view').waitFor({ state: 'visible', timeout: 5_000 });
  if (await page.locator('.bpl_keyboard_view').isVisible()) {
    throw new Error('Keyboard remains visible after switching to Bar');
  }

  await page.getByRole('button', { name: 'Keyboard', exact: true }).click();
  await page.locator('.bpl_keyboard_view').waitFor({ state: 'visible', timeout: 5_000 });
  if (await page.locator('.bpl_bar_view').isVisible()) {
    throw new Error('Bar remains visible after switching to Keyboard');
  }

  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await page.locator('#basedpl-input-widget').waitFor({ state: 'hidden', timeout: 5_000 });

  await clickGlyphCommand('Show Keyboard');
  await page.locator('#basedpl-input-widget').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('.bpl_keyboard_view').waitFor({ state: 'visible', timeout: 5_000 });

  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await page.locator('#basedpl-input-widget').waitFor({ state: 'hidden', timeout: 5_000 });

  await clickGlyphCommand('Show Bar');
  await page.locator('#basedpl-input-widget').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('.bpl_bar_view').waitFor({ state: 'visible', timeout: 5_000 });
  if (await page.locator('.bpl_keyboard_view').isVisible()) {
    throw new Error('Keyboard remains visible after Glyph -> Show Bar');
  }

  console.log('JupyterLite E2E passed: shell placement, Bar/Keyboard toggle, Hide, Glyph -> Show Keyboard, Glyph -> Show Bar');
} finally {
  await browser.close();
}
