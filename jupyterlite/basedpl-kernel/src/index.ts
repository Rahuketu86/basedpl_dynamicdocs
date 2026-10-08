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
import input from './input.js';
// The visual Mac-keyboard grid's key-row shape, matching the REPL's own
// `DATA.keyboard`. Not part of BasedPL's real vendored `layout.json` (which
// only has option/alt_aliases/states/unshifted, for the chord engine) --
// kept as its own file so re-vendoring layout.js never clobbers it again.
import keyboardRowsData from './keyboard_rows.js';
import { registerBasedPLWebMCP } from './webmcp.js';

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

    // WebMCP operates on the real current JupyterLite notebook.
    // It never creates a second agent kernel/session, so human edits and agent
    // edits share the same document and BasedPL Jupyter kernel.
    void registerBasedPLWebMCP(notebookTracker).catch(error => {    });

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
        loadSymbols(instance);
        return instance;
      }
    });


    // BasedPL input layer: floating symbol bar + backtick completion + Mac Option keyboard.
    const macLayout = layout as any;
    type GlyphChoice = { glyph: string; name: string };
    type EditorAdapter = {
      id: any; text: string; pos: number; empty: boolean; bpl: boolean;
      rect: () => { left: number; bottom: number };
      insert: (text: string, from?: number) => void;
    };
    // Generic contenteditable adapter, ported from the Chrome extension's
    // content.js -- NOT reading CodeMirror's internal `EditorView`/`state`
    // API (what this used to do, via `cell.editor.editor`). That earlier
    // approach caused real, confirmed problems on this exact JupyterLite page
    // during the extension's own development (see the saved
    // `basedpl_extension` session): CodeMirror's live model can be out of
    // step with what these handlers observe, in ways a plain `Selection`/
    // `Range`-based reader never is, since that always reflects genuine
    // browser cursor state rather than a framework's internal one. "Lines" =
    // direct children of the editable root -- CodeMirror's one `div.cm-line`
    // per line, matching `.cm-content`'s real DOM shape.
    function lineLength(line: ChildNode): number {
      return line.nodeType === Node.TEXT_NODE ? (line.nodeValue?.length ?? 0) : (line.textContent?.length ?? 0);
    }
    function serializeEditable(root: Element): string {
      const lines = [...root.childNodes];
      if (!lines.length) return root.textContent || '';
      return lines.map(n => (n.nodeType === Node.TEXT_NODE ? n.nodeValue : n.textContent)).join('\n');
    }
    function offsetInEditable(root: Element, node: Node | null, nodeOffset: number): number {
      if (node == null) return 0;
      const lines = [...root.childNodes];
      let total = 0;
      for (const line of lines) {
        if (line === node) {
          let sub = 0;
          for (let j = 0; j < nodeOffset && j < line.childNodes.length; j++) sub += lineLength(line.childNodes[j]);
          return total + sub;
        }
        if ((line as Node) === node.parentNode || (node.nodeType === Node.TEXT_NODE && line.contains(node))) {
          const r = document.createRange();
          r.selectNodeContents(line);
          try { r.setEnd(node, nodeOffset); } catch { return total; }
          return total + r.toString().length;
        }
        total += lineLength(line) + 1; // +1 for the inferred '\n' between lines
      }
      return total;
    }
    function positionInEditable(root: Element, offset: number): { node: Node; offset: number } {
      const lines = [...root.childNodes];
      let remaining = offset;
      for (const line of lines) {
        const len = lineLength(line);
        if (remaining <= len) {
          if (line.nodeType === Node.TEXT_NODE) return { node: line, offset: remaining };
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          let node: Node | null, acc = 0;
          while ((node = walker.nextNode())) {
            if (remaining <= acc + (node.nodeValue?.length ?? 0)) return { node, offset: remaining - acc };
            acc += node.nodeValue?.length ?? 0;
          }
          return { node: line, offset: line.childNodes.length };
        }
        remaining -= len + 1;
      }
      const lastLine = lines[lines.length - 1];
      if (!lastLine) return { node: root, offset: 0 };
      return lastLine.nodeType === Node.TEXT_NODE
        ? { node: lastLine, offset: lastLine.nodeValue?.length ?? 0 }
        : { node: lastLine, offset: lastLine.childNodes.length };
    }
    function insertAtSelection(text: string) {
      if (!document.execCommand || !document.execCommand('insertText', false, text)) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(document.createTextNode(text));
          range.collapse(false);
        }
      }
    }
    // `ed` is JupyterLab's `CodeEditor.IEditor` wrapper, used only for
    // `readOnly`/`host` -- `root` is the real contenteditable DOM node
    // (`.cm-content`) everything else reads and writes through directly.
    function contentEditableAdapter(ed: any): EditorAdapter | null {
      if (!ed || ed.readOnly) return null;
      const root: Element | null = ed.host?.querySelector?.('.cm-content');
      if (!root) return null;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const pos = offsetInEditable(root, sel.focusNode, sel.focusOffset);
      return {
        id: root,
        text: serializeEditable(root),
        pos,
        empty: sel.isCollapsed,
        bpl: true,
        rect: () => {
          if (!sel.rangeCount) return { left: root.getBoundingClientRect().left, bottom: root.getBoundingClientRect().bottom };
          const r = sel.getRangeAt(0).cloneRange();
          r.collapse(false);
          const rect = r.getClientRects()[0] || r.getBoundingClientRect();
          return { left: rect.left, bottom: rect.bottom };
        },
        insert: (text: string, from?: number) => {
          (root as HTMLElement).focus?.();
          if (from != null) {
            const start = positionInEditable(root, from), end = positionInEditable(root, pos);
            const range = document.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);
            const s = window.getSelection();
            s?.removeAllRanges();
            if (s) s.addRange(range);
          }
          insertAtSelection(text);
        }
      };
    }

    const last = { editor: null as EditorAdapter | null };
    const snapshotEditor = (): EditorAdapter | null => {
      const cell: any = notebookTracker.activeCell;
      return contentEditableAdapter(cell?.editor) ?? last.editor;
    };
    let active: { id: any; start: number } | undefined;
    let choice: { editor: EditorAdapter; start: number; found: GlyphChoice[] } | undefined;
    let leftAlt = false, rightAlt = false, keyInput = false;

    // The real chord/completion engine (BasedPL's own vendored `input.js`),
    // loaded once the active kernel reports its real symbol table -- see
    // `loadSymbols` below. Replaces the hand-ported `usKey()`/`press()` that
    // used to live here (a manual re-port of this exact logic, which drifted
    // from the real symbol set); `bplInput.reset()` replaces the old
    // module-level `pending` dead-key-state variable.
    // Typed `any`: this is the vendored upstream `input.js`'s factory output,
    // not our own code -- see `jupyterlite/basedpl-kernel/src/input.js`.
    let bplInput: any = null;
    const glyphNames = new Map<string, string>();

    function refreshGlyphTitles() {
      host.querySelectorAll<HTMLElement>('[data-glyph]').forEach(el => {
        const glyph = el.dataset.glyph;
        if (glyph && glyphNames.has(glyph)) el.title = glyphNames.get(glyph) as string;
      });
    }

    function loadSymbols(kernelInstance: BasedPLKernel) {
      kernelInstance.getSymbols()
        .then(rows => {
          glyphNames.clear();
          for (const row of rows) glyphNames.set(row.glyph, row.name);
          bplInput = input(rows, macLayout);
          refreshGlyphTitles();
        })
        .catch(err => console.error('BasedPL: failed to load the symbol table from the kernel', err));
    }

    function editor(): EditorAdapter | null {
      const cell: any = notebookTracker.activeCell;
      return contentEditableAdapter(cell?.editor);
    }

    const host = document.createElement('div');
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

    // Live backtick-completion popup, shown instead of invoking JupyterLab's
    // native notebook completer when the "Live backtick completion" Glyph
    // menu toggle is on (default). Namespaced class (`bpl_tip`, not lb.js's
    // own `bpl_choices`) since this is a small purpose-built popup, not a
    // mount of the vendored `lb.js` bar itself -- we only consume `input.js`'s
    // engine here and keep this extension's own existing bar/keyboard UI.
    const tip = document.createElement('div');
    tip.className = 'bpl_tip';
    tip.hidden = true;
    tip.setAttribute('role', 'listbox');
    // Appended to `document.body`, NOT `host` -- `host` lives inside the
    // Lumino-managed header widget tree, which traps `position: fixed`
    // descendants in its own stacking context regardless of `z-index`
    // (confirmed live: `elementFromPoint` at the tip's own rendered
    // coordinates returned the notebook cell underneath it, not the tip,
    // despite `z-index: 10000`). The REPL's own completion popup and the
    // Chrome extension's popup both already append at the top level for
    // exactly this reason.
    document.body.append(tip);
    let glyphActive: { id: any; start: number } | undefined;
    let glyphChoice: { editor: EditorAdapter; start: number; found: GlyphChoice[] } | undefined;

    const LIVE_COMPLETION_KEY = 'bpl_completion_engine';
    const liveCompletionEnabled = () => {
      try { return localStorage.getItem(LIVE_COMPLETION_KEY) !== 'native'; } catch { return true; }
    };
    const setLiveCompletionEnabled = (enabled: boolean) => {
      try { localStorage.setItem(LIVE_COMPLETION_KEY, enabled ? 'vendor' : 'native'); } catch { /* ignore */ }
    };

    const cancelGlyphCompletion = () => { glyphActive = undefined; glyphChoice = undefined; tip.hidden = true; };
    // Hides the popup without dropping `glyphActive` -- used whenever the
    // *query* just doesn't currently have anything to show (empty, or no
    // matches), as opposed to the backtick context itself going away. Losing
    // `glyphActive` here would mean every later keystroke's `refreshGlyphCompletion`
    // bails out at its first guard forever, even once the query would match
    // again (e.g. after backspacing, or typing past an unmatched prefix).
    const hideGlyphTip = () => { glyphChoice = undefined; tip.hidden = true; };
    // CodeMirror6's own completer reacts to the document change itself, not to
    // DOM keydown propagation, so it can still open independently of our
    // handler regardless of `stopImmediatePropagation()` on the backtick
    // keydown. A synthetic-Escape dismissal was tried here and removed: it
    // didn't actually close the native completer, and worse, our own Escape
    // handler below caught its own synthetic event and cancelled this popup
    // as a side effect. Left as a known cosmetic gap (the native completer
    // may show alongside ours) rather than a functional one -- not solved
    // this round.

    const showGlyphCompletion = (e: EditorAdapter, start: number, found: [string, string][]) => {
      if (!found.length) { hideGlyphTip(); return; }
      tip.replaceChildren();
      found.forEach(([glyph, name], i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.glyph = glyph;
        b.innerHTML = '<span class="bpl_tip_g"></span><span class="bpl_tip_n"></span>';
        (b.querySelector('.bpl_tip_g') as HTMLElement).textContent = glyph;
        (b.querySelector('.bpl_tip_n') as HTMLElement).textContent = name;
        if (i === 0) b.classList.add('selected');
        tip.append(b);
      });
      glyphChoice = { editor: e, start, found: found.map(([glyph, name]) => ({ glyph, name })) };
      glyphActive = { id: e.id, start };
      tip.hidden = false;
      const r = e.rect();
      tip.style.left = Math.max(4, Math.min(r.left, innerWidth - tip.offsetWidth - 8)) + 'px';
      tip.style.top = Math.max(4, Math.min(r.bottom + 4, innerHeight - tip.offsetHeight - 8)) + 'px';
    };

    const refreshGlyphCompletion = () => {
      if (!bplInput || !glyphActive) return;
      const e = editor();
      const item = e && e.bpl && bplInput.entry(e);
      if (item && glyphActive.id === e!.id && glyphActive.start === item.start) {
        showGlyphCompletion(e!, item.start, item.found);
      } else cancelGlyphCompletion();
    };

    tip.addEventListener('mousedown', ev => {
      ev.preventDefault();
      const b = (ev.target as HTMLElement).closest('button');
      if (b && glyphChoice) glyphChoice.editor.insert(b.dataset.glyph as string, glyphChoice.start);
      cancelGlyphCompletion();
    });

    // Use JupyterLab's official shell extension point instead of a fixed body
    // overlay. The header area sits above the main menu; see `reflow()`
    // below for how its height is kept in sync with the actual content.
    const inputWidget = new Widget({ node: host });
    inputWidget.id = 'basedpl-input-widget';
    inputWidget.addClass('bpl-header-widget');
    app.shell.add(inputWidget, 'header', { rank: 501 });

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
      b.title = (glyphNames.get(glyph) ?? glyph);
      barView.appendChild(b);
    }

    // Full Mac keyboard presentation, matching the WebREPL keyboard. The
    // layout includes ordinary physical keys plus every glyph directly
    // represented on those keycaps. Multi-glyph keys expose each glyph as an
    // independent click target (for example = -> + ≠ ≡).
    const keyboardRows = keyboardRowsData as Array<Array<[string, string, string]>>;
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

    // The widget's own height is measured from its actual rendered content
    // (`bar`'s scrollHeight/offsetHeight) rather than a fixed guess -- a
    // fixed `min-height` per mode doesn't track the real content height
    // (which also changes at the `@media(max-width: 1100px)` breakpoint
    // below), leaving a visible gap between the keyboard and the JupyterLab
    // menu bar below it. The `[data-mode]` CSS rules further down are only
    // a floor for the brief window before this first measurement lands.
    //
    // Measuring and setting min-height on this widget alone is still not
    // enough to make JupyterLab's header *region* grow or shrink, though:
    // `#jp-header-panel` positions its single child (this widget) with
    // `position: absolute`, and an absolutely-positioned child's size never
    // propagates up to inflate its ancestor's own size -- that's just how
    // CSS works, regardless of Lumino.
    //
    // We deliberately do NOT use `BoxLayout.setSizeBasis`/`setStretch` here.
    // Those are static methods keyed to attached properties on *our own*
    // imported `@lumino/widgets` module. This extension's webpack build
    // consumes `@lumino/widgets` as a shared singleton at a host-declared
    // range (`^2.3.1-alpha.1`) incompatible with what we require
    // (`^2.7.0`), so our import resolves to a private bundled copy rather
    // than the host's real one -- our `BoxLayout` and the shell's real
    // `BoxLayout` are different classes from different module instances,
    // each with their own separate attached-property storage. Calling our
    // copy's `setSizeBasis` succeeds but writes into a registry the real
    // shell's layout engine never reads, so it has no visible effect.
    //
    // `inputWidget.parent` and `app.shell`, by contrast, are the real,
    // live widget instances from the host's actual shell tree (we got
    // `inputWidget.parent` by being attached into it, and `app` was handed
    // to us directly by the host). Calling `.fit()` on them invokes their
    // real prototype methods regardless of which module compiled the
    // class, so this works independent of any module-federation mismatch:
    // fit the header panel itself first (so it re-derives its own size
    // from its child's current CSS-driven height), then fit the shell
    // (so siblings below the header, e.g. the top panel, reposition to
    // match the header's new size).
    const reflow = () => {
      setMode(mode);
      if (hidden) {
        inputWidget.hide();
      } else {
        inputWidget.show();
      }
      // Clear the explicit inline sizing Lumino leaves behind on *both*
      // levels of the tree -- this widget's own node, and the header panel
      // node one level up (`inputWidget.parent`). A hide/show round trip
      // pins the header panel itself to an explicit `height: 0px` (not just
      // this widget), and that stale value is just as sticky across
      // `fit()` calls as the widget's own height was; clearing only one
      // level leaves the header panel stuck at whichever size it last had.
      inputWidget.node.style.removeProperty('height');
      if (inputWidget.parent) {
        inputWidget.parent.node.style.removeProperty('height');
        inputWidget.parent.node.style.removeProperty('min-height');
      }
      if (!hidden) {
        const contentHeight = Math.max(bar.scrollHeight, bar.offsetHeight);
        inputWidget.node.style.minHeight = contentHeight + 'px';
      }
      inputWidget.parent?.fit();
      app.shell.fit();
    };

    const cancel = () => { active = undefined; cancelGlyphCompletion(); };

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

    const showKeyboard = () => {
      hidden = false;
      setMode('keyboard');
      reflow();
      app.commands.notifyCommandChanged(commandIds.showKeyboard);
      app.commands.notifyCommandChanged(commandIds.showBar);
      app.commands.notifyCommandChanged(commandIds.hide);
    };

    const showBar = () => {
      hidden = false;
      setMode('bar');
      reflow();
      app.commands.notifyCommandChanged(commandIds.showKeyboard);
      app.commands.notifyCommandChanged(commandIds.showBar);
      app.commands.notifyCommandChanged(commandIds.hide);
    };

    const hideInput = () => {
      hidden = true;
      reflow();
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
      hide: 'basedpl:hide',
      toggleLiveCompletion: 'basedpl:toggle-live-completion'
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
    app.commands.addCommand(commandIds.toggleLiveCompletion, {
      label: 'Live Backtick Completion',
      isToggled: () => liveCompletionEnabled(),
      execute: () => {
        setLiveCompletionEnabled(!liveCompletionEnabled());
        cancelGlyphCompletion();
        app.commands.notifyCommandChanged(commandIds.toggleLiveCompletion);
      }
    });

    const glyphMenu = new Menu({ commands: app.commands });
    glyphMenu.title.label = 'Glyph';
    glyphMenu.addItem({ command: commandIds.showKeyboard });
    glyphMenu.addItem({ command: commandIds.showBar });
    glyphMenu.addItem({ command: commandIds.hide });
    glyphMenu.addItem({ type: 'separator' });
    glyphMenu.addItem({ command: commandIds.toggleLiveCompletion });
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
      requestAnimationFrame(() => { remember(); refreshGlyphCompletion(); });
    });
    window.addEventListener('blur', () => { leftAlt = rightAlt = false; bplInput?.reset(); cancel(); });
    window.addEventListener('keyup', ev => {
      if (ev.code === 'AltLeft') leftAlt = false;
      if (ev.code === 'AltRight') rightAlt = false;
      keyInput = false;
      remember();
    }, true);

    // This handler is a direct port of BasedPL's own vendored `lb.js`'s keydown
    // handler (jupyterlite/basedpl-kernel/src/lb.js, not currently mounted --
    // see the note near `host.append(bar)` above), not an independent
    // reimplementation: a from-scratch version of this exact logic went
    // through several rounds of real bugs (popup state getting dropped
    // instead of just hidden, Tab depending on stale stored state instead of
    // recomputing fresh) that lb.js's own structure avoids by construction --
    // notably, Tab/Enter/delimiter-commit below recompute `entry(e)` fresh on
    // every keydown and can commit or (re)open the popup even if `glyphActive`
    // was never set or got cleared, rather than depending on it already being
    // correct going in.
    window.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && ev.isTrusted && glyphChoice) { cancelGlyphCompletion(); ev.preventDefault(); ev.stopImmediatePropagation(); return; }
      keyInput = false;
      if (ev.code === 'AltLeft') leftAlt = true;
      if (ev.code === 'AltRight') rightAlt = true;
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(ev.key)) return;
      const e = editor();
      if (!e || ev.isComposing || ev.defaultPrevented) { cancel(); return; }
      last.editor = e;
      const plain = !ev.ctrlKey && !ev.altKey && !ev.metaKey;
      const pressed = bplInput?.press(ev, leftAlt && !rightAlt && !ev.getModifierState('AltGraph'));
      if (pressed) {
        if (pressed.text) e.insert(pressed.text);
        if (pressed.stop) { cancel(); ev.preventDefault(); ev.stopImmediatePropagation(); return; }
      }

      if (!liveCompletionEnabled() || !bplInput) {
        // Native fallback: only the explicit backtick-invoke of JupyterLab's
        // own completer, backed by the real `Session::complete()`/`complete_glyphs()`.
        if (ev.key === String.fromCharCode(96) && plain) {
          requestAnimationFrame(() => { void app.commands.execute('completer:invoke-notebook'); });
        }
        keyInput = plain && (ev.key.length === 1 || ev.key === 'Backspace');
        return;
      }

      const item = bplInput.entry(e);
      const tab = ev.key === 'Tab' && plain && !ev.shiftKey, enter = ev.key === 'Enter';
      const typed = glyphActive?.id === e.id && glyphActive?.start === item?.start;
      const delimiter = plain && ev.key.length === 1 && !/[a-z]/i.test(ev.key);

      // Claimed here, ahead of JupyterLab's own `completer:invoke-notebook`
      // Tab keybinding, so the two don't both respond to the same keystroke.
      // See jupyterlite/README.md for the caveat: this relies on event-capture
      // ordering, not a hard guarantee.
      if (item && (tab || (typed && (enter || delimiter)))) {
        if (item.found.length === 1) {
          e.insert(item.found[0][0], item.start);
          cancelGlyphCompletion();
        } else if (tab) {
          glyphActive = { id: e.id, start: item.start };
          showGlyphCompletion(e, item.start, item.found);
        }
        if (tab) { ev.preventDefault(); ev.stopImmediatePropagation(); keyInput = false; return; }
      }

      if (ev.key === String.fromCharCode(96) && plain) {
        if (e.empty && bplInput.inCode(e.text.slice(0, e.pos))) {
          // Bootstrap tracking here, at the backtick itself: narrowing it
          // further (as the user types letters) happens later, via the
          // `input` listener's `refreshGlyphCompletion()` below.
          glyphActive = { id: e.id, start: e.pos };
          // Claim the backtick ahead of JupyterLab's native completer: the
          // character still types normally (no `preventDefault`), but native
          // completion tracking never starts via this keydown. That alone
          // isn't airtight: CodeMirror6's own completion extension reacts to
          // the resulting document *change*, not to DOM event propagation, so
          // it can still auto-invoke independently of this handler -- known
          // cosmetic gap, see the removed `dismissNativeCompleterIfOpen()`.
          ev.stopImmediatePropagation();
        } else cancelGlyphCompletion();
      } else if (!(typed && plain && (/^[a-z]$/i.test(ev.key) || ev.key === 'Backspace'))) {
        cancelGlyphCompletion();
      }

      keyInput = plain && (ev.key.length === 1 || ev.key === 'Backspace');
    }, true);

    const style = document.createElement('style');
    style.textContent = [
      '#jp-header-panel { width: 100%; box-sizing: border-box; }',
      // `reflow()` measures the real content height and sets min-height
      // inline once the widget has rendered. These two rules are only a
      // floor for the brief window before that first measurement lands
      // (e.g. the very first paint) -- they intentionally do not need to
      // match the real content height.
      '.bpl-header-widget { width: 100%; box-sizing: border-box; pointer-events: none; }',
      '.bpl-header-widget[data-mode="keyboard"] { min-height: 1px; }',
      '.bpl-header-widget[data-mode="bar"] { min-height: 1px; }',
      '.bpl-header-widget .ngn_lb { position: relative; width: 100%; box-sizing: border-box; pointer-events: auto; background: var(--jp-layout-color1, #fff); color: var(--jp-ui-font-color1, #111); font-family: var(--jp-ui-font-family, sans-serif); border: 1px solid var(--jp-border-color1, #bdbdbd); border-radius: 0 0 8px 8px; padding: 4px 10px 8px; display: flex; flex-direction: column; align-items: center; gap: 6px; box-shadow: var(--jp-elevation-z1, 0 1px 4px #0002); }',
      '.bpl-header-widget .bpl_keyrow { display: flex; justify-content: center; align-items: stretch; gap: 5px; width: 100%; box-sizing: border-box; }',
      '.bpl-header-widget .bpl_key { flex: 1 1 0; min-width: 0; width: auto; height: 52px; padding: 3px; border: 1px solid var(--jp-border-color2, #c8c8c8); border-radius: 7px; background: var(--jp-layout-color2, #f5f5f5); color: var(--jp-ui-font-color1, #111); cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; box-sizing: border-box; user-select: none; font-family: var(--jp-ui-font-family, sans-serif); }',
      '.bpl-header-widget .bpl_key:hover { background: var(--jp-layout-color3, #e5e5e5); border-color: var(--jp-brand-color1, #2196f3); }',
      '.bpl-header-widget .bpl_key:active { background: var(--jp-brand-color2, #1976d2); color: var(--jp-inverse-layout-color1, #fff); }',
      '.bpl-header-widget .bpl_key.unmapped { opacity: .3; }',
      '.bpl-header-widget .bpl_glyphs { display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; min-height: 31px; font-family: var(--jp-content-font-family, sans-serif); font-size: 26px; line-height: 29px; white-space: nowrap; }',
      '.bpl-header-widget .bpl_key.wide { flex-grow: 1.45; }',
      '.bpl-header-widget .bpl_key.space { flex-grow: 5; }',
      '.bpl-header-widget .bpl_glyph_target { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; padding: 0 3px; border-radius: 4px; cursor: pointer; }',
      '.bpl-header-widget .bpl_glyph_target.primary { font-size: 30px; font-weight: 500; }',
      '.bpl-header-widget .bpl_glyph_target:not(.primary) { font-size: 22px; opacity: .82; }',
      '.bpl-header-widget .bpl_glyph_target:hover { background: var(--jp-layout-color3, #e5e5e5); color: var(--jp-brand-color1, #1976d2); }',
      '.bpl-header-widget .bpl_keylabel { display: block; width: 100%; font-size: 11px; line-height: 13px; opacity: .65; text-align: center; text-transform: uppercase; }',
      '.bpl-header-widget .ngn_o { position: absolute !important; top: 4px !important; left: 10px !important; min-width: 72px; height: 27px; border: 1px solid var(--jp-border-color2, #c8c8c8); border-radius: 7px; background: var(--jp-layout-color2, #f5f5f5); color: var(--jp-ui-font-color1, #111); cursor: pointer; font-size: 12px; line-height: 25px; padding: 0 9px; z-index: 3; box-shadow: 0 1px 2px #0002; }',
      '.bpl-header-widget .ngn_o:hover { background: var(--jp-layout-color3, #e5e5e5); border-color: var(--jp-brand-color1, #2196f3); }',
      '.bpl-header-widget .ngn_hide { position: absolute; top: 4px; right: 8px; height: 27px; padding: 0 9px; border: 1px solid var(--jp-border-color2, #c8c8c8); border-radius: 7px; background: var(--jp-layout-color2, #f5f5f5); color: var(--jp-ui-font-color1, #111); cursor: pointer; font-size: 12px; line-height: 25px; z-index: 3; box-shadow: 0 1px 2px #0002; pointer-events:auto; }',
      '.bpl-header-widget .ngn_hide:hover { background: var(--jp-layout-color3, #e5e5e5); border-color: var(--jp-brand-color1,#1976d2); }',
      '.bpl-header-widget .bpl_bar_view { display:flex !important; align-items:center; justify-content:flex-start; flex-wrap:nowrap; gap:3px; width:100%; padding:1px 82px 0 82px; box-sizing:border-box; height:40px; max-height:40px; overflow-x:auto; overflow-y:hidden; white-space:nowrap; scrollbar-width:thin; }',
      '.bpl-header-widget .bpl_bar_view[hidden] { display:none !important; }',
      '.bpl-header-widget .bpl_keyboard_view { display:flex; flex-direction:column; align-items:stretch; width:100%; }',
      '.bpl-header-widget .bpl_keyboard_view[hidden] { display:none !important; }',
      '.bpl-header-widget .bpl_bar_glyph { min-width:34px; height:34px; padding:2px 7px; border:1px solid var(--jp-border-color2,#c8c8c8); border-radius:6px; background:var(--jp-layout-color2,#f5f5f5); color:var(--jp-ui-font-color1,#111); font-family:var(--jp-content-font-family,sans-serif); font-size:22px; cursor:pointer; }',
      '.bpl-header-widget .bpl_bar_glyph:hover { background:var(--jp-layout-color3,#e5e5e5); border-color:var(--jp-brand-color1,#2196f3); }',
      // `.bpl-header-widget` sets `pointer-events: none` so its transparent
      // areas let clicks pass through to the content below -- `.ngn_lb`/
      // `.ngn_hide` above already restore `auto` for the same reason; this
      // popup needs it too, or it renders but silently can't be clicked.
      '.bpl_tip { position: fixed; pointer-events: auto; max-height: 240px; max-width: min(320px, calc(100vw - 16px)); overflow: auto; background: var(--jp-layout-color1, #fff); color: var(--jp-ui-font-color1, #111); border: 1px solid var(--jp-border-color1, #888); border-radius: 6px; box-shadow: 0 3px 12px #0003; padding: 4px; font-family: var(--jp-ui-font-family, sans-serif); font-size: 14px; z-index: 10000; }',
      '.bpl_tip button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 3px 6px; border-radius: 3px; display: block; width: 100%; text-align: left; white-space: nowrap; }',
      '.bpl_tip button:hover, .bpl_tip button.selected { background: var(--jp-brand-color1, #2196f3); color: var(--jp-ui-inverse-font-color1, #fff); }',
      '.bpl_tip_g { display: inline-block; min-width: 1.4em; margin-right: 6px; font-size: 1.1em; }',
      '@media(max-width: 1100px) { .bpl-header-widget .bpl_key { flex-basis: 0; width: auto; height: 48px; } .bpl-header-widget .bpl_glyphs { font-size: 23px; gap: 2px; } .bpl-header-widget .bpl_glyph_target.primary { font-size: 26px; } .bpl-header-widget .bpl_glyph_target:not(.primary) { font-size: 19px; } .bpl-header-widget .bpl_keyrow { gap: 3px; } .bpl-header-widget .ngn_lb { padding-left: 7px; padding-right: 7px; } }'
    ].join('\n');
    document.head.appendChild(style);
    reflow();
    // At this point in plugin activation the widget has only just been
    // attached (via `app.shell.add` above) and has not had an initial
    // layout pass yet, so `bar.scrollHeight`/`offsetHeight` read as 0 --
    // `reflow()` would measure a collapsed box and pin the header to 0px
    // forever. One deferred re-run after the browser has actually laid out
    // the freshly-attached content is enough; every later `reflow()` call
    // (mode/hide/show changes) runs from user interaction, long after this
    // initial attachment, so it doesn't need the same deferral.
    requestAnimationFrame(() => reflow());
  }
};

export default [kernel];
