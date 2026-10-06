import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import type { IKernel } from '@jupyterlite/services';
import { IKernelSpecs } from '@jupyterlite/services';
import { BasedPLKernel } from './kernel.js';

const kernel: JupyterFrontEndPlugin<void> = {
  id: '@rahuketu86/basedpl-kernel:kernel',
  autoStart: true,
  requires: [IKernelSpecs],
  activate: (
    app: JupyterFrontEnd,
    kernelspecs: IKernelSpecs
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

    // Minimal first step: inject a floating input bar only.
    // Completion, keyboard mapping, and cell execution are intentionally
    // disabled until the basic UI is confirmed working in JupyterLite.
    const root = document.createElement('div');
    root.id = 'basedpl-floating-input';
    root.innerHTML = `
      <div class="bpl-floating-main">
        <span class="bpl-floating-prompt">&gt;</span>
        <textarea rows="1" aria-label="BasedPL input" placeholder="BasedPL input"></textarea>
        <button type="button" class="bpl-floating-run" title="Insert into active cell and run">↵</button>
      </div>
    `;

    document.body.appendChild(root);

    const input = root.querySelector('textarea') as HTMLTextAreaElement;
    const runButton = root.querySelector('.bpl-floating-run') as HTMLButtonElement;

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

    input.addEventListener('input', resize);
    runButton.addEventListener('click', () => {
      input.focus();
    });

    resize();
  }
};

export default [kernel];
