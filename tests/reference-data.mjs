// Checks the generated Reference/REPL/notebook glyph data against upstream, with no browser:
//   - every glyph card's docs link points at a page that exists
//   - the Mac keyboard map matches what the real typing engine (web/vendor/input.js) types, key by key
//   - JupyterLite's keyboard rows are the same rows as the Reference/REPL keyboard
//   - search still finds cards by glyph, name, function names and the old names kept in `aka`
//
//   node tests/reference-data.mjs [symbols.json]     (default: build/bpl/symbols.json)
// Without a built WASM, dump the table first:  python3 -c "import basedpl,json;print(json.dumps(basedpl.symbols))" > /tmp/symbols.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const symbolsPath = process.argv[2] || path.join(root, 'build/bpl/symbols.json');
if (!fs.existsSync(symbolsPath)) {
  console.error(`No symbol table at ${symbolsPath}. Build the WASM first, or pass a symbols.json (see the header of this file).`);
  process.exit(2);
}

const symbols = JSON.parse(fs.readFileSync(symbolsPath, 'utf8'));
const layout = JSON.parse(read('web/vendor/layout.json'));
const pages = new Set(JSON.parse(read('scripts/vendor/glyph_pages.json')));
const data = JSON.parse(/const DATA = (\{.*?\});[ \t]*\n/s.exec(read('src/index.html'))[1]);
const kernelRows = JSON.parse(/export default (.*);\s*$/s.exec(read('jupyterlite/basedpl-kernel/src/keyboard_rows.js'))[1]);
const engine = (0, eval)(read('web/vendor/input.js'))(symbols, layout);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};
const list = items => items.slice(0, 8).join(', ') + (items.length > 8 ? `, ... (${items.length})` : '');

// --- docs links ---------------------------------------------------------------------------------
const dead = data.glyphs.filter(g => !pages.has(g.slug)).map(g => `${g.glyph}->${g.slug}`);
check('every glyph card links to a docs page that exists', dead.length === 0, list(dead));
const bySymbol = new Map(symbols.map(s => [s.glyph, s]));
const wrongSlug = data.glyphs.filter(g => bySymbol.has(g.glyph) && g.slug !== bySymbol.get(g.glyph).name).map(g => g.glyph);
check("each card's slug is upstream's name for the glyph", wrongSlug.length === 0, list(wrongSlug));
const cardGlyphs = new Set(data.glyphs.map(g => g.glyph));
const missing = symbols.filter(s => !cardGlyphs.has(s.glyph)).map(s => `${s.glyph} (${s.name})`);
check('every upstream symbol has a card', missing.length === 0, list(missing));

// --- chords on the cards -------------------------------------------------------------------------
const US_SHIFT = { '`': '~', '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?' };
const SHIFTED_DIGIT = ')!@#$%^&*(';
const CODES = { '`': 'Backquote', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash',
  ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', ' ': 'Space' };
function keyEvent(key, { alt, shift }) {
  const code = /^[a-z]$/.test(key) ? 'Key' + key.toUpperCase() : /^[0-9]$/.test(key) ? 'Digit' + key : CODES[key];
  return { code, key, shiftKey: shift, altKey: alt, ctrlKey: false, metaKey: false };
}
// Press a physical key with Option (and optionally Shift). A dead key types nothing until the next key; Space then
// types its own character (upstream's documented way to do it).
function typeChord(key, shift) {
  engine.reset();
  let r = engine.press(keyEvent(key, { alt: true, shift }), true);
  let text = r?.text ?? '';
  if (text === '' && r?.stop) text = engine.press(keyEvent(' ', { alt: false, shift: false }), true)?.text ?? '';
  engine.reset();
  return text;
}

// --- keyboard map vs. the real typing engine ---------------------------------------------------
const specials = new Set(['tab', 'caps', 'shift', 'shift2', 'enter', 'delete', 'ctrl', 'ctrl2', 'cmd', 'cmd2', 'opt', 'opt2', 'space']);
const mismatches = [];
let keysChecked = 0;
for (const row of data.keyboard) {
  for (const [key, shown] of row) {
    if (specials.has(key)) continue;
    keysChecked++;
    // A key shows the primitives typed without Option (its shifted and plain character, when they have
    // a card), then [Option-Shift glyph][Option glyph] -- minus the super/subscript digits that only exist
    // as dead-key follow-ups. An unbound key just shows its own label. A chord that merely types the key's
    // own shifted character (Option-Shift-3 -> `#` in the browser, see alt_aliases) is the key passing
    // through, not a glyph.
    const shiftedChar = /^[a-z]$/.test(key) ? key.toUpperCase() : /^[0-9]$/.test(key) ? SHIFTED_DIGIT[Number(key)] : US_SHIFT[key];
    const withShift = typeChord(key, true);
    const chords = ((withShift === shiftedChar ? '' : withShift) + typeChord(key, false)).replace(/[\u00b2\u00b3\u00b9\u2070-\u209f]/g, '');
    const plain = [shiftedChar, key].filter(c => cardGlyphs.has(c) && !/[a-z0-9]/i.test(c)).join('');
    const expected = plain + chords || key;
    if (expected !== shown) mismatches.push(`${key}: map shows ${JSON.stringify(shown)}, engine types ${JSON.stringify(expected)}`);
  }
}
check(`keyboard map matches what the typing engine types (${keysChecked} keys)`, mismatches.length === 0);
mismatches.slice(0, 8).forEach(m => console.log('      ' + m));
const toolData = JSON.parse(read('reference-data.json'));
check("reference-data.json (the WebMCP agent tools' copy) is the page's data", JSON.stringify(toolData) === JSON.stringify(data));
check("JupyterLite's keyboard rows are the Reference/REPL keyboard", JSON.stringify(kernelRows) === JSON.stringify(data.keyboard));

// Every symbol's own documented chord, replayed key by key, types its glyph.
const replayBad = [];
let replayed = 0;
for (const s of symbols) {
  const keys = s.shortcut.trim().split(/\s+/).filter(Boolean);
  if (!keys.length) continue;
  const toEvent = (k, first) => {
    const lower = /^[A-Z]$/.test(k) ? k.toLowerCase() : k;
    const unshifted = Object.entries(US_SHIFT).find(([, v]) => v === k)?.[0] ?? (SHIFTED_DIGIT.includes(k) ? String(SHIFTED_DIGIT.indexOf(k)) : undefined);
    const shift = /^[A-Z]$/.test(k) || unshifted !== undefined;
    return { ...keyEvent(unshifted ?? lower, { alt: first, shift }), key: k };
  };
  engine.reset();
  replayed++;
  let out = '';
  keys.forEach((k, i) => { out += engine.press(toEvent(k, i === 0), true)?.text ?? ''; });
  if (out === '' && keys.length === 1) out = engine.press(keyEvent(' ', { alt: false, shift: false }), true)?.text ?? '';
  engine.reset();
  if (out !== s.glyph) replayBad.push(`${s.glyph} via "${s.shortcut}" typed ${JSON.stringify(out)}`);
}
check(`every symbol's chord types its glyph (${replayed} chords)`, replayBad.length === 0, list(replayBad));

// --- chord labels on the cards ----------------------------------------------------------------
const badKeys = data.glyphs.filter(g => bySymbol.has(g.glyph) && g.key !== '' && !g.key.startsWith('Alt-')).map(g => g.glyph);
check('chord labels look like Alt-...', badKeys.length === 0, list(badKeys));

// --- search (same rule as the page: lower-cased substring over these fields) -------------------
const text = g => [g.glyph, g.name, g.key, g.monad, g.dyad, g.note, g.aka].join(' ').toLowerCase();
const find = q => data.glyphs.filter(g => text(g).includes(q.toLowerCase())).map(g => g.glyph);
const unreachable = [];
for (const g of data.glyphs) {
  for (const q of [g.glyph, g.name, g.monad, g.dyad]) {
    if (q && q !== '—' && !find(q).includes(g.glyph)) unreachable.push(`${g.glyph} by ${JSON.stringify(q)}`);
  }
}
check("every card is found by its own glyph, name and function names", unreachable.length === 0, list(unreachable));
const expectations = [
  ['floor', '⌊'], ['ceiling', '⌈'], ['dash', '-'], ['mul', '×'], ['add', '+'], ['gcd', '∨'], ['lcm', '∧'], ['reduce', '/'],
  ['assignment', '←'], ['nand', '⊼'], ['nor', '⊽'], ['⍲', '⊼'], ['⍱', '⊽'], ['pipe', '↦'], ['→', '↦'], ['lamp', '⍝'], ['comment', '⍝'],
  ['downstile', '⌊'], ['iota', '⍳'], ['scan', '\\'], ['stile', '|'], ['注', '⍝'],
];
const lost = expectations.filter(([q, glyph]) => !find(q).includes(glyph)).map(([q, glyph]) => `${JSON.stringify(q)} -> ${glyph}`);
check('search still finds cards by old names, descriptions and retired glyphs', lost.length === 0, list(lost));

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
