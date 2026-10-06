import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import type { IKernel } from '@jupyterlite/services';
import { IKernelSpecs } from '@jupyterlite/services';
import { INotebookTracker } from '@jupyterlab/notebook';
import { BasedPLKernel } from './kernel.js';
import layout from './layout.js';

const kernel: JupyterFrontEndPlugin<void> = {
  id: '@rahuketu86/basedpl-kernel:kernel',
  autoStart: true,
  requires: [IKernelSpecs, INotebookTracker],
  activate: (
    app: JupyterFrontEnd,
    kernelspecs: IKernelSpecs,
    notebookTracker: INotebookTracker
  ) => {
    let activeKernel: BasedPLKernel | null = null;

    kernelspecs.register({
      spec: {
        name: 'basedpl',
        display_name: 'BasedPL',
        language: 'apl',
        argv: [],
        resources: {
          'logo-32x32': '',
          'logo-64x64': ''
        }
      },
      create: async (options: IKernel.IOptions): Promise<IKernel> => {
        const instance = new BasedPLKernel(options);
        activeKernel = instance;
        return instance;
      }
    });


    // BasedPL input layer: floating symbol bar + backtick completion + Mac Option keyboard.
    const macLayout = layout as any;
    type GlyphChoice = { glyph: string; name: string };
    type EditorAdapter = {
      id: any; text: string; pos: number; empty: boolean;
      rect: () => { left: number; bottom: number };
      insert: (text: string, from?: number) => void;
    };
    const last = { editor: null as EditorAdapter | null };
    let active: { id: any; start: number } | undefined;
    let choice: { editor: EditorAdapter; start: number; found: GlyphChoice[] } | undefined;
    let leftAlt = false, rightAlt = false, keyInput = false, pending: string | null = null;
    const glyphNames: Record<string, string> = {
      '√':'sqrt','∞':'infinity','⍬':'zilde','⍴':'rho','∘':'jot','÷':'divide','π':'pi','≠':'not-equal',
      '⌈':'ceiling','⌊':'floor','←':'left-arrow','↓':'down-arrow','↑':'take','→':'right-arrow',
      '⊣':'left-tack','⊢':'right-tack','⊃':'pick','∩':'intersection','∪':'union','×':'multiply',
      '⌽':'reverse','⍺':'alpha','⍵':'omega','⍳':'iota','∊':'epsilon','⎕':'quad','∇':'del',
      '∆':'delta','⍉':'transpose','⊖':'rotate','⍋':'grade-up','⍒':'grade-down','⍪':'catenate',
      '⌿':'replicate','⍀':'expand','⍸':'iota-underbar','⍷':'epsilon-underbar','⌷':'squad',
      '⌺':'quad-diamond','⌸':'quad-equal','⌹':'quad-divide','⍠':'quad-colon','⍟':'power',
      '⊗':'outer-product','⊘':'divide-bar','⌾':'circle-bar','⨸':'divide-circle','⍭':'stile-tilde',
      '⍶':'alpha-underbar','⍹':'omega-underbar','⍢':'del-diaeresis','⍤':'diaeresis-jot','⍥':'diaeresis-circle',
      '⍣':'power-diaeresis','⍨':'commute','⍲':'nand','⍱':'nor','¯':'overbar','⋄':'diamond',
      '⍎':'execute','⍕':'format'
    };

    function usKey(ev: KeyboardEvent): string | undefined {
      const code = ev.code;
      if (/^Key[A-Z]$/.test(code)) return ev.shiftKey ? code.slice(3) : code.slice(3).toLowerCase();
      if (/^Digit[0-9]$/.test(code)) return ev.shiftKey ? ')!@#$%^&*('[Number(code[5])] : code[5];
      const p: Record<string, string> = {
        Backquote: String.fromCharCode(96) + '~', Minus: '-_', Equal: '=+',
        BracketLeft: '[{', BracketRight: ']}', Backslash: '\\\\|', Semicolon: ';:',
        Quote: "'\"", Comma: ',<', Period: '.>', Slash: '/?'
      };
      return p[code]?.[Number(ev.shiftKey)];
    }

    function press(ev: KeyboardEvent, option: boolean): { text: string; stop: boolean } | undefined {
      const key = usKey(ev);
      const plain = !ev.altKey && !ev.ctrlKey && !ev.metaKey;
      const action = option && ev.altKey && !ev.ctrlKey && !ev.metaKey
        ? (macLayout.alt_aliases?.[ev.key] ?? (key ? macLayout.option?.[key] : null) ??
          (Object.values(macLayout.alt_aliases ?? {}).includes(key) ? key : null))
        : null;
      if (pending) {
        const stateName = pending;
        const state = macLayout.states[stateName as string] as any;
        const repeated = action?.state === stateName;
        pending = null;
        if (repeated) return { text: state.terminator, stop: true };
        if (plain && ev.key === ' ') return { text: state.terminator, stop: true };
        if (ev.key === 'Backspace' || ev.key === 'Escape') return { text: '', stop: true };
        if (plain && key) {
          const next = state.keys[key as string];
          if (next === undefined) {
            const rest = press(ev, option);
            return { text: state.terminator + (rest?.text ?? ''), stop: rest?.stop ?? false };
          }
          if (typeof next === 'string') return { text: next, stop: true };
          pending = next.state;
          return { text: '', stop: true };
        }
        const rest = press(ev, option);
        return { text: state.terminator + (rest?.text ?? ''), stop: rest?.stop ?? false };
      }
      if (action) {
        if (typeof action === 'string') return { text: action, stop: true };
        pending = action.state;
        return { text: '', stop: true };
      }
      return undefined;
    }

    function editor(): EditorAdapter | null {
      const cell: any = notebookTracker.activeCell;
      const ed: any = cell?.editor;
      if (!ed || ed.readOnly) return null;
      const cursor = ed.getCursorPosition?.();
      if (!cursor) return null;
      const selection = ed.getSelection?.();
      const pos = ed.getOffsetAt(cursor);
      const from = selection ? ed.getOffsetAt(selection.start) : pos;
      const to = selection ? ed.getOffsetAt(selection.end) : pos;
      return {
        id: ed,
        text: ed.model.sharedModel.getSource(),
        pos,
        empty: from === to,
        rect: () => {
          const coordinate = ed.getCoordinateForPosition?.(ed.getCursorPosition());
          if (coordinate) return { left: coordinate.left, bottom: coordinate.bottom };
          const r = ed.host.getBoundingClientRect();
          return { left: r.left, bottom: r.bottom };
        },
        insert: (text: string, fromOffset = from) => {
          const currentCursor = ed.getCursorPosition();
          const currentSelection = ed.getSelection?.();
          const endOffset = currentSelection ? ed.getOffsetAt(currentSelection.end) : ed.getOffsetAt(currentCursor);
          ed.setSelection(ed.getPositionAt(fromOffset), ed.getPositionAt(endOffset));
          ed.replaceSelection(text);
          ed.focus();
        }
      };
    }

    const host = document.createElement('div');
    host.id = 'basedpl-input-host';
    const bar = document.createElement('div');
    bar.className = 'ngn_lb';
    bar.setAttribute('aria-label', 'BPL symbols');
    const close = document.createElement('button');
    close.className = 'ngn_x'; close.title = 'Close symbol bar'; close.textContent = '×';
    const toggle = document.createElement('button');
    toggle.className = 'ngn_o'; toggle.title = 'Toggle overlay/push-down';
    bar.append(close, toggle);
    const tip = document.createElement('div');
    tip.className = 'bpl_choices'; tip.setAttribute('role', 'group'); tip.setAttribute('aria-label', 'BPL symbol completions'); tip.hidden = true;
    host.append(bar, tip);
    document.body.appendChild(host);

    let overlay = false;
    try { overlay = localStorage.getItem('ngn_lb_overlay') === '1'; } catch {}
    // Mac/US physical keyboard layout. Each key shows the glyph produced by Option+key.
    const keyboardRows = [
      ['`','1','2','3','4','5','6','7','8','9','0','-','='],
      ['q','w','e','r','t','y','u','i','o','p','[',']','\\\\'],
      ['a','s','d','f','g','h','j','k','l',';',"'"],
      ['z','x','c','v','b','n','m',',','.','/']
    ];
    const glyphForKey = (key: string): string | null => {
      const action: any = macLayout.option?.[key];
      if (typeof action === 'string') return action;
      return action?.state ? (macLayout.states?.[action.state]?.terminator ?? null) : null;
    };
    for (const row of keyboardRows) {
      const rowEl = document.createElement('div');
      rowEl.className = 'bpl_keyrow';
      for (const key of row) {
        const glyph = glyphForKey(key);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bpl_key';
        b.dataset.glyph = glyph ?? '';
        b.title = glyph ? `Option+${key} → ${glyph}` : `Option+${key}`;
        b.innerHTML = `<span class="bpl_glyph">${glyph ?? ''}</span><span class="bpl_keylabel">${key}</span>`;
        if (!glyph) b.classList.add('unmapped');
        rowEl.appendChild(b);
      }
      bar.appendChild(rowEl);
    }

    const reflow = () => {
      toggle.textContent = overlay ? '▼' : '▲';
      document.body.style.paddingTop = overlay || bar.hidden ? '' : bar.offsetHeight + 'px';
    };
    const cancel = () => { active = undefined; choice = undefined; tip.hidden = true; tip.replaceChildren(); };
    const show = (e: EditorAdapter, start: number, found: GlyphChoice[]) => {
      tip.replaceChildren();
      for (const x of found) {
        const b = document.createElement('button');
        b.type = 'button'; b.dataset.glyph = x.glyph; b.textContent = x.glyph + ' ' + x.name; tip.appendChild(b);
      }
      if (!found.length) { const n = document.createElement('small'); n.textContent = 'Unknown symbol'; tip.appendChild(n); }
      const r = e.rect();
      tip.hidden = false;
      const minTop = bar.hidden || overlay ? 4 : bar.offsetHeight + 4;
      const left = Math.max(4, Math.min(r.left, innerWidth - Math.min(tip.offsetWidth, 360) - 8));
      const top = Math.max(minTop, Math.min(r.bottom + 4, innerHeight - tip.offsetHeight - 8));
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
      choice = { editor: e, start, found };
    };

    const matchesGlyphs = async (query: string): Promise<GlyphChoice[]> => {
      if (!activeKernel) return [];
      try {
        const reply = await activeKernel.completeRequest({ code: String.fromCharCode(96) + query, cursor_pos: query.length + 1 });
        if ('matches' in reply) return reply.matches.map((g: string) => ({ glyph: String(g), name: glyphNames[String(g)] ?? String(g) })).slice(0, 32);
      } catch {}
      return [];
    };

    const refresh = async (target: EventTarget | null) => {
      const e = editor();
      if (!e) { cancel(); return; }
      const body = 0;
      const start = e.text.lastIndexOf(String.fromCharCode(96), e.pos - 1);
      if (start < body || !e.empty) { cancel(); return; }
      const query = e.text.slice(start + 1, e.pos);
      if (!/^[a-z]*$/i.test(query)) { cancel(); return; }
      const found = await matchesGlyphs(query);
      const now = editor();
      if (!now || now.id !== e.id || now.pos !== e.pos || now.text !== e.text) return;
      if (!active || active.id !== e.id || active.start !== start) return;
      show(e, start, found);
    };

    bar.addEventListener('mousedown', ev => {
      ev.preventDefault();
      const remembered = last.editor;
      const b = (ev.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!b) return;
      if (b === close) { bar.hidden = true; reflow(); }
      else if (b === toggle) {
        overlay = !overlay;
        try { localStorage.setItem('ngn_lb_overlay', overlay ? '1' : '0'); } catch {}
        reflow();
      } else if (b.dataset.glyph && remembered) {
        remembered.insert(b.dataset.glyph);
      }
      cancel();
    });
    tip.addEventListener('mousedown', ev => {
      ev.preventDefault();
      const b = (ev.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (b?.dataset.glyph && choice) choice.editor.insert(b.dataset.glyph, choice.start);
      cancel();
    });

    const remember = () => { last.editor = editor(); };
    notebookTracker.activeCellChanged.connect(() => { remember(); cancel(); });
    notebookTracker.currentChanged.connect(() => { remember(); cancel(); });
    document.addEventListener('focusin', () => { const e = editor(); if (e) last.editor = e; }, true);
    document.addEventListener('pointerup', ev => { if (!host.contains(ev.target as Node)) remember(); }, true);
    for (const event of ['paste', 'cut', 'compositionstart', 'focusout']) document.addEventListener(event, cancel, true);
    document.addEventListener('input', ev => {
      if (!keyInput || ((ev as InputEvent).inputType !== 'insertText' && (ev as InputEvent).inputType !== 'deleteContentBackward')) cancel();
      keyInput = false;
      requestAnimationFrame(() => { remember(); });
    });
    window.addEventListener('blur', () => { leftAlt = rightAlt = false; pending = null; cancel(); });
    window.addEventListener('keyup', ev => {
      if (ev.code === 'AltLeft') leftAlt = false;
      if (ev.code === 'AltRight') rightAlt = false;
      keyInput = false;
      remember();
      if (active) void refresh(ev.target);
    }, true);

    window.addEventListener('keydown', ev => {
      keyInput = false;
      if (ev.code === 'AltLeft') leftAlt = true;
      if (ev.code === 'AltRight') rightAlt = true;
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(ev.key)) return;
      const e = editor();
      if (!e || ev.isComposing || ev.defaultPrevented) { cancel(); return; }
      last.editor = e;
      const plain = !ev.ctrlKey && !ev.altKey && !ev.metaKey;
      const pressed = press(ev, leftAlt && !rightAlt && !ev.getModifierState('AltGraph'));
      if (pressed) {
        if (pressed.text) e.insert(pressed.text);
        if (pressed.stop) { cancel(); ev.preventDefault(); ev.stopImmediatePropagation(); return; }
      }
      const start = e.text.lastIndexOf(String.fromCharCode(96), e.pos - 1);
      const query = start >= 0 ? e.text.slice(start + 1, e.pos) : '';
      const item = start >= 0 && e.empty && /^[a-z]*$/i.test(query);
      const typed = !!active && active.id === e.id && active.start === start;

      // First Tab opens the glyph list. A second Tab commits the selected/first glyph.
      if (item && ev.key === 'Tab' && plain && !ev.shiftKey) {
        const currentChoice = choice;
        if (currentChoice && currentChoice.editor.id === e.id && currentChoice.start === start) {
          if (currentChoice.found.length) {
            e.insert(currentChoice.found[0].glyph, start);
            cancel();
          }
        } else {
          active = { id: e.id, start };
          void refresh(ev.target);
        }
        ev.preventDefault();
        ev.stopImmediatePropagation();
        return;
      }

      if (ev.key === String.fromCharCode(96) && plain) {
        const updated = editor();
        if (updated && updated.empty) { active = { id: updated.id, start: updated.pos }; }
        else cancel();
      } else if (!(typed && plain && (/^[a-z]$/i.test(ev.key) || ev.key === 'Backspace'))) cancel();
      keyInput = plain && (ev.key.length === 1 || ev.key === 'Backspace');
    }, true);

    close.addEventListener('click', () => { bar.hidden = true; reflow(); });
    reflow();

    const style = document.createElement('style');
    style.textContent = [
      '#basedpl-input-host { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }',
      '#basedpl-input-host .ngn_lb, #basedpl-input-host .bpl_choices { pointer-events: auto; background: #eee; color: #111; font: 15px ui-monospace, SFMono-Regular, Menlo, monospace; z-index: 2147483647; }',
      '#basedpl-input-host .ngn_lb { position: fixed; top: 0; left: 0; right: 0; border-bottom: 1px solid #999; padding: 6px 58px 7px; display: flex; flex-direction: column; gap: 4px; align-items: center; box-sizing: border-box; }',
      '#basedpl-input-host .bpl_keyrow { display: flex; gap: 4px; justify-content: center; width: max-content; }',
      '#basedpl-input-host .bpl_key { width: 64px; height: 48px; padding: 3px 5px; border: 1px solid #aaa; border-radius: 6px; background: #ddd; color: #111; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; box-sizing: border-box; }',
      '#basedpl-input-host .bpl_key:hover { background: #bbb; }',
      '#basedpl-input-host .bpl_key:active { transform: translateY(1px); }',
      '#basedpl-input-host .bpl_key.unmapped { opacity: .35; }',
      '#basedpl-input-host .bpl_glyph { display: block; font-size: 27px; line-height: 28px; min-height: 28px; text-align: center; }',
      '#basedpl-input-host .bpl_keylabel { display: block; font-size: 11px; line-height: 12px; opacity: .7; text-align: center; }',
      '#basedpl-input-host .ngn_x, #basedpl-input-host .ngn_o { position: absolute; top: 5px; border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 22px; padding: 3px 7px; z-index: 2; }',
      '#basedpl-input-host .ngn_x { right: 5px; }',
      '#basedpl-input-host .ngn_o { right: 38px; }',
      '#basedpl-input-host .bpl_choices { position: fixed; width: max-content; min-width: 150px; max-width: min(360px, calc(100vw - 16px)); max-height: 280px; overflow-y: auto; overflow-x: hidden; border: 1px solid #888; border-radius: 5px; box-shadow: 0 3px 12px #0003; padding: 4px; }',
      '#basedpl-input-host .bpl_choices button { display: block; width: 100%; text-align: left; white-space: nowrap; font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 5px 8px; }',
      '#basedpl-input-host .bpl_choices button:hover { background: #777; color: white; }',
      '#basedpl-input-host .bpl_choices small { display: block; padding: 5px 8px; }',
      '@media(prefers-color-scheme:dark) { #basedpl-input-host .ngn_lb, #basedpl-input-host .bpl_choices { background: #222; color: #ddd; } #basedpl-input-host .bpl_key { background: #333; border-color: #666; color: #ddd; } #basedpl-input-host .bpl_key:hover { background: #555; } }'
    ].join('\\n');
    document.head.appendChild(style);
  }
};

export default [kernel];
