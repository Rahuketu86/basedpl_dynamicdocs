import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import type { IKernel } from '@jupyterlite/services';
import { IKernelSpecs } from '@jupyterlite/services';
import { INotebookTracker } from '@jupyterlab/notebook';
import { BasedPLKernel } from './kernel.js';
import inputFactory from './input.js';

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

    // Reuse BasedPL's input parser/keyboard logic; the kernel remains the single completion source.\n    const bplInput = inputFactory([], { alt_aliases: {}, option: {}, states: {} });\n\n    // A compact floating BasedPL input keeps the notebook UI intact while
    // giving us the same `name -> glyph completion workflow as the standalone REPL.
    const root = document.createElement('div');
    root.id = 'basedpl-floating-input';
    root.innerHTML = `
      <div class="bpl-floating-main">
        <span class="bpl-floating-prompt">&gt;</span>
        <textarea rows="1" aria-label="BasedPL input" placeholder="BasedPL — type \`rho for ⍴"></textarea>
        <button type="button" class="bpl-floating-run" title="Insert into active cell and run">↵</button>
      </div>
      <div class="bpl-floating-completion" hidden></div>
    `;
    document.body.appendChild(root);

    const input = root.querySelector('textarea') as HTMLTextAreaElement;
    const runButton = root.querySelector('.bpl-floating-run') as HTMLButtonElement;
    const completion = root.querySelector('.bpl-floating-completion') as HTMLDivElement;

    const style = document.createElement('style');
    style.textContent = `
      #basedpl-floating-input {
        position: fixed;
        top: 58px;
        left: 50%;
        transform: translateX(-50%);
        width: min(720px, calc(100vw - 32px));
        z-index: 1000;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      #basedpl-floating-input .bpl-floating-main {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 8px 10px;
        background: var(--jp-layout-color1);
        border: 1px solid var(--jp-border-color2);
        border-radius: 10px;
        box-shadow: var(--jp-elevation-z6);
      }
      #basedpl-floating-input .bpl-floating-prompt {
        color: var(--jp-brand-color1);
        font-weight: 700;
        padding-top: 3px;
      }
      #basedpl-floating-input textarea {
        flex: 1;
        min-width: 0;
        max-height: 120px;
        resize: none;
        border: 0;
        outline: 0;
        background: transparent;
        color: var(--jp-ui-font-color1);
        font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      #basedpl-floating-input .bpl-floating-run {
        border: 1px solid var(--jp-border-color2);
        background: var(--jp-layout-color2);
        color: var(--jp-ui-font-color1);
        border-radius: 7px;
        min-width: 30px;
        height: 30px;
        cursor: pointer;
      }
      #basedpl-floating-input .bpl-floating-completion {
        margin-top: 4px;
        max-height: 240px;
        overflow: auto;
        background: var(--jp-layout-color1);
        border: 1px solid var(--jp-border-color2);
        border-radius: 8px;
        box-shadow: var(--jp-elevation-z6);
      }
      #basedpl-floating-input .bpl-completion-item {
        display: flex;
        width: 100%;
        gap: 12px;
        padding: 6px 10px;
        border: 0;
        background: transparent;
        color: var(--jp-ui-font-color1);
        text-align: left;
        cursor: pointer;
        font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      #basedpl-floating-input .bpl-completion-item:hover,
      #basedpl-floating-input .bpl-completion-item.selected {
        background: var(--jp-layout-color2);
      }
      #basedpl-floating-input .bpl-completion-glyph {
        min-width: 28px;
        font-size: 18px;
      }
      #basedpl-floating-input .bpl-completion-name {
        color: var(--jp-ui-font-color2);
      }
      #basedpl-floating-input.hidden {
        display: none;
      }
      @media (max-width: 700px) {
        #basedpl-floating-input {
          top: 52px;
          width: calc(100vw - 16px);
        }
      }
    `;
    document.head.appendChild(style);

    const resize = () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    };

    const currentBasedPL = () => {
      const panel = notebookTracker.currentWidget;
      return panel && panel.context.sessionContext.kernelDisplayName === 'BasedPL'
        ? panel
        : null;
    };

    const hideCompletion = () => {
      completion.hidden = true;
      completion.replaceChildren();
    };

    const showCompletion = async () => {
      const panel = currentBasedPL();
      if (!panel) { hideCompletion(); return; }

      const cursor = input.selectionStart ?? input.value.length;
      const parsed = bplInput.entry({
        text: input.value, pos: cursor,
        empty: input.selectionStart === input.selectionEnd, bpl: true
      });
      if (!parsed) { hideCompletion(); return; }

      try {
        const kernel = panel.context.sessionContext.session?.kernel;
        if (!kernel) { hideCompletion(); return; }
        const reply = await kernel.requestComplete({ code: input.value, cursor_pos: cursor });
        const matches = reply.content.matches ?? [];
        if (!matches.length || !currentBasedPL()) { hideCompletion(); return; }

        completion.replaceChildren();
        matches.slice(0, 40).forEach((match: string, index: number) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'bpl-completion-item' + (index === 0 ? ' selected' : '');
          button.dataset.match = match;
          const glyph = document.createElement('span');
          glyph.className = 'bpl-completion-glyph';
          glyph.textContent = match;
          const name = document.createElement('span');
          name.className = 'bpl-completion-name';
          name.textContent = parsed.query ? 'BasedPL: ' + parsed.query : 'BasedPL glyph';
          button.append(glyph, name);
          completion.appendChild(button);
        });
        completion.hidden = false;
      } catch { hideCompletion(); }
    };
    const acceptCompletion = async (index = 0) => {
      const panel = currentBasedPL();
      if (!panel) return;
      const kernel = panel.context.sessionContext.session?.kernel;
      if (!kernel) return;
      const cursor = input.selectionStart ?? input.value.length;
      const reply = await kernel.requestComplete({
        code: input.value,
        cursor_pos: cursor
      });
      const match = reply.content.matches?.[index];
      if (!match) return;
      const start = reply.content.cursor_start;
      const end = reply.content.cursor_end;
      input.setRangeText(match, start, end, 'end');
      hideCompletion();
      resize();
      input.focus();
    };

    const insertAndRun = async () => {
      const panel = currentBasedPL();
      const cell = notebookTracker.activeCell;
      if (!panel || !cell || panel.context.sessionContext.kernelDisplayName !== 'BasedPL') return;
      const code = input.value;
      if (!code.trim()) return;
      const editor = cell.editor;
      if (!editor) return;

      editor.focus();
      editor.replaceSelection(code);
      input.value = '';
      resize();
      hideCompletion();
      await app.commands.execute('notebook:run-cell', { activate: true });
      input.focus();
    };

    const updateVisibility = () => {
      root.classList.toggle('hidden', !currentBasedPL());
      if (!currentBasedPL()) hideCompletion();
    };

    notebookTracker.currentChanged.connect(updateVisibility);
    notebookTracker.activeCellChanged.connect(updateVisibility);
    updateVisibility();

    input.addEventListener('input', () => {
      resize();
      void showCompletion();
    });

    input.addEventListener('keydown', event => {
      if (event.key === 'Tab' && !completion.hidden) {
        event.preventDefault();
        void acceptCompletion(0);
        return;
      }
      if (event.key === 'Escape') {
        hideCompletion();
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void insertAndRun();
      }
    });

    completion.addEventListener('mousedown', event => {
      const button = (event.target as HTMLElement).closest('.bpl-completion-item') as HTMLButtonElement | null;
      if (!button) return;
      event.preventDefault();
      const index = Array.from(completion.children).indexOf(button);
      void acceptCompletion(index);
    });

    runButton.addEventListener('click', () => void insertAndRun());
    resize();
  }
};

export default [kernel];
