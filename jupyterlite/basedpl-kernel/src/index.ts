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
    notebookTracker: any
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

    // Trigger JupyterLab's native completer after a BasedPL backtick.
    // The kernel returns glyphs as the replacement text, so `rho -> ⍴.
    const onKeydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (!/^[A-Za-z0-9_`]+$/.test(event.key) || event.key.length !== 1) return;

      const panel = notebookTracker.currentWidget;
      const cell = notebookTracker.activeCell;
      if (!panel || !cell || panel.context.sessionContext.kernelDisplayName !== 'BasedPL') return;

      const editor = cell.editor;
      if (!editor?.hasFocus()) return;

      const cursor = editor.getCursorPosition();
      const line = editor.getLine(cursor.line) ?? '';
      const before = line.slice(0, cursor.column);

      if (event.key === '`' || /`[A-Za-z_][A-Za-z0-9_]*$/.test(before + event.key)) {
        queueMicrotask(() => {
          if (editor.isDisposed || !editor.hasFocus()) return;
          void app.commands.execute('completer:invoke-notebook', { activate: true });
        });
      }
    };

    document.addEventListener('keydown', onKeydown, true);
    app.disposed.connect(() => document.removeEventListener('keydown', onKeydown, true));
  }
};

export default [kernel];
