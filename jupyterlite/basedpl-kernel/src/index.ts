import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import type { IKernel } from '@jupyterlite/services';
import { IKernelSpecs } from '@jupyterlite/services';
import { INotebookTracker } from '@jupyterlab/notebook';
import { IMainMenu } from '@jupyterlab/mainmenu';
import { Menu, Widget } from '@lumino/widgets';
import { BasedPLKernel } from './kernel.js';
import layout from './layout.js';

const kernel: JupyterFrontEndPlugin<void> = {
  id: '@rahuketu86/basedpl-kernel:kernel',
  autoStart: true,
  requires: [IKernelSpecs, INotebookTracker, IMainMenu],
  activate: (
    app: JupyterFrontEnd,
    kernelspecs: IKernelSpecs,
    notebookTracker: INotebookTracker,
    mainMenu: IMainMenu
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
    const snapshotEditor = (): EditorAdapter | null => {
      const cell: any = notebookTracker.activeCell;
      const ed: any = cell?.editor;
      if (!ed || ed.readOnly) return last.editor;

      // JupyterLab 4's CodeMirrorEditor exposes the underlying CodeMirror 6
      // EditorView as `editor`. Capture its numeric document positions directly.
      // This avoids JupyterLab's line/column -> CodeMirror conversion, which can
      // produce an incomplete position after the floating keyboard takes focus.
      const view: any = ed.editor;
      if (!view?.state?.selection?.main) return last.editor;
      const sel = view.state.selection.main;
      let from = sel.from;
      let to = sel.to;

      return {
        id: view,
        text: view.state.doc.toString(),
        pos: sel.head,
        empty: sel.empty,
        rect: () => {
          const coords = view.coordsAtPos(sel.head);
          return coords
            ? { left: coords.left, bottom: coords.bottom }
            : { left: ed.host.getBoundingClientRect().left, bottom: ed.host.getBoundingClientRect().bottom };
        },
        insert: (text: string, requestedFrom?: number) => {
          const start = requestedFrom ?? from;
          const end = requestedFrom === undefined ? to : to;
          view.dispatch({
            changes: { from: start, to: end, insert: text },
            selection: { anchor: start + text.length },
            userEvent: 'input.complete'
          });
          from = start + text.length;
          to = from;
          view.focus();
        }
      };
    };
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
    const toggle = document.createElement('button');
    toggle.className = 'ngn_o';
    toggle.type = 'button';
    toggle.title = 'Switch to Bar';

    const hideToggle = document.createElement('button');
    hideToggle.className = 'ngn_hide';
    hideToggle.type = 'button';
    hideToggle.textContent = 'Hide';
    hideToggle.title = 'Hide BasedPL input';

    bar.append(toggle, hideToggle);
    host.append(bar);

    // Use JupyterLab's official shell extension point instead of a fixed body
    // overlay. The header area sits above the main menu; its height follows
    // this widget, so the notebook is reflowed by JupyterLab itself.
    const inputWidget = new Widget({ node: host });
    inputWidget.id = 'basedpl-input-widget';
    inputWidget.addClass('bpl-header-widget');
    app.shell.add(inputWidget, 'header', { rank: 501 });
    const headerPanel = document.getElementById('jp-header-panel') as HTMLElement | null;

    let hidden = false;
    let mode: 'bar' | 'keyboard' = 'keyboard';
    const keyboardView = document.createElement('div');
    keyboardView.className = 'bpl_keyboard_view';
    const barView = document.createElement('div');
    barView.className = 'bpl_bar_view';

    // Compact glyph Bar view, reconstructed from the same BasedPL layout used
    // by the keyboard. It exposes primary glyphs and follow-up glyphs directly.
    const barGlyphs: string[] = [];
    const barSeen = new Set<string>();
    const addBarGlyph = (glyph: string) => {
      if (!glyph || barSeen.has(glyph)) return;
      barSeen.add(glyph);
      barGlyphs.push(glyph);
    };
    const collectBarGlyphs = (value: any) => {
      if (typeof value === 'string') {
        if (Array.from(value).length === 1 && value.trim()) addBarGlyph(value);
      } else if (value && typeof value === 'object') {
        for (const child of Object.values(value)) collectBarGlyphs(child);
      }
    };
    collectBarGlyphs(macLayout.option);
    collectBarGlyphs(macLayout.states);

    for (const glyph of barGlyphs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bpl_bar_glyph';
      b.dataset.glyph = glyph;
      b.textContent = glyph;
      b.title = (glyphNames[glyph] ?? glyph);
      barView.appendChild(b);
    }

    // Full Mac keyboard presentation, matching the WebREPL keyboard. The
    // layout includes ordinary physical keys plus every glyph directly
    // represented on those keycaps. Multi-glyph keys expose each glyph as an
    // independent click target (for example = -> + ≠ ≡).
    const keyboardRows = macLayout.keyboard as Array<Array<[string, string, string]>>;
    const keyboardGlyphs = new Set<string>(Array.from('+-*/=<>!,~|%&^:;?'));
    const collectGlyphs = (value: any) => {
      if (typeof value === 'string') {
        for (const ch of Array.from(value)) keyboardGlyphs.add(ch);
      } else if (value && typeof value === 'object') {
        for (const child of Object.values(value)) collectGlyphs(child);
      }
    };
    collectGlyphs(macLayout.option);
    collectGlyphs(macLayout.states);

    const specialKeys = new Set([
      'tab', 'caps', 'shift', 'shift2', 'enter', 'delete',
      'ctrl', 'ctrl2', 'cmd', 'cmd2', 'opt', 'opt2', 'space'
    ]);

    for (const row of keyboardRows) {
      const rowEl = document.createElement('div');
      rowEl.className = 'bpl_keyrow';
      for (const [key, label] of row) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bpl_key';
        if (specialKeys.has(key)) b.classList.add('wide');
        if (key === 'space') b.classList.add('space');
        b.dataset.key = key;
        b.title = label;

        const glyphTargets = Array.from(label).filter(ch => keyboardGlyphs.has(ch));
        const glyphEl = document.createElement('span');
        glyphEl.className = 'bpl_glyphs';

        for (const glyph of Array.from(label)) {
          if (!keyboardGlyphs.has(glyph)) {
            const text = document.createElement('span');
            text.textContent = glyph;
            glyphEl.appendChild(text);
            continue;
          }
          const target = document.createElement('span');
          target.className = 'bpl_glyph_target' + (glyphTargets.length === 1 ? ' primary' : '');
          target.dataset.glyph = glyph;
          target.textContent = glyph;
          target.title = glyph;
          glyphEl.appendChild(target);
        }

        const labelEl = document.createElement('span');
        labelEl.className = 'bpl_keylabel';
        labelEl.textContent = specialKeys.has(key) ? key.toUpperCase() : key;

        b.append(glyphEl, labelEl);
        if (glyphTargets.length === 1) b.dataset.glyph = glyphTargets[0];
        rowEl.appendChild(b);
      }
      keyboardView.appendChild(rowEl);
    }

    bar.append(barView, keyboardView);

    const setMode = (next: 'bar' | 'keyboard') => {
      mode = next;
      bar.classList.toggle('bpl_mode_bar', mode === 'bar');
      bar.classList.toggle('bpl_mode_keyboard', mode === 'keyboard');
      barView.hidden = mode !== 'bar';
      keyboardView.hidden = mode !== 'keyboard';
      barView.style.display = mode === 'bar' ? 'flex' : 'none';
      keyboardView.style.display = mode === 'keyboard' ? 'flex' : 'none';
      toggle.textContent = mode === 'keyboard' ? 'Bar' : 'Keyboard';
      toggle.title = mode === 'keyboard'
        ? 'Switch to Bar'
        : 'Switch to Keyboard';
      inputWidget.node.dataset.mode = mode;
    };

    const reflow = () => {
      setMode(mode);
      if (hidden) {
        inputWidget.hide();
        inputWidget.node.style.minHeight = '0px';
        if (headerPanel) headerPanel.style.minHeight = '0px';
        return;
      }
      inputWidget.show();
      inputWidget.node.style.display = 'block';
      inputWidget.node.style.width = '100%';
      resizeHeaderToContent();
    };

    const cancel = () => { active = undefined; };

    bar.addEventListener('mousedown', ev => {
      const b = (ev.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!b) return;
      if (b === hideToggle) return;
      ev.preventDefault();

      if (b === toggle) {
        if (mode === 'keyboard') showBar();
        else showKeyboard();
        return;
      }

      const remembered = snapshotEditor() ?? last.editor;
      const glyphTarget = (ev.target as HTMLElement).closest('.bpl_glyph_target') as HTMLElement | null;
      const glyph = glyphTarget?.dataset.glyph ?? b.dataset.glyph;
      if (glyph && remembered) remembered.insert(glyph);
    });

    const resizeHeaderToContent = () => {
      if (!headerPanel || hidden) return;
      // Measure only after the Lumino widget is visible. Measuring while the
      // widget/ancestor is hidden returns zero and can collapse the header.
      requestAnimationFrame(() => {
        if (hidden) return;
        inputWidget.show();
        inputWidget.node.style.display = 'block';
        const height = Math.max(1, bar.scrollHeight, bar.offsetHeight);
        // The JupyterLab header panel is initially zero-height. Lumino sizes
        // its child from the child's minimum height; setting the minimum on
        // the actual shell widget is the supported fix for this header-area
        // layout behavior.
        inputWidget.node.style.minHeight = height + 'px';
        headerPanel.style.minHeight = height + 'px';
        app.shell.fit();
      });
    };

    const showKeyboard = () => {
      hidden = false;
      inputWidget.show();
      inputWidget.node.style.display = 'block';
      setMode('keyboard');
      resizeHeaderToContent();
      app.commands.notifyCommandChanged(commandIds.showKeyboard);
      app.commands.notifyCommandChanged(commandIds.showBar);
      app.commands.notifyCommandChanged(commandIds.hide);
    };

    const showBar = () => {
      hidden = false;
      inputWidget.show();
      inputWidget.node.style.display = 'block';
      setMode('bar');
      resizeHeaderToContent();
      app.commands.notifyCommandChanged(commandIds.showKeyboard);
      app.commands.notifyCommandChanged(commandIds.showBar);
      app.commands.notifyCommandChanged(commandIds.hide);
    };

    const hideInput = () => {
      hidden = true;
      inputWidget.hide();
      inputWidget.node.style.display = 'none';
      inputWidget.node.style.minHeight = '0px';
      if (headerPanel) headerPanel.style.minHeight = '0px';
      app.shell.fit();
      app.commands.notifyCommandChanged(commandIds.showKeyboard);
      app.commands.notifyCommandChanged(commandIds.showBar);
      app.commands.notifyCommandChanged(commandIds.hide);
    };

    const hideFromButton = (ev: Event) => {
      ev.preventDefault();
      ev.stopPropagation();
      hideInput();
    };
    hideToggle.addEventListener('pointerdown', hideFromButton);
    hideToggle.addEventListener('click', hideFromButton);

    const commandIds = {
      showKeyboard: 'basedpl:show-keyboard',
      showBar: 'basedpl:show-bar',
      hide: 'basedpl:hide'
    };

    app.commands.addCommand(commandIds.showKeyboard, {
      label: 'Show Keyboard',
      isEnabled: () => hidden || mode !== 'keyboard',
      execute: showKeyboard
    });
    app.commands.addCommand(commandIds.showBar, {
      label: 'Show Bar',
      isEnabled: () => hidden || mode !== 'bar',
      execute: showBar
    });
    app.commands.addCommand(commandIds.hide, {
      label: 'Hide',
      isEnabled: () => !hidden,
      execute: hideInput
    });

    const glyphMenu = new Menu({ commands: app.commands });
    glyphMenu.title.label = 'Glyph';
    glyphMenu.addItem({ command: commandIds.showKeyboard });
    glyphMenu.addItem({ command: commandIds.showBar });
    glyphMenu.addItem({ command: commandIds.hide });
    mainMenu.addMenu(glyphMenu, true, { rank: 50 });



    const remember = () => { last.editor = editor(); };
    notebookTracker.activeCellChanged.connect(() => { remember(); cancel(); });
    notebookTracker.currentChanged.connect(() => { remember(); cancel(); });
    document.addEventListener('focusin', ev => { if (host.contains(ev.target as Node)) return; const e = editor(); if (e) last.editor = e; }, true);
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

    const style = document.createElement('style');
    style.textContent = [
      // The site injects a fixed 44px navigation strip before JupyterLite.
      // LabShell itself is absolutely positioned at viewport top, so without
      // moving the shell down, its header is rendered underneath that strip.
      '.jp-LabShell { top: 44px !important; height: calc(100% - 44px) !important; }',
      '#jp-header-panel { width: 100%; box-sizing: border-box; position: relative; z-index: 1001 !important; }',
      '#jp-header-panel > .bpl-header-widget { width: 100% !important; flex: 0 0 auto; box-sizing: border-box; min-height: 1px !important; }',
      '#basedpl-input-host { width: 100%; box-sizing: border-box; pointer-events: none; }',
      '#basedpl-input-host .ngn_lb { position: relative; width: 100%; box-sizing: border-box; pointer-events: auto; background: var(--jp-layout-color1, #fff); color: var(--jp-ui-font-color1, #111); font-family: var(--jp-ui-font-family, sans-serif); border: 1px solid var(--jp-border-color1, #bdbdbd); border-radius: 0 0 8px 8px; padding: 4px 10px 8px; display: flex; flex-direction: column; align-items: center; gap: 6px; box-shadow: var(--jp-elevation-z1, 0 1px 4px #0002); }',
      '#basedpl-input-host .bpl_keyrow { display: flex; justify-content: center; align-items: stretch; gap: 5px; width: 100%; box-sizing: border-box; }',
      '#basedpl-input-host .bpl_key { flex: 1 1 0; min-width: 0; width: auto; height: 52px; padding: 3px; border: 1px solid var(--jp-border-color2, #c8c8c8); border-radius: 7px; background: var(--jp-layout-color2, #f5f5f5); color: var(--jp-ui-font-color1, #111); cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; box-sizing: border-box; user-select: none; font-family: var(--jp-ui-font-family, sans-serif); }',
      '#basedpl-input-host .bpl_key:hover { background: var(--jp-layout-color3, #e5e5e5); border-color: var(--jp-brand-color1, #2196f3); }',
      '#basedpl-input-host .bpl_key:active { background: var(--jp-brand-color2, #1976d2); color: var(--jp-inverse-layout-color1, #fff); }',
      '#basedpl-input-host .bpl_key.unmapped { opacity: .3; }',
      '#basedpl-input-host .bpl_glyphs { display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; min-height: 31px; font-family: var(--jp-content-font-family, sans-serif); font-size: 26px; line-height: 29px; white-space: nowrap; }',
      '#basedpl-input-host .bpl_key.wide { flex-grow: 1.45; }',
      '#basedpl-input-host .bpl_key.space { flex-grow: 5; }',
      '#basedpl-input-host .bpl_glyph_target { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; padding: 0 3px; border-radius: 4px; cursor: pointer; }',
      '#basedpl-input-host .bpl_glyph_target.primary { font-size: 30px; font-weight: 500; }',
      '#basedpl-input-host .bpl_glyph_target:not(.primary) { font-size: 22px; opacity: .82; }',
      '#basedpl-input-host .bpl_glyph_target:hover { background: var(--jp-layout-color3, #e5e5e5); color: var(--jp-brand-color1, #1976d2); }',
      '#basedpl-input-host .bpl_keylabel { display: block; width: 100%; font-size: 11px; line-height: 13px; opacity: .65; text-align: center; text-transform: uppercase; }',
      '#basedpl-input-host .ngn_o { position: absolute !important; top: 4px !important; left: 10px !important; min-width: 72px; height: 27px; border: 1px solid var(--jp-border-color2, #c8c8c8); border-radius: 7px; background: var(--jp-layout-color2, #f5f5f5); color: var(--jp-ui-font-color1, #111); cursor: pointer; font-size: 12px; line-height: 25px; padding: 0 9px; z-index: 3; box-shadow: 0 1px 2px #0002; }',
      '#basedpl-input-host .ngn_o:hover { background: var(--jp-layout-color3, #e5e5e5); border-color: var(--jp-brand-color1, #2196f3); }',
      '#basedpl-input-host .ngn_hide { position: absolute; top: 4px; right: 8px; height: 27px; padding: 0 9px; border: 1px solid var(--jp-border-color2, #c8c8c8); border-radius: 7px; background: var(--jp-layout-color2, #f5f5f5); color: var(--jp-ui-font-color1, #111); cursor: pointer; font-size: 12px; line-height: 25px; z-index: 3; box-shadow: 0 1px 2px #0002; pointer-events:auto; }',
      '#basedpl-input-host .ngn_hide:hover { background: var(--jp-layout-color3, #e5e5e5); border-color: var(--jp-brand-color1,#1976d2); }',
      '#basedpl-input-host .bpl_bar_view { display:flex !important; align-items:center; justify-content:flex-start; flex-wrap:nowrap; gap:3px; width:100%; padding:1px 82px 0 82px; box-sizing:border-box; height:40px; max-height:40px; overflow-x:auto; overflow-y:hidden; white-space:nowrap; scrollbar-width:thin; }',
      '#basedpl-input-host .bpl_bar_view[hidden] { display:none !important; }',
      '#basedpl-input-host .bpl_keyboard_view { display:flex; flex-direction:column; align-items:stretch; width:100%; }',
      '#basedpl-input-host .bpl_keyboard_view[hidden] { display:none !important; }',
      '#basedpl-input-host .bpl_bar_glyph { min-width:34px; height:34px; padding:2px 7px; border:1px solid var(--jp-border-color2,#c8c8c8); border-radius:6px; background:var(--jp-layout-color2,#f5f5f5); color:var(--jp-ui-font-color1,#111); font-family:var(--jp-content-font-family,sans-serif); font-size:22px; cursor:pointer; }',
      '#basedpl-input-host .bpl_bar_glyph:hover { background:var(--jp-layout-color3,#e5e5e5); border-color:var(--jp-brand-color1,#2196f3); }',
      '@media(max-width: 1100px) { #basedpl-input-host .bpl_key { flex-basis: 0; width: auto; height: 48px; } #basedpl-input-host .bpl_glyphs { font-size: 23px; gap: 2px; } #basedpl-input-host .bpl_glyph_target.primary { font-size: 26px; } #basedpl-input-host .bpl_glyph_target:not(.primary) { font-size: 19px; } #basedpl-input-host .bpl_keyrow { gap: 3px; } #basedpl-input-host .ngn_lb { padding-left: 7px; padding-right: 7px; } }'
    ].join('\n');
    document.head.appendChild(style);
    reflow();
    requestAnimationFrame(() => reflow());
    requestAnimationFrame(() => requestAnimationFrame(() => reflow()));
    window.addEventListener('resize', reflow);
  }
};

export default [kernel];
