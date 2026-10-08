import type { INotebookTracker, Notebook, NotebookPanel } from '@jupyterlab/notebook';
import { NotebookActions } from '@jupyterlab/notebook';
import type { ICellModel } from '@jupyterlab/cells';

type WebMCPTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  execute: (
    input: Record<string, unknown>,
    context: { signal: AbortSignal }
  ) => Promise<unknown> | unknown;
};

type WebMCPDocument = Document & {
  modelContext?: {
    registerTool(tool: WebMCPTool, options?: { signal?: AbortSignal }): Promise<void>;
    getTools?: () => Promise<Array<{ name: string }>>;
  };
};

type CellType = 'code' | 'markdown' | 'raw';

const MAX_RETURNED_SOURCE = 12000;
const MAX_RETURNED_OUTPUT_TEXT = 8000;

const textOf = (cell: ICellModel): string => cell.sharedModel.getSource();

const cellIndex = (notebook: Notebook, id: string): number => {
  const index = Array.from(notebook.model!.cells).findIndex(cell => cell.id === id);
  if (index < 0) throw new Error(`CELL_NOT_FOUND: ${id}`);
  return index;
};

const cellAt = (notebook: Notebook, id: string): ICellModel => {
  const index = cellIndex(notebook, id);
  return notebook.model!.cells.get(index);
};

const cellWidget = (notebook: Notebook, id: string) => {
  const widget = notebook.widgets.find(cell => cell.model.id === id);
  if (!widget) throw new Error(`CELL_WIDGET_NOT_FOUND: ${id}`);
  return widget;
};

const notebookOrThrow = (tracker: INotebookTracker): {
  panel: NotebookPanel;
  notebook: Notebook;
} => {
  const panel = tracker.currentWidget;
  if (!panel || !panel.content.model) {
    throw new Error('NO_NOTEBOOK: open a JupyterLite notebook first');
  }
  return { panel, notebook: panel.content };
};

const ensureWritable = (notebook: Notebook): void => {
  if (notebook.model?.readOnly) {
    throw new Error('NOTEBOOK_READ_ONLY: the current notebook is read-only');
  }
};

const hashText = async (text: string): Promise<string> => {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
};

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : text.slice(0, limit) + `… [truncated at ${limit} chars]`;

const outputSummary = (output: any): Record<string, unknown> => {
  if (output.output_type === 'stream') {
    return {
      type: 'stream',
      name: output.name,
      text: truncate(String(output.text ?? ''), MAX_RETURNED_OUTPUT_TEXT)
    };
  }

  if (output.output_type === 'error') {
    return {
      type: 'error',
      ename: output.ename,
      evalue: output.evalue,
      traceback: Array.isArray(output.traceback)
        ? output.traceback.slice(-20)
        : []
    };
  }

  const data = output.data && typeof output.data === 'object'
    ? output.data
    : {};
  const summarizedData: Record<string, unknown> = {};
  for (const [mime, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      summarizedData[mime] = truncate(value, MAX_RETURNED_OUTPUT_TEXT);
    } else if (Array.isArray(value)) {
      summarizedData[mime] = { kind: 'array', length: value.length };
    } else {
      summarizedData[mime] = { kind: typeof value };
    }
  }

  return {
    type: output.output_type,
    execution_count: output.execution_count ?? null,
    data: summarizedData,
    metadata: output.metadata ?? {}
  };
};

const cellSummary = async (
  cell: ICellModel,
  index: number,
  includeSource = false,
  includeOutput = false
): Promise<Record<string, unknown>> => {
  const json = cell.toJSON() as any;
  const source = textOf(cell);
  const result: Record<string, unknown> = {
    id: cell.id,
    index,
    type: cell.type,
    source_hash: await hashText(source),
    source_length: source.length
  };

  if (includeSource) result.source = truncate(source, MAX_RETURNED_SOURCE);

  if (cell.type === 'code') {
    result.execution_count = json.execution_count ?? null;
    const outputs = Array.isArray(json.outputs) ? json.outputs : [];
    result.output_count = outputs.length;
    if (includeOutput) result.outputs = outputs.map(outputSummary);
  }

  return result;
};

const snapshot = async (
  notebook: Notebook,
  ids: string[] = [],
  includeSource = false,
  includeOutput = false
): Promise<Record<string, unknown>> => {
  const cells = Array.from(notebook.model!.cells);
  const selected = ids.length
    ? cells.map((cell, index) => ({ cell, index })).filter(item => ids.includes(item.cell.id))
    : cells.map((cell, index) => ({ cell, index }));

  return {
    path: notebook.model!.toJSON().metadata?.['path'] ?? null,
    cell_count: cells.length,
    active_cell_id: notebook.activeCell?.model.id ?? null,
    cells: await Promise.all(
      selected.map(item => cellSummary(item.cell, item.index, includeSource, includeOutput))
    )
  };
};

const selectedActiveId = (notebook: Notebook): string | null =>
  notebook.activeCell?.model.id ?? null;

const restoreActive = (notebook: Notebook, id: string | null): void => {
  if (!id) return;
  try {
    notebook.select(cellWidget(notebook, id));
  } catch {
    // The active cell may legitimately have been deleted.
  }
};

const unifiedDiff = (oldText: string, newText: string): string =>
  oldText === newText ? 'none: No changes.' : `--- before\\n+++ after\\n- ${oldText}\\n+ ${newText}`;

const editText = (
  oldText: string,
  operation: string,
  input: Record<string, unknown>
): string => {
  if (operation === 'replace') {
    if (typeof input.source !== 'string') {
      throw new Error('INVALID_REQUEST: source is required for replace');
    }
    return input.source;
  }

  if (operation === 'str_replace') {
    const old = typeof input.old === 'string' ? input.old : '';
    const replacement = typeof input.new === 'string' ? input.new : '';
    if (!old) throw new Error('INVALID_REQUEST: old is required for str_replace');
    const replaceAll = input.replace_all !== false;
    if (replaceAll) {
      if (!oldText.includes(old)) return oldText;
      return oldText.split(old).join(replacement);
    }
    const index = oldText.indexOf(old);
    if (index < 0) return oldText;
    return oldText.slice(0, index) + replacement + oldText.slice(index + old.length);
  }

  const lines = oldText.split('\\n');
  if (operation === 'insert_line') {
    const line = Number(input.line);
    if (!Number.isInteger(line) || line < 1 || line > lines.length + 1) {
      throw new Error('INVALID_REQUEST: line must be a 1-based insertion line');
    }
    lines.splice(line - 1, 0, String(input.text ?? ''));
    return lines.join('\\n');
  }

  if (operation === 'replace_lines') {
    const start = Number(input.start);
    const end = Number(input.end ?? start);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
      throw new Error('INVALID_REQUEST: invalid replace_lines range');
    }
    lines.splice(start - 1, end - start + 1, String(input.text ?? ''));
    return lines.join('\\n');
  }

  if (operation === 'delete_lines') {
    const start = Number(input.start);
    const end = Number(input.end ?? start);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
      throw new Error('INVALID_REQUEST: invalid delete_lines range');
    }
    lines.splice(start - 1, end - start + 1);
    return lines.join('\\n');
  }

  throw new Error(`INVALID_OPERATION: unsupported notebook_edit operation ${operation}`);
};

async function addCell(
  notebook: Notebook,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  ensureWritable(notebook);
  const type = (input.type ?? 'code') as CellType;
  if (!['code', 'markdown', 'raw'].includes(type)) {
    throw new Error('INVALID_REQUEST: type must be code, markdown, or raw');
  }
  const source = typeof input.source === 'string' ? input.source : '';
  const before = typeof input.before === 'string' ? input.before : null;
  const after = typeof input.after === 'string' ? input.after : null;
  if (before && after) throw new Error('INVALID_REQUEST: provide before or after, not both');

  const previousActive = selectedActiveId(notebook);
  const cells = Array.from(notebook.model!.cells);
  let insertedIndex = cells.length;

  if (before) {
    insertedIndex = cellIndex(notebook, before);
    const anchor = cellWidget(notebook, before);
    notebook.select(anchor);
    NotebookActions.insertAbove(notebook);
  } else if (after) {
    insertedIndex = cellIndex(notebook, after) + 1;
    const anchor = cellWidget(notebook, after);
    notebook.select(anchor);
    NotebookActions.insertBelow(notebook);
  } else if (cells.length) {
    const active = notebook.activeCellIndex >= 0
      ? notebook.activeCellIndex
      : cells.length - 1;
    insertedIndex = active + 1;
    notebook.select(notebook.widgets[active]);
    NotebookActions.insertBelow(notebook);
  } else {
    NotebookActions.insertBelow(notebook);
    insertedIndex = 0;
  }

  const created = notebook.activeCell;
  if (!created) throw new Error('ADD_FAILED: JupyterLab did not create a cell');

  if (created.model.type !== type) {
    NotebookActions.changeCellType(notebook, type);
  }
  created.model.sharedModel.setSource(source);
  created.editor?.setCursorPosition?.({ line: 0, column: 0 });

  const actualIndex = notebook.activeCellIndex;
  const result = await cellSummary(created.model, actualIndex, true, false);
  restoreActive(notebook, previousActive);
  return result;
}

async function editCell(
  notebook: Notebook,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  ensureWritable(notebook);
  const id = typeof input.id === 'string' ? input.id : '';
  if (!id) throw new Error('INVALID_REQUEST: id is required');
  const cell = cellAt(notebook, id);
  const oldText = textOf(cell);

  if (typeof input.expected_hash === 'string') {
    const actual = await hashText(oldText);
    if (actual !== input.expected_hash) {
      throw new Error(`EDIT_CONFLICT: source hash changed (expected ${input.expected_hash}, got ${actual})`);
    }
  }

  if (input.operation === 'set_type') {
    const type = input.type as CellType;
    if (!['code', 'markdown', 'raw'].includes(type)) {
      throw new Error('INVALID_REQUEST: type must be code, markdown, or raw');
    }
    const previousActive = selectedActiveId(notebook);
    notebook.select(cellWidget(notebook, id));
    NotebookActions.changeCellType(notebook, type);
    restoreActive(notebook, previousActive);
    return {
      id,
      operation: 'set_type',
      type: cellAt(notebook, id).type,
      diff: `type: ${cell.type} → ${type}`
    };
  }

  const operation = typeof input.operation === 'string' ? input.operation : 'replace';
  const newText = editText(oldText, operation, input);
  cell.sharedModel.setSource(newText);

  return {
    id,
    operation,
    diff: unifiedDiff(oldText, newText),
    source_hash: await hashText(newText),
    source: truncate(newText, MAX_RETURNED_SOURCE)
  };
}

async function deleteCells(
  notebook: Notebook,
  ids: string[]
): Promise<Record<string, unknown>> {
  ensureWritable(notebook);
  if (!ids.length) throw new Error('INVALID_REQUEST: ids is required');
  const all = new Set(ids.map(id => cellIndex(notebook, id)));
  if (all.size >= notebook.model!.cells.length) {
    throw new Error('DELETE_REFUSED: refusing to delete every notebook cell');
  }
  const indices = [...all].sort((a, b) => b - a);
  for (const index of indices) notebook.model!.sharedModel.deleteCell(index);
  return { deleted_ids: ids };
}

async function moveCell(
  notebook: Notebook,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  ensureWritable(notebook);
  const ids = Array.isArray(input.ids)
    ? input.ids.filter((id): id is string => typeof id === 'string')
    : [];
  if (ids.length !== 1) {
    throw new Error('INVALID_REQUEST: v1 notebook_move accepts exactly one cell id');
  }
  const id = ids[0];
  const before = typeof input.before === 'string' ? input.before : null;
  const after = typeof input.after === 'string' ? input.after : null;
  if ((before ? 1 : 0) + (after ? 1 : 0) !== 1) {
    throw new Error('INVALID_REQUEST: provide exactly one of before or after');
  }

  const from = cellIndex(notebook, id);
  const target = cellIndex(notebook, (before ?? after) as string);
  if (id === (before ?? after)) throw new Error('INVALID_REQUEST: cannot move a cell relative to itself');

  const destination = before ? target : target + 1;
  const to = destination > from ? destination - 1 : destination;
  NotebookActions.moveCells(notebook, from, to, 1);

  return {
    id,
    from,
    to,
    before,
    after
  };
}

async function runCells(
  panel: NotebookPanel,
  notebook: Notebook,
  ids: string[]
): Promise<Record<string, unknown>> {
  if (!panel.sessionContext.session?.kernel) {
    throw new Error('NO_KERNEL: the current notebook has no running kernel');
  }
  if (!ids.length) throw new Error('INVALID_REQUEST: ids is required');

  const previousActive = selectedActiveId(notebook);
  const results: Record<string, unknown>[] = [];

  try {
    for (const id of ids) {
      const widget = cellWidget(notebook, id);
      notebook.deselectAll();
      notebook.select(widget);
      const ok = await NotebookActions.run(notebook, panel.sessionContext);
      const index = cellIndex(notebook, id);
      const cell = notebook.model!.cells.get(index);
      results.push({
        id,
        ok,
        type: cell.type,
        execution_count: cell.type === 'code' ? (cell.toJSON() as any).execution_count ?? null : null,
        outputs: cell.type === 'code'
          ? ((cell.toJSON() as any).outputs ?? []).map(outputSummary)
          : []
      });
    }
  } finally {
    restoreActive(notebook, previousActive);
  }

  return { results };
}

const schemas = {
  view: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: 'Optional stable cell ids. Omit to return all cells.' },
      include_source: { type: 'boolean' },
      include_output: { type: 'boolean' }
    },
    additionalProperties: false
  },
  find: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      type: { type: 'string', enum: ['code', 'markdown', 'raw'] },
      context: { type: 'integer', minimum: 0, maximum: 3 }
    },
    required: ['query'],
    additionalProperties: false
  },
  add: {
    type: 'object',
    properties: {
      source: { type: 'string' },
      type: { type: 'string', enum: ['code', 'markdown', 'raw'] },
      before: { type: 'string' },
      after: { type: 'string' }
    },
    required: ['source'],
    additionalProperties: false
  },
  edit: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      operation: {
        type: 'string',
        enum: ['replace', 'str_replace', 'insert_line', 'replace_lines', 'delete_lines', 'set_type']
      },
      source: { type: 'string' },
      old: { type: 'string' },
      new: { type: 'string' },
      replace_all: { type: 'boolean' },
      line: { type: 'integer', minimum: 1 },
      start: { type: 'integer', minimum: 1 },
      end: { type: 'integer', minimum: 1 },
      text: { type: 'string' },
      type: { type: 'string', enum: ['code', 'markdown', 'raw'] },
      expected_hash: { type: 'string' }
    },
    required: ['id', 'operation'],
    additionalProperties: false
  },
  delete: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, minItems: 1 }
    },
    required: ['ids'],
    additionalProperties: false
  },
  move: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 1 },
      before: { type: 'string' },
      after: { type: 'string' }
    },
    required: ['ids'],
    additionalProperties: false
  },
  run: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, minItems: 1 }
    },
    required: ['ids'],
    additionalProperties: false
  }
} as const;

export async function registerBasedPLWebMCP(
  notebookTracker: INotebookTracker
): Promise<(() => void) | null> {
  const modelContext = (document as WebMCPDocument).modelContext;
  const status = document.createElement('div');
  status.id = 'basedpl-webmcp-status';
  status.setAttribute('aria-live', 'polite');
  Object.assign(status.style, {
    position: 'fixed',
    right: '12px',
    bottom: '12px',
    zIndex: '2147483647',
    maxWidth: '420px',
    padding: '10px 12px',
    borderRadius: '8px',
    border: '1px solid #bbb',
    background: 'rgba(255,255,255,.96)',
    color: '#222',
    font: '12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif',
    boxShadow: '0 3px 14px rgba(0,0,0,.18)',
    whiteSpace: 'pre-wrap'
  });
  const setStatus = (message: string, ok = true) => {
    status.textContent = message;
    status.style.borderColor = ok ? '#2e7d32' : '#c62828';
  };

  document.getElementById('basedpl-webmcp-status')?.remove();
  document.body.appendChild(status);

  if (!modelContext) {
    setStatus('WebMCP: document.modelContext unavailable', false);
    console.warn('BasedPL WebMCP: document.modelContext unavailable');
    return null;
  }

  setStatus('WebMCP: available\\nRegistering notebook tools…');
  console.info('BasedPL WebMCP: document.modelContext available; registering notebook tools');

  const controller = new AbortController();

  await modelContext.registerTool({
    name: 'notebook_view',
    title: 'View notebook',
    description: 'Inspect the current JupyterLite notebook. Returns stable cell ids, types, source hashes, and optionally source/output.',
    inputSchema: schemas.view,
    annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true },
    execute: async input => {
      const { notebook } = notebookOrThrow(notebookTracker);
      const ids = Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === 'string') : [];
      return snapshot(notebook, ids, input.include_source === true, input.include_output === true);
    }
  }, { signal: controller.signal });

  await modelContext.registerTool({
    name: 'notebook_find',
    title: 'Find notebook cells',
    description: 'Find cells in the current notebook by text. Returns matching stable cell ids and neighboring cell summaries.',
    inputSchema: schemas.find,
    annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true },
    execute: async input => {
      const { notebook } = notebookOrThrow(notebookTracker);
      const query = String(input.query ?? '');
      if (!query) throw new Error('INVALID_REQUEST: query is required');
      const wantedType = typeof input.type === 'string' ? input.type : null;
      const context = Number.isInteger(input.context) ? Number(input.context) : 1;
      const cells = Array.from(notebook.model!.cells);
      const matches = cells
        .map((cell, index) => ({ cell, index }))
        .filter(({ cell }) =>
          (!wantedType || cell.type === wantedType) &&
          textOf(cell).toLowerCase().includes(query.toLowerCase())
        );

      const indexes = new Set<number>();
      for (const match of matches) {
        for (let i = Math.max(0, match.index - context); i <= Math.min(cells.length - 1, match.index + context); i++) {
          indexes.add(i);
        }
      }

      return {
        query,
        matches: matches.map(({ cell, index }) => ({
          id: cell.id,
          index,
          type: cell.type,
          source: truncate(textOf(cell), MAX_RETURNED_SOURCE)
        })),
        context: await Promise.all(
          [...indexes].sort((a, b) => a - b).map(index => cellSummary(cells[index], index, true, false))
        )
      };
    }
  }, { signal: controller.signal });

  await modelContext.registerTool({
    name: 'notebook_add',
    title: 'Add notebook cell',
    description: 'Add a code, markdown, or raw cell before/after a stable cell id. Changes the real user notebook.',
    inputSchema: schemas.add,
    annotations: { readOnlyHint: false, consequentialHint: true, untrustedContentHint: true },
    execute: async input => addCell(notebookOrThrow(notebookTracker).notebook, input)
  }, { signal: controller.signal });

  await modelContext.registerTool({
    name: 'notebook_edit',
    title: 'Edit notebook cell',
    description: 'Edit an existing cell by stable id using whole-source replacement or targeted text/line edits. Returns a diff and new source hash.',
    inputSchema: schemas.edit,
    annotations: { readOnlyHint: false, consequentialHint: true, untrustedContentHint: true },
    execute: async input => editCell(notebookOrThrow(notebookTracker).notebook, input)
  }, { signal: controller.signal });

  await modelContext.registerTool({
    name: 'notebook_delete',
    title: 'Delete notebook cells',
    description: 'Delete one or more notebook cells by stable id. Refuses to delete the final remaining cell.',
    inputSchema: schemas.delete,
    annotations: { readOnlyHint: false, consequentialHint: true, untrustedContentHint: true },
    execute: async input => {
      const ids = Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === 'string') : [];
      return deleteCells(notebookOrThrow(notebookTracker).notebook, ids);
    }
  }, { signal: controller.signal });

  await modelContext.registerTool({
    name: 'notebook_move',
    title: 'Move notebook cell',
    description: 'Move one notebook cell before or after another cell while preserving JupyterLab cell execution state.',
    inputSchema: schemas.move,
    annotations: { readOnlyHint: false, consequentialHint: true, untrustedContentHint: true },
    execute: async input => moveCell(notebookOrThrow(notebookTracker).notebook, input)
  }, { signal: controller.signal });

  await modelContext.registerTool({
    name: 'notebook_run',
    title: 'Run notebook cells',
    description: 'Run one or more cells in the current user notebook using its actual Jupyter kernel and return the resulting cell outputs.',
    inputSchema: schemas.run,
    annotations: { readOnlyHint: false, consequentialHint: true, untrustedContentHint: true },
    execute: async input => {
      const { panel, notebook } = notebookOrThrow(notebookTracker);
      const ids = Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === 'string') : [];
      return runCells(panel, notebook, ids);
    }
  }, { signal: controller.signal });

  if (modelContext.getTools) {
    try {
      const tools = await modelContext.getTools();
      const names = tools.map(tool => tool.name);
      console.info('BasedPL WebMCP: visible notebook tools after registration', names);
      setStatus('WebMCP: registered ✓\\n' + names.map(name => '• ' + name).join('\\n'));
    } catch (error) {
      console.warn('BasedPL WebMCP: getTools() verification failed', error);
      setStatus('WebMCP: registered, verification failed\\nCheck console for details.', false);
    }
  } else {
    setStatus(
      'WebMCP: registered ✓\\nnotebook_view\\nnotebook_find\\nnotebook_add\\nnotebook_edit\\nnotebook_delete\\nnotebook_move\\nnotebook_run\\n(getTools unavailable)'
    );
  }

  return () => controller.abort();
}
