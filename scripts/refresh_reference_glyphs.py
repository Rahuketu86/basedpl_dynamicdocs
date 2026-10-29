#!/usr/bin/env python3
"""Generate the Reference/REPL/notebook glyph data from upstream BasedPL instead of by hand.

What was hand-written, and drifted from the language (dead docs links, stale chords, retired
glyphs), is now derived from the pinned upstream revision:

  * glyph cards (DATA.glyphs in src/index.html): name, docs slug, Option-key chord and function
    names from BasedPL's own symbol table; the docs slug is checked against the real docs pages.
  * the Mac keyboard map (DATA.keyboard) and dead-key follow-ups (DATA.followups): built by
    upstream's own keyboards.py (vendored by prepare_basedpl_wasm.sh) from layout.json -- the same
    code that produces upstream's docs keyboard page.
  * JupyterLite's keyboard (jupyterlite/basedpl-kernel/src/keyboard_rows.js): the same rows.
  * reference-data.json, the copy of all of the above that the WebMCP agent tools fetch.

Hand-written text is kept where upstream has none (operator and syntax descriptions, notes), and
the examples. Old names and descriptions stay searchable through a hidden `aka` field, so
searching "floor", "dash" or a retired glyph still finds its card.

    python3 scripts/refresh_reference_glyphs.py           # rewrite src/index.html + keyboard_rows.js
    python3 scripts/refresh_reference_glyphs.py --check   # exit 1 if they are out of date / a link is dead
    python3 scripts/refresh_reference_glyphs.py --build   # CI: write build/reference.json for build.py

Symbols come from build/bpl/symbols.json (dumped by the WASM build) when present, else from the
installed `basedpl` package, else pass --symbols-json. Re-vendor the inputs with
scripts/prepare_basedpl_wasm.sh whenever the pinned REV changes.
"""
import argparse
import importlib.util
import json
import unicodedata
import re
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "src" / "index.html"
VENDOR = ROOT / "scripts" / "vendor"
LAYOUT = ROOT / "web" / "vendor" / "layout.json"
KERNEL_ROWS = ROOT / "jupyterlite" / "basedpl-kernel" / "src" / "keyboard_rows.js"
# The same data as the page's DATA, served to the WebMCP agent tools (see build.py).
REFERENCE_DATA = ROOT / "reference-data.json"
SYMBOLS_FROM_BUILD = ROOT / "build" / "bpl" / "symbols.json"
REFERENCE_JSON = ROOT / "build" / "reference.json"

# Glyphs upstream retired, mapped to the glyph that replaced them (same meaning), so a card keeps
# its place in the list and stays findable by its old name and character.
SUCCESSORS = {"⍲": "⊼", "⍱": "⊽", "→": "↦"}
# New upstream glyphs that belong next to an existing card rather than at the end.
INSERT_BEFORE = {"|": "\\"}
# Old cards whose hand-written text described a different glyph (the "stile" text sat on `\`).
NO_INHERIT = {"\\"}
# Shifted US-keyboard characters -> the key they are typed on (matches input.js's usKey()).
US_SHIFTED = {**{c: str(i) for i, c in enumerate(")!@#$%^&*(")}, "_": "-", "+": "=", "~": "`", ":": ";",
              '"': "'", "<": ",", ">": ".", "?": "/", "{": "[", "}": "]", "|": "\\"}
# Keyboard-map key ids the page's renderers know, by macOS key code.
KEY_IDS = {48: "tab", 57: "caps", 56: "shift", 60: "shift2", 59: "ctrl", 62: "ctrl2", 58: "opt", 61: "opt2",
           55: "cmd", 54: "cmd2", 49: "space", 51: "delete", 36: "enter"}


def key_name(key):
    if key.isalpha() and key.isupper():
        return "Shift-" + key.lower()
    if key in US_SHIFTED:
        base = US_SHIFTED[key]
        return "Shift-" + ("Minus" if base == "-" else base)
    return "Minus" if key == "-" else key


def chord_label(shortcut):
    """' o 8' -> 'Alt-o 8'; ' +' -> 'Alt-Shift-='; '' (a plain ASCII glyph) -> ''."""
    keys = shortcut.split()
    if not keys:
        return ""
    return " ".join(["Alt-" + key_name(keys[0])] + [key_name(k) for k in keys[1:]])


def load_symbols(path):
    if path or SYMBOLS_FROM_BUILD.exists():
        return json.loads(Path(path or SYMBOLS_FROM_BUILD).read_text(encoding="utf-8"))
    try:
        import basedpl
    except ImportError:
        sys.exit("No symbol table. Build the WASM first (it writes build/bpl/symbols.json), "
                 "`pip install basedpl`, or pass --symbols-json.")
    return list(basedpl.symbols)


def load_keyboards():
    """Upstream's keyboards.py, vendored into this repo by prepare_basedpl_wasm.sh.

    Since 0.1.81 it does `from .assets import GENERATED`: the folder its macOS keyboard bundles are written to. This
    script only reads its key maps, so it loads the file as part of a stand-in package that has just that name."""
    path = VENDOR / "keyboards.py"
    if not path.exists():
        sys.exit(f"{path} is missing. Run `bash scripts/prepare_basedpl_wasm.sh` first.")
    package = types.ModuleType("bpl_upstream")
    package.__path__ = []
    assets = types.ModuleType("bpl_upstream.assets")
    assets.GENERATED = Path("python/basedpl/assets")
    sys.modules.update({"bpl_upstream": package, "bpl_upstream.assets": assets})
    spec = importlib.util.spec_from_file_location("bpl_upstream.keyboards", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def keyboard_rows(kb, layout, card_glyphs):
    """The US keyboard map: [key id, shown glyphs, ''].

    Each key shows what upstream's docs keyboard shows for it (Option-Shift glyph, then Option glyph),
    minus the superscript/subscript digits that only exist as dead-key follow-ups (they are listed in the
    follow-up table), plus the primitives typed with no Option at all -- `+` on the `=` key, `<` and `,`
    on the comma key -- when they have a glyph card, so every glyph a user can click has a key."""
    base = kb.bases()["us"]
    # The native macOS layout and the browser differ in one place, which upstream's docs note
    # ("In the browser, Option-Shift-3 remains `#`"): the engine aliases the characters in
    # layout["alt_aliases"] back to themselves. These keyboards are browser UIs, so omit those chords.
    browser_aliased = set(layout["alt_aliases"].values())
    bindings = {chord: layout["option"][char] for char, chord in kb.shortcuts(layout, "us", base).items()
                if char not in browser_aliased}

    def glyph(value):
        return layout["states"][value["state"]]["terminator"] if isinstance(value, dict) else value

    rows = []
    for row in kb.GRID:
        cells = []
        for code in row:
            if code in kb.LABELS:
                cells.append([KEY_IDS[code], kb.LABELS[code], ""])
                continue
            label = base["keys"][str(code)][kb.PLAIN]
            option = "".join(glyph(bindings[(code, mod)]) for mod in (kb.OPTION_SHIFT, kb.OPTION) if (code, mod) in bindings)
            option = "".join(c for c in option if not unicodedata.name(c, "").startswith(("SUPERSCRIPT", "SUBSCRIPT")))
            typed = "".join(c for c in (base["keys"][str(code)][kb.SHIFT], label) if c in card_glyphs and not c.isalnum())
            cells.append([label, typed + option or label, ""])
        rows.append(cells)
    return rows


def followup_rows(layout):
    """Dead keys and what each follow-up key types, as upstream's docs dead-key table lists them."""
    def followups(name, prefix=""):
        keys = layout["states"][name]["keys"]
        digits = all(isinstance(keys.get(str(i)), str) for i in range(10))
        if digits:
            yield prefix + "0–9", keys["0"] + "–" + keys["9"]
        for key, value in keys.items():
            if keys.get(layout["unshifted"].get(key)) == value:
                continue
            if digits and key in "0123456789":
                continue
            if isinstance(value, dict):
                yield from followups(value["state"], prefix + key)
            else:
                yield prefix + key, value

    rows = []
    for key, value in layout["option"].items():
        if not isinstance(value, dict):
            continue
        groups = {}
        for sequence, result in followups(value["state"]):
            groups.setdefault(result, []).append(sequence)
        text = " · ".join("/".join(keys) + "→" + result for result, keys in groups.items())
        rows.append([key, layout["states"][value["state"]]["terminator"], text])
    return rows


def glyph_cards(old, rows, pages):
    old_by_glyph = {g["glyph"]: g for g in old}
    replaced, dropped = [], []

    def card(glyph, base=None, retired=None):
        row = rows[glyph]
        base = {} if glyph in NO_INHERIT else (base or {})
        if row["kind"] == "function":
            # Upstream's names are authoritative for functions.
            monad, dyad = row["monad"], row["dyad"]
        else:
            # Operators, syntax and arguments: upstream gives terse names, we keep the descriptions.
            monad, dyad = base.get("monad") or row["monad"], base.get("dyad") or row["dyad"]
        entry = {"glyph": glyph, "name": row["name"], "key": chord_label(row["shortcut"]), "monad": monad,
                 "dyad": dyad, "note": base.get("note", ""), "slug": row["name"]}
        # Hidden, search-only: everything that used to find this card, plus upstream's other names.
        visible = " ".join([glyph, entry["name"], entry["key"], monad, dyad, entry["note"]]).lower()
        tokens = [base.get("aka", ""), base.get("name", ""), base.get("monad", ""), base.get("dyad", ""), retired or "",
                  row["monad"], row["dyad"], *row.get("hanzi", [])]
        aka = []
        for token in tokens:
            token = (token or "").strip()
            # Substring, not equality, so re-running over an already-generated `aka` (stored as one
            # joined string) adds nothing -- the output must be stable or --check never goes clean.
            if token and token != "—" and token.lower() not in visible and token.lower() not in " ".join(aka).lower():
                aka.append(token)
        entry["aka"] = " ".join(aka)
        return entry

    new_glyphs = [g for g in rows if g not in old_by_glyph and g not in SUCCESSORS.values()]
    out, placed = [], set()

    def emit(entry):
        if entry["glyph"] not in placed:
            placed.add(entry["glyph"])
            out.append(entry)

    for entry in old:
        glyph = entry["glyph"]
        for new in [n for n in new_glyphs if INSERT_BEFORE.get(n) == glyph]:
            emit(card(new))
        if glyph in SUCCESSORS and SUCCESSORS[glyph] in rows:
            replaced.append(f"{glyph} -> {SUCCESSORS[glyph]}")
            emit(card(SUCCESSORS[glyph], entry, retired=glyph))
        elif glyph in rows:
            emit(card(glyph, entry))
        elif entry.get("slug") in pages:
            emit(entry)  # not a symbol row, but its docs page exists (e.g. `::` error-guard): keep as-is
        else:
            dropped.append(f"{glyph} ({entry['name']})")
    for new in new_glyphs:
        emit(card(new))
    added = [g for g in new_glyphs if g in placed]
    return out, {"replaced": replaced, "added": added, "dropped": dropped}


def generate(data, rows, pages, layout, kb):
    cards, report = glyph_cards(data["glyphs"], rows, pages)
    reference = {"glyphs": cards, "keyboard": keyboard_rows(kb, layout, {c["glyph"] for c in cards}), "followups": followup_rows(layout)}
    shown = {glyph for entry in cards for glyph in entry["glyph"]}
    problems = [f"docs link has no page: {c['glyph']} -> {c['slug']}" for c in cards if c["slug"] not in pages]
    problems += [f"examples for a glyph with no card: {g}" for g in data.get("examples", {}) if g not in shown]
    return reference, report, problems


DATA_RE = re.compile(r"(const DATA = )(\{.*?\})(;[ \t]*\n)", re.S)


def read_data(html):
    m = DATA_RE.search(html)
    if not m:
        sys.exit("Could not find `const DATA = {...};` in src/index.html")
    return json.loads(m.group(2))


def apply_reference(html, reference):
    """Put generated glyphs/keyboard/followups into a page's DATA, keeping its examples."""
    m = DATA_RE.search(html)
    data = {**json.loads(m.group(2)), **reference}
    return html[:m.start(2)] + json.dumps(data, ensure_ascii=False) + html[m.end(2):]


def reference_data_text(data):
    """reference-data.json is the page's whole DATA object, pretty-printed (its existing layout)."""
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def kernel_rows_js(keyboard):
    return "export default " + json.dumps(keyboard, ensure_ascii=False) + ";\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="don't write; exit 1 if out of date or a link is dead")
    mode.add_argument("--build", action="store_true", help="CI: write build/reference.json and keyboard_rows.js only")
    ap.add_argument("--symbols-json", help="symbol table JSON (default: build/bpl/symbols.json, else `basedpl`)")
    args = ap.parse_args()

    pages_file = VENDOR / "glyph_pages.json"
    if not pages_file.exists():
        sys.exit(f"{pages_file} is missing. Run `bash scripts/prepare_basedpl_wasm.sh` first.")
    pages = set(json.loads(pages_file.read_text(encoding="utf-8")))
    rows = {r["glyph"]: r for r in load_symbols(args.symbols_json)}
    layout = json.loads(LAYOUT.read_text(encoding="utf-8"))

    html = HTML.read_text(encoding="utf-8")
    reference, report, problems = generate(read_data(html), rows, pages, layout, load_keyboards())

    print(f"{len(reference['glyphs'])} glyph cards; upstream has {len(rows)} symbols and {len(pages)} docs pages")
    for label in ("replaced", "added", "dropped"):
        if report[label]:
            print(f"  {label}: {', '.join(report[label])}")
    for p in problems:
        print("  PROBLEM:", p)

    new_html = apply_reference(html, reference)
    new_rows = kernel_rows_js(reference["keyboard"])
    old_rows = KERNEL_ROWS.read_text(encoding="utf-8") if KERNEL_ROWS.exists() else ""
    new_ref = reference_data_text(read_data(new_html))
    old_ref = REFERENCE_DATA.read_text(encoding="utf-8") if REFERENCE_DATA.exists() else ""

    if args.build:
        if problems:
            sys.exit(1)
        REFERENCE_JSON.parent.mkdir(parents=True, exist_ok=True)
        REFERENCE_JSON.write_text(json.dumps(reference, ensure_ascii=False), encoding="utf-8")
        KERNEL_ROWS.write_text(new_rows, encoding="utf-8")
        print(f"wrote {REFERENCE_JSON.relative_to(ROOT)} and {KERNEL_ROWS.relative_to(ROOT)}")
        return
    stale = [name for name, changed in (("src/index.html", new_html != html), ("reference-data.json", new_ref != old_ref),
                                        (str(KERNEL_ROWS.relative_to(ROOT)), new_rows != old_rows)) if changed]
    if args.check:
        if stale:
            print("out of date (run scripts/refresh_reference_glyphs.py):", ", ".join(stale))
        sys.exit(1 if (stale or problems) else 0)
    if problems:
        sys.exit(1)
    if "src/index.html" in stale:
        HTML.write_text(new_html, encoding="utf-8")
    if new_ref != old_ref:
        REFERENCE_DATA.write_text(new_ref, encoding="utf-8")
    if new_rows != old_rows:
        KERNEL_ROWS.write_text(new_rows, encoding="utf-8")
    print("wrote " + ", ".join(stale) if stale else "already up to date")


if __name__ == "__main__":
    main()
