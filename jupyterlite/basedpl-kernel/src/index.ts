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

    // BasedPL Mac-layout glyph palette.
    const root = document.createElement('div');
    root.id = 'basedpl-glyph-bar';
    root.setAttribute('aria-label', 'BasedPL glyph palette');

    const last = {
      editor: null as any,
      cell: null as any
    };

    const rememberActiveCell = () => {
      const cell = notebookTracker.activeCell;
      if (cell?.editor) {
        last.cell = cell;
        last.editor = cell.editor;
      }
    };

    notebookTracker.activeCellChanged.connect(rememberActiveCell);
    notebookTracker.currentChanged.connect(rememberActiveCell);
    rememberActiveCell();

    // BasedPL-style backtick discovery, implemented directly in the CodeMirror cell.
    let activeQuery: { editor: any; start: number; matches: Array<{glyph: string; name: string}> } | null = null;

    const glyphNames: Record<string, string> = {
      '√':'sqrt','∞':'infinity','⍬':'zilde','⍴':'rho','∘':'jot','÷':'divide',
      'π':'pi','≠':'not-equal','⌈':'ceiling','⌊':'floor','←':'left-arrow',
      '↓':'down-arrow','↑':'take','→':'right-arrow','⊣':'left-tack','⊢':'right-tack',
      '⊃':'pick','∩':'intersection','∪':'union','×':'multiply','⌽':'reverse',
      '⍺':'alpha','⍵':'omega','⍳':'iota','∊':'epsilon','⎕':'quad','∇':'del',
      '∆':'delta','⍉':'transpose','⊖':'rotate','⍋':'grade-up','⍒':'grade-down',
      '⍪':'catenate','⌿':'replicate','⍀':'expand','⍸':'iota-underbar',
      '⍷':'epsilon-underbar','⌷':'squad','⌺':'quad-diamond','⌸':'quad-equal',
      '⌹':'quad-divide','⍠':'quad-colon','⍟':'power','⊗':'outer-product',
      '⊘':'divide-bar','⌾':'circle-bar','⨸':'divide-circle','⍭':'stile-tilde',
      '⍶':'alpha-underbar','⍹':'omega-underbar','⍢':'del-diaeresis',
      '⍤':'diaeresis-jot','⍥':'diaeresis-circle','⍣':'power-diaeresis',
      '⍨':'commute','⍲':'nand','⍱':'nor','¯':'overbar','⋄':'diamond',
      '⍎':'execute','⍕':'format'
    };

    type GlyphState = { terminator: string; keys: Record<string, string | { state: string }> };
    const glyphStates = layout.states as Record<string, GlyphState>;

    const layoutMatchesGlyphs = (query: string) => {
      const q = query.toLowerCase();
      const result: Array<{glyph: string; name: string}> = [];
      const seen = new Set<string>();
      const add = (glyph: string, name: string) => {
        if (seen.has(glyph)) return;
        seen.add(glyph);
        const n = name.toLowerCase();
        const compact = n.replaceAll('-', '');
        if (!q || compact === q || compact.startsWith(q) || n.includes(q))
          result.push({glyph, name});
      };

      for (const action of Object.values(layout.option)) {
        if (typeof action === 'string') {
          add(action, glyphNames[action] ?? action);
        } else {
          const state = glyphStates[action.state];
          add(state.terminator, action.state);
          for (const next of Object.values(state.keys)) {
            if (typeof next === 'string') add(next, glyphNames[next] ?? next);
          }
        }
      }
      return result.slice(0, 12);
    };

    const matchesGlyphs = async (query: string) => {
      if (activeKernel) {
        try {
          const code = '`' + query;
          const reply = await activeKernel.completeRequest({
            code,
            cursor_pos: code.length
          });
          if ('matches' in reply) {
            return reply.matches.map((glyph: string) => ({
              glyph: String(glyph),
              name: glyphNames[String(glyph)] ?? String(glyph)
            })).slice(0, 12);
          }
          throw new Error('Glyph completion failed');
        } catch {
          // Fall through to the layout-only matcher while the worker starts.
        }
      }
      return layoutMatchesGlyphs(query);
    };

    const popup = document.createElement('div');
    popup.id = 'basedpl-glyph-choices';
    popup.hidden = true;
    document.body.appendChild(popup);

    const hideGlyphPopup = () => {
      activeQuery = null;
      popup.hidden = true;
      popup.replaceChildren();
    };

    const refreshGlyphPopup = async (editor: any) => {
      const code = editor.model.sharedModel.getSource();
      const pos = editor.getOffsetAt(editor.getCursorPosition());
      const before = code.slice(0, pos);
      const match = /\x60([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before);
      if (!match) {
        hideGlyphPopup();
        return;
      }

      const matches = await matchesGlyphs(match[1] ?? '');
      if (editor !== notebookTracker.activeCell?.editor) return;
      const currentPos = editor.getOffsetAt(editor.getCursorPosition());
      const currentCode = editor.model.sharedModel.getSource();
      const currentMatch = /\x60([A-Za-z_][A-Za-z0-9_]*)?$/.exec(currentCode.slice(0, currentPos));
      if (!currentMatch || currentPos !== pos || currentMatch[0] !== match[0]) return;

      popup.replaceChildren();
      for (const item of matches) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = item.glyph + '  ' + item.name;
        button.addEventListener('mousedown', e => e.preventDefault());
        button.addEventListener('click', () => {
          editor.setSelection({
            start: editor.getPositionAt(pos - match[0].length),
            end: editor.getCursorPosition()
          });
          editor.replaceSelection(item.glyph);
          editor.focus();
          hideGlyphPopup();
        });
        popup.appendChild(button);
      }

      if (!matches.length) {
        const note = document.createElement('div');
        note.textContent = 'Unknown symbol';
        note.className = 'bpl-glyph-empty';
        popup.appendChild(note);
      }

      const rect = editor.host.getBoundingClientRect();
      popup.style.left = Math.max(8, Math.min(rect.left, innerWidth - 320)) + 'px';
      popup.style.top = Math.min(innerHeight - 260, Math.max(8, rect.bottom + 4)) + 'px';
      popup.hidden = false;
      activeQuery = { editor, start: pos - match[0].length, matches };
    };

    document.addEventListener('keydown', event => {
      const editor = notebookTracker.activeCell?.editor as any;
      if (!editor || event.defaultPrevented || event.isComposing) return;

      if (activeQuery?.editor === editor) {
        if (event.key === 'Tab' || event.key === 'Enter') {
          const code = editor.model.sharedModel.getSource();
          const pos = editor.getOffsetAt(editor.getCursorPosition());
          const match = /\x60([A-Za-z_][A-Za-z0-9_]*)?$/.exec(code.slice(0, pos));
          const matches = activeQuery.matches;
          if (match && matches.length) {
            editor.setSelection({
              start: editor.getPositionAt(pos - match[0].length),
              end: editor.getCursorPosition()
            });
            editor.replaceSelection(matches[0].glyph);
            hideGlyphPopup();
            event.preventDefault();
            event.stopImmediatePropagation();
            editor.focus();
            return;
          }
        }
        if (event.key === 'Escape') {
          hideGlyphPopup();
          return;
        }
      }

      if (event.key === String.fromCharCode(96) ||
          event.key === 'Backspace' ||
          /^[A-Za-z]$/.test(event.key)) {
        requestAnimationFrame(() => { void refreshGlyphPopup(editor); });
      }
    }, true);

    const palette: Array<{ glyph: string; shortcut: string }> = [];
    const seenPalette = new Set<string>();
    const addPalette = (glyph: string, shortcut: string) => {
      if (!glyph || seenPalette.has(glyph)) return;
      seenPalette.add(glyph);
      palette.push({ glyph, shortcut });
    };
    for (const [key, action] of Object.entries(layout.option)) {
      if (typeof action === 'string') {
        addPalette(action, '⌥' + key);
      } else {
        const state = glyphStates[action.state];
        addPalette(state.terminator, '⌥' + key);
        for (const [nextKey, nextAction] of Object.entries(state.keys)) {
          if (typeof nextAction === 'string') addPalette(nextAction, '⌥' + key + ' ' + nextKey);
        }
      }
    }

    for (const item of palette) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'bpl-glyph-button';
      button.textContent = item.glyph;
      button.title = item.glyph + '   ' + item.shortcut;
      button.setAttribute('aria-label', 'Insert ' + item.glyph);
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => {
        const editor = last.editor;
        if (!editor) return;
        editor.focus();
        editor.replaceSelection(item.glyph);
        hideGlyphPopup();
      });
      root.appendChild(button);
    }

    document.body.appendChild(root);

    const style = document.createElement('style');
    style.textContent = `
      #basedpl-glyph-bar {
        position: fixed;
        top: 58px;
        left: 50%;
        transform: translateX(-50%);
        width: min(920px, calc(100vw - 24px));
        z-index: 1000;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        gap: 3px;
        padding: 6px;
        box-sizing: border-box;
        background: var(--jp-layout-color1);
        border: 1px solid var(--jp-border-color2);
        border-radius: 9px;
        box-shadow: var(--jp-elevation-z4);
      }

      #basedpl-glyph-bar .bpl-glyph-button {
        min-width: 32px;
        height: 32px;
        padding: 0 6px;
        border: 1px solid transparent;
        border-radius: 5px;
        background: transparent;
        color: var(--jp-ui-font-color1);
        font: 19px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        cursor: pointer;
      }

      #basedpl-glyph-bar .bpl-glyph-button:hover {
        background: var(--jp-layout-color2);
        border-color: var(--jp-border-color2);
      }

      #basedpl-glyph-bar .bpl-glyph-button:active {
        background: var(--jp-brand-color3);
      }

      @media (max-width: 700px) {
        #basedpl-glyph-bar {
          top: 52px;
          width: calc(100vw - 8px);
          gap: 1px;
          padding: 4px;
        }

        #basedpl-glyph-bar .bpl-glyph-button {
          min-width: 29px;
          height: 29px;
          font-size: 17px;
        }
      }
    `;
    document.head.appendChild(style);
  }
};

export default [kernel];
