// Browser check of the generated glyph data on all three surfaces -- the Reference tab, the REPL and
// the JupyterLite notebook page -- against what upstream says (see tests/reference-data.mjs for the
// browser-free checks). Run it against a local build or the deployed site:
//   BASE_URL=http://127.0.0.1:8899/ node tests/e2e/reference.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseUrl = process.env.BASE_URL || 'https://rahuketu86.github.io/basedpl_dynamicdocs/';
const pages = new Set(JSON.parse(fs.readFileSync(path.join(root, 'scripts/vendor/glyph_pages.json'), 'utf8')));
const SPECIAL = new Set(['tab', 'caps', 'shift', 'shift2', 'enter', 'delete', 'ctrl', 'ctrl2', 'cmd', 'cmd2', 'opt', 'opt2', 'space']);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1800, height: 1100 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

try {
  // --- Reference tab -------------------------------------------------------------------------
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#glyphGrid .glyph-card').first().waitFor({ timeout: 30_000 });
  const data = await page.evaluate(() => DATA);

  const cards = await page.locator('#glyphGrid .glyph-card').count();
  check('Reference tab shows a card per glyph', cards === data.glyphs.length, `(${cards}/${data.glyphs.length})`);

  // Every card's link, built by the page's own sourceFor(), points at a docs page that exists.
  const links = await page.evaluate(() => DATA.glyphs.map(g => [g.glyph, sourceFor(g)]));
  const deadLinks = links.filter(([, url]) => {
    const m = /\/glyphs\/([^/]+)\.html$/.exec(url);
    return !m || !pages.has(decodeURIComponent(m[1]));
  }).map(([glyph, url]) => `${glyph} ${url}`);
  check("every card's docs link points at a page upstream has", deadLinks.length === 0, deadLinks.slice(0, 5).join(' | '));

  // Search, driven the way a user does it.
  const searchHits = async q => {
    await page.fill('#search', q);
    return page.locator('#glyphGrid .glyph-card').evaluateAll(els => els.map(e => e.dataset.g));
  };
  for (const [q, glyph] of [['floor', '⌊'], ['downstile', '⌊'], ['dash', '-'], ['gcd', '∨'], ['nand', '⊼'], ['⍲', '⊼'], ['lamp', '⍝'],
                            ['comment', '⍝'], ['assignment', '←'], ['reduce', '/']]) {
    const hits = await searchHits(q);
    check(`search "${q}" finds ${glyph}`, hits.includes(glyph), `(got ${hits.slice(0, 6).join(' ')})`);
  }
  await page.fill('#search', '');
  await page.locator('#glyphGrid .glyph-card').first().waitFor();

  // Opening a card points the drawer's link at the right docs page.
  await page.fill('#search', '⌊');
  await page.locator('#glyphGrid .glyph-card[data-g="⌊"]').click();
  const href = await page.locator('#sourceLink').getAttribute('href');
  check('opening ⌊ links to its docs page', href === 'https://answerdotai.github.io/basedpl/glyphs/downstile.html', href ?? '');
  await page.fill('#search', '');

  // Reference keyboard: one button per key of the generated map, showing what upstream's map shows.
  const refKeys = await page.evaluate(() => [...document.querySelectorAll('#keyboard .key')].map(k => [
    k.querySelector('.ordinary')?.textContent ?? '', k.querySelector('.glyph')?.textContent ?? '']));
  const expectedKeys = data.keyboard.flat();
  check('Reference keyboard has every key of the generated map', refKeys.length === expectedKeys.length, `(${refKeys.length}/${expectedKeys.length})`);
  const keyL = refKeys.find(([ordinary]) => ordinary === 'l');
  check('Reference keyboard: Option-l is ↦ (was → before the upstream update)', keyL?.[1] === '↦', JSON.stringify(keyL));

  // --- REPL -----------------------------------------------------------------------------------
  await page.getByRole('button', { name: 'REPL' }).click();
  await page.locator('#kbMacBtn').click();
  const replKeys = await page.evaluate(() => [...document.querySelectorAll('#replMacKeyboard .mac-key')].map(k => [
    k.querySelector('.mac-label')?.textContent ?? '', k.querySelector('.mac-glyph')?.textContent ?? '']));
  check('REPL keyboard has every key of the generated map', replKeys.length === expectedKeys.length, `(${replKeys.length}/${expectedKeys.length})`);
  const target = page.locator('#replMacKeyboard .mac-glyph-target[data-glyph="↦"]').first();
  await target.waitFor({ timeout: 10_000 });
  await target.click();
  check('REPL keyboard: clicking ↦ inserts it', (await page.inputValue('#replInput')).includes('↦'));
  // The bar is the first 56 short glyphs of the cards, so it follows the generated data: new glyphs that
  // fall inside it show up, retired ones are gone.
  const barGlyphs = await page.locator('#replBar .rkey').evaluateAll(els => els.map(e => e.dataset.glyph));
  check('REPL glyph bar offers the new ⊼ ⊽ and none of the retired ⍲ ⍱ →',
    ['⊼', '⊽'].every(g => barGlyphs.includes(g)) && ['⍲', '⍱', '→'].every(g => !barGlyphs.includes(g)), barGlyphs.join(''));

  // --- Notebook page (JupyterLite) ------------------------------------------------------------
  const lite = await context.newPage();
  lite.on('pageerror', e => errors.push('notebook: ' + String(e)));
  await lite.goto(new URL('jupyterlite/lab/index.html?path=basedpl-display-tests.ipynb', baseUrl).toString(), { waitUntil: 'domcontentloaded' });
  await lite.locator('.bpl_key').first().waitFor({ state: 'attached', timeout: 90_000 });
  const liteKeys = await lite.evaluate(() => Object.fromEntries([...document.querySelectorAll('.bpl_key')].map(k => [
    k.dataset.key, k.querySelector('.bpl_glyphs')?.textContent ?? ''])));
  const wrong = data.keyboard.flat().filter(([key]) => !SPECIAL.has(key)).filter(([key, shown]) => liteKeys[key] !== shown)
    .map(([key, shown]) => `${key}: notebook ${JSON.stringify(liteKeys[key])} vs ${JSON.stringify(shown)}`);
  check('notebook keyboard shows the same glyphs as the Reference/REPL keyboard, key by key', wrong.length === 0, wrong.slice(0, 4).join(' | '));
  check('notebook keyboard: Option-l is ↦', liteKeys['l'] === '↦', JSON.stringify(liteKeys['l']));

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (error) {
  console.error('E2E ERROR:', error);
  failures++;
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nReference E2E passed: Reference tab, REPL and notebook page');
process.exit(failures ? 1 : 0);
