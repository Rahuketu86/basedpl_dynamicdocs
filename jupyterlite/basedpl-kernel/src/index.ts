import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import type { IKernel } from '@jupyterlite/services';
import { IKernelSpecs } from '@jupyterlite/services';
import { INotebookTracker } from '@jupyterlab/notebook';
import { BasedPLKernel } from './kernel.js';

const kernel: JupyterFrontEndPlugin<void> = {
  id: '@rahuketu86/basedpl-kernel:kernel',
  autoStart: true,
  requires: [IKernelSpecs, INotebookTracker],
  activate: (
    app: JupyterFrontEnd,
    kernelspecs: IKernelSpecs,
    notebookTracker: INotebookTracker
  ) => {
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
      create: async (options: IKernel.IOptions): Promise<IKernel> =>
        new BasedPLKernel(options)
    });

    // Simple glyph palette. Clicking a glyph inserts it into the last
    // active notebook cell; no WASM/completion path is involved.
    const glyphs = [
      '⌈', '⌊', '⍉', '⌽', '⊖', '⍋', '⍒', '⍪', '⌿', '⍀',
      '↑', '↓', '→', '←', '↕', '↢', '↣', '∇', '∆', '⍺',
      '⍵', '⍳', '⍸', '∊', '⍷', '⍴', '⍬', '⎕', '⌷', '⌺',
      '⌸', '⌹', '⍠', '∘', '•', '○', '⊂', '⊆', '∩', '∪',
      '⊃', '⊥', '⊤', '×', '÷', '≠', '≡', '≢', '≤', '≥',
      '√', '∞', '∧', '∨', '⍲', '⍱', '⊣', '⊢', 'π', '¿'
    ];

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

    // Reuse BasedPL's backtick glyph-discovery convention. The kernel's
    // completeRequest already understands \`name and returns matching glyphs.
    const invokeGlyphCompletion = () => {
      const cell = notebookTracker.activeCell;
      const editor = cell?.editor;
      if (!editor) return;

      const code = editor.model.sharedModel.getSource();
      const cursor = editor.getCursorPosition();
      const cursorPos = editor.getOffsetAt(cursor);
      const beforeCursor = code.slice(0, cursorPos);

      // Only invoke the normal Jupyter completer inside a \`name expression.
      if (/`[A-Za-z_][A-Za-z0-9_]*$/.test(beforeCursor) ||
          /`$/.test(beforeCursor)) {
        void app.commands.execute('completer:invoke-notebook');
      }
    };

    document.addEventListener('input', event => {
      const target = event.target as Node | null;
      const editor = notebookTracker.activeCell?.editor;
      if (!editor || !target || !editor.host.contains(target)) return;
      requestAnimationFrame(invokeGlyphCompletion);
    }, true);

    for (const glyph of glyphs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'bpl-glyph-button';
      button.textContent = glyph;
      button.title = 'Insert ' + glyph;
      button.setAttribute('aria-label', 'Insert ' + glyph);
      button.addEventListener('mousedown', event => {
        // Keep the notebook editor selection/cursor while clicking the palette.
        event.preventDefault();
      });
      button.addEventListener('click', () => {
        const editor = last.editor;
        if (!editor) return;
        editor.focus();
        editor.replaceSelection(glyph);
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
