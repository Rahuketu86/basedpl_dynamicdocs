import { chromium } from 'playwright';

const baseUrl = process.env.BASE_URL || 'https://rahuketu86.github.io/basedpl_dynamicdocs/';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  // The REPL starts its worker on page load, but switch explicitly to the
  // REPL tab so this test exercises the same UI a user sees.
  await page.getByRole('button', { name: 'REPL' }).click();
  await page.locator('#replState').waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => document.querySelector('#replState')?.textContent?.includes('WASM ready'),
    null,
    { timeout: 30_000 }
  );

  const input = page.locator('#replInput');
  const outputs = page.locator('.term-output');

  const cases = [
    ['3', '3'],
    ['2+4', '6'],
    ['⍳5', '0 1 2 3 4'],
    ['+/ 1 2 3', '6'],
  ];

  for (let i = 0; i < cases.length; i += 1) {
    const [code, expected] = cases[i];
    const before = await outputs.count();
    await input.fill(code);
    await input.press('Enter');

    await page.waitForFunction(
      ({ count }) => Number.parseInt(document.querySelector('#replCount')?.textContent || '0', 10) >= count,
      { count: i + 1 },
      { timeout: 15_000 }
    );

    await page.waitForFunction(
      ({ count }) => document.querySelectorAll('.term-output').length >= count,
      { count: before + 1 },
      { timeout: 5_000 }
    );

    const result = outputs.last();
    await result.waitFor({ state: 'visible', timeout: 5_000 });

    const text = (await result.textContent())?.trim() || '';
    if (text !== expected) {
      throw new Error(`Unexpected visible output for ${JSON.stringify(code)}: got ${JSON.stringify(text)}, expected ${JSON.stringify(expected)}`);
    }
  }

  await page.locator('#kbMacBtn').click();
  await page.locator('.mac-glyph-target[data-glyph="⍳"]').click();
  if (await input.inputValue() !== '⍳') {
    throw new Error(`Mac keyboard did not insert ⍳: got ${JSON.stringify(await input.inputValue())}`);
  }
  await input.type('5');
  if (await input.inputValue() !== '⍳5') {
    throw new Error(`Mac keyboard did not preserve glyph input: got ${JSON.stringify(await input.inputValue())}`);
  }
  await input.press('Enter');
  await page.waitForFunction(
    ({ count }) => document.querySelectorAll('.term-output').length >= count,
    { count: cases.length + 1 },
    { timeout: 15_000 }
  );
  const keyboardResult = outputs.last();
  const keyboardText = (await keyboardResult.textContent())?.trim() || '';
  if (keyboardText !== '0 1 2 3 4') {
    throw new Error(`Unexpected Mac keyboard output: got ${JSON.stringify(keyboardText)}`);
  }

  console.log('Browser E2E passed: bar + Mac keyboard, 3, 2+4, ⍳5, +/ 1 2 3');
} finally {
  await browser.close();
}
