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
          const cursorEl = ed.host.querySelector?.('.cm-cursor, .cm-cursor-primary, .cm-cursorLayer > *');
          const cursorRect = cursorEl?.getBoundingClientRect?.();
          if (cursorRect && cursorRect.width >= 0) return { left: cursorRect.left, bottom: cursorRect.bottom };
          const coordinate = ed.getCoordinateForPosition?.(ed.getCursorPosition());
          if (coordinate) {
            const hostRect = ed.host.getBoundingClientRect();
            const left = coordinate.left >= hostRect.left ? coordinate.left : hostRect.left + coordinate.left;
            const bottom = coordinate.bottom >= hostRect.top ? coordinate.bottom : hostRect.top + coordinate.bottom;
            return { left, bottom };
          }
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
    host.append(bar);
    document.body.appendChild(host);

    let collapsed = false;
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
      toggle.textContent = collapsed ? '＋' : '−';
      toggle.title = collapsed ? 'Expand Mac keyboard' : 'Collapse Mac keyboard';
      bar.classList.toggle('bpl_collapsed', collapsed);
      document.body.style.paddingTop = bar.hidden || collapsed ? '' : bar.offsetHeight + 'px';
    };
    const cancel = () => { active = undefined; };

    bar.addEventListener('mousedown', ev => {
      ev.preventDefault();
      const remembered = last.editor;
      const b = (ev.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!b) return;
      if (b === close) {
        bar.hidden = true;
        reflow();
      } else if (b === toggle) {
        collapsed = !collapsed;
        reflow();
      } else if (b.dataset.glyph && remembered) {
        remembered.insert(b.dataset.glyph, remembered.pos);
      }
    });


    const remember = () => { last.editor = editor(); };
    notebookTracker.activeCellChanged.connect(() => { remember(); cancel(); });
    notebookTracker.currentChanged.connect(() => { remember(); cancel(); });
    document.addEventListener('focusin', () => { const e = editor(); if (e) last.editor = e; }, true);
    document.addEventListener('pointerup', ev => { if (!host.contains(ev.target as Node)) remember(); }, true);
    for (const event of ['paste', 'cut', 'compositionstart']) document.addEventListener(event, cancel, true);
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
      // Let the browser/editor insert the backtick first, then invoke JupyterLab's
      // native notebook completer. Its popup is anchored to the real editor cursor
      // and supports mouse clicks, arrows and Enter.
      if (ev.key === String.fromCharCode(96) && plain) {
        requestAnimationFrame(() => {
          void app.commands.execute('completer:invoke-notebook');
        });
      }

      keyInput = plain && (ev.key.length === 1 || ev.key === 'Backspace');
    }, true);

    close.addEventListener('click', () => { bar.hidden = true; reflow(); });
    reflow();

    const style = document.createElement('style');
    style.textContent = [
      '#basedpl-input-host { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }',
      '#basedpl-input-host .ngn_lb { position: fixed; top: 0; left: 50%; transform: translateX(-50%); width: max-content; max-width: calc(100vw - 16px); box-sizing: border-box; pointer-events: auto; background: #eee; color: #111; font: 15px ui-monospace, SFMono-Regular, Menlo, monospace; border: 1px solid #999; border-top: 0; border-radius: 0 0 10px 10px; padding: 8px 58px 9px; display: flex; flex-direction: column; align-items: center; gap: 5px; z-index: 2147483647; box-shadow: 0 2px 8px #0002; }',
      '#basedpl-input-host .ngn_lb.bpl_collapsed { padding: 3px 46px; min-height: 32px; }',
      '#basedpl-input-host .bpl_collapsed .bpl_keyrow { display: none; }',
      '#basedpl-input-host .bpl_keyrow { display: flex; justify-content: center; align-items: center; gap: 5px; width: max-content; }',
      '#basedpl-input-host .bpl_key { flex: 0 0 68px; width: 68px; height: 52px; padding: 3px; border: 1px solid #aaa; border-radius: 7px; background: #ddd; color: #111; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; box-sizing: border-box; user-select: none; }',
      '#basedpl-input-host .bpl_key:hover { background: #bbb; }',
      '#basedpl-input-host .bpl_key:active { transform: translateY(1px); background: #aaa; }',
      '#basedpl-input-host .bpl_key.unmapped { opacity: .3; }',
      '#basedpl-input-host .bpl_glyph { display: block; width: 100%; font-size: 30px; line-height: 31px; min-height: 31px; text-align: center; }',
      '#basedpl-input-host .bpl_keylabel { display: block; width: 100%; font-size: 11px; line-height: 13px; opacity: .65; text-align: center; }',
      '#basedpl-input-host .ngn_x, #basedpl-input-host .ngn_o { position: absolute; top: 5px; border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 22px; padding: 4px 7px; z-index: 3; }',
      '#basedpl-input-host .ngn_x { right: 5px; }',
      '#basedpl-input-host .ngn_o { right: 40px; }',
      '@media(max-width: 1100px) { #basedpl-input-host .bpl_key { flex-basis: 52px; width: 52px; height: 48px; } #basedpl-input-host .bpl_glyph { font-size: 26px; } #basedpl-input-host .bpl_keyrow { gap: 3px; } #basedpl-input-host .ngn_lb { padding-left: 8px; padding-right: 48px; } }',
      '@media(prefers-color-scheme:dark) { #basedpl-input-host .ngn_lb { background: #222; color: #ddd; } #basedpl-input-host .bpl_key { background: #333; border-color: #666; color: #ddd; } #basedpl-input-host .bpl_key:hover { background: #555; } }'
    ].join('\\n');
    document.head.appendChild(style);
  }
};

export default [kernel];
