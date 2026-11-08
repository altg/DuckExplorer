import * as path from 'path';
import * as vscode from 'vscode';
import { HistoryOutcome, withoutExcerpt } from '../history/entries';
import { QueryHistory } from '../history/queryHistory';
import { KernelClient } from '../kernel/kernelProcess';
import { ExecuteResult, KernelOutput, NOTEBOOK_TYPE, RENDERER_ID, TABLE_MIME, TableResult } from '../kernel/protocol';
import { ExportChoice, Exported, exportRows, ExportSource } from './export';
import { answerGridRequest, chartCell, ExportResult, InsertChartCell, InsertFilteredCell, isGridRequest } from './gridRequests';
import { splitStatements } from '../sql/statements';
import type { WriteOutcome } from '../sql/sqlWriter';
import { Description, trailingDescription } from '../sql/textToSql';
import { errorOutput, LiveOutputs } from './outputs';

interface QueuedCell {
  cell: vscode.NotebookCell;
  execution: vscode.NotebookCellExecution;
}

/**
 * Runs SQL and Python cells of `.duckbook` notebooks on the shared kernel, one at a time, and
 * answers the results renderer's requests (pages, sorted pages, column statistics). SQL cells go
 * into the query history.
 */
export class DuckbookController implements vscode.Disposable {
  private readonly controller: vscode.NotebookController;
  private readonly messaging: vscode.NotebookRendererMessaging;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly queue: QueuedCell[] = [];
  private running = false;
  private executionOrder = 0;
  /** A SQL cell of comments only describes the query to write (Write SQL): writes it into the cell. */
  describedCell: ((cell: vscode.NotebookCell, description: Description) => Promise<WriteOutcome>) | undefined;

  constructor(
    private readonly kernel: KernelClient,
    private readonly history: QueryHistory,
    private readonly onDidExecute: () => void,
  ) {
    this.controller = vscode.notebooks.createNotebookController('duckexplorer-kernel', NOTEBOOK_TYPE, 'DuckDB');
    this.controller.description = 'DuckDB + Python';
    this.controller.supportedLanguages = ['sql', 'python'];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = (cells) => this.enqueue(cells);
    this.controller.interruptHandler = () => this.interrupt();

    this.messaging = vscode.notebooks.createRendererMessaging(RENDERER_ID);
    this.disposables.push(
      this.controller,
      this.messaging.onDidReceiveMessage(({ editor, message }) => this.onRendererMessage(editor, message)),
      vscode.workspace.onDidCloseNotebookDocument((doc) => {
        if (doc.notebookType === NOTEBOOK_TYPE && this.kernel.isRunning) {
          void this.kernel.request('forgetNotebook', { notebook: doc.uri.toString() }).catch(() => undefined);
        }
      }),
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  private enqueue(cells: vscode.NotebookCell[]): void {
    for (const cell of cells) {
      if (cell.kind !== vscode.NotebookCellKind.Code) {
        continue;
      }
      // Created up front so queued cells show as pending.
      this.queue.push({ cell, execution: this.controller.createNotebookCellExecution(cell) });
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      let next: QueuedCell | undefined;
      while ((next = this.queue.shift())) {
        await this.run(next);
      }
    } finally {
      this.running = false;
    }
  }

  private async interrupt(): Promise<void> {
    // Stop the running cell, and drop everything still waiting behind it.
    for (const { execution } of this.queue.splice(0)) {
      execution.end(undefined);
    }
    await this.kernel.interrupt();
  }

  private async run({ cell, execution }: QueuedCell): Promise<void> {
    execution.executionOrder = ++this.executionOrder;
    execution.start(Date.now());
    await execution.clearOutput();

    const language = cell.document.languageId;
    if (language !== 'sql' && language !== 'python') {
      await execution.replaceOutput(
        errorOutput('Unsupported language', `DuckDB notebooks run SQL and Python cells, not ${language}.`),
      );
      execution.end(false, Date.now());
      return;
    }

    const described = language === 'sql' && this.describedCell ? trailingDescription(cell.document.getText()) : undefined;
    if (described?.alone && this.describedCell) {
      await execution.replaceOutput(
        new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stdout(`Writing the SQL for: ${described.request}\n`)]),
      );
      await this.describe(cell, execution, described, this.describedCell);
      return;
    }

    const notebookUri = cell.notebook.uri;
    const params = {
      notebook: notebookUri.toString(),
      code: cell.document.getText(),
      cwd: notebookDirectory(notebookUri),
    };
    const started = Date.now();
    const record = (outcome: HistoryOutcome, elapsedMs = Date.now() - started) => {
      if (language !== 'sql') return;
      const label = `${path.basename(notebookUri.path)}, cell ${cell.index + 1}`;
      this.history.record({
        sql: params.code,
        time: started,
        elapsedMs,
        outcome,
        source: { kind: 'notebook', uri: params.notebook, label, at: cell.index },
        cwd: params.cwd,
      });
    };
    // Outputs show as the cell makes them (prints, figures, display()), not only when it is done.
    const live = new LiveOutputs(execution);
    try {
      const result = await this.kernel.execute<ExecuteResult>(
        language === 'sql' ? 'executeSql' : 'executePython',
        params,
        (update) => live.update(update),
      );
      const outputs = result.outputs ?? live.outputs;
      const table = outputs.find((output) => output.type === 'table')?.table;
      record(cellOutcome(outputs, result.error), table?.elapsedMs);
      const { error } = result;
      await live.finish(error ? [errorOutput(error.ename, error.evalue, error.traceback || undefined)] : []);
      execution.end(!error, Date.now());
    } catch (err) {
      // The kernel stopped: what the cell printed before stays.
      record({ kind: 'error', message: (err as Error).message });
      await live.finish([errorOutput('Kernel error', (err as Error).message)]);
      execution.end(false, Date.now());
    } finally {
      this.onDidExecute();
    }
  }

  /**
   * Writes the SQL a cell's comments describe. A query that ran fine as a preview then runs as the cell;
   * otherwise the cell says why it didn't run: DuckDB's error, a statement that changes the database
   * (left for the user to run), or why no SQL was written.
   */
  private async describe(
    cell: vscode.NotebookCell,
    execution: vscode.NotebookCellExecution,
    described: Description,
    write: (cell: vscode.NotebookCell, description: Description) => Promise<WriteOutcome>,
  ): Promise<void> {
    let outcome: WriteOutcome;
    try {
      outcome = await write(cell, described);
    } catch (err) {
      outcome = { problem: (err as Error).message, level: 'error' };
    }
    if ('cancelled' in outcome) {
      await execution.clearOutput();
      execution.end(undefined);
    } else if ('problem' in outcome) {
      await execution.replaceOutput(errorOutput('No SQL written', outcome.problem.replace(/^./, (c) => c.toUpperCase())));
      execution.end(false, Date.now());
    } else if (outcome.written.check.table) {
      await execution.clearOutput();
      execution.end(undefined);
      this.enqueue([cell]);
    } else if (outcome.written.check.error !== undefined) {
      await execution.replaceOutput(errorOutput('DuckDB rejects the SQL written for this comment', outcome.written.check.error));
      execution.end(false, Date.now());
    } else {
      const note = 'Wrote the SQL for this comment. It is not a query, so it did not run: check it, then run the cell.\n';
      await execution.replaceOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stdout(note)]));
      execution.end(undefined);
    }
  }

  private async onRendererMessage(editor: vscode.NotebookEditor, message: unknown): Promise<void> {
    if (isGridRequest(message)) {
      const response = await answerGridRequest(this.kernel, message, {
        insertFilteredCell: (request) => this.insertFilteredCell(editor, request),
        insertChartCell: (request) => this.insertChartCell(editor, request),
        exportResult: (request) => this.exportResult(editor, request),
      });
      await this.messaging.postMessage(response, editor);
    }
  }

  /**
   * Adds a SQL cell below the one whose output shows the result, rerunning its query with the grid's
   * filter and sort (the kernel rewrites the query), and runs it.
   */
  async insertFilteredCell(editor: vscode.NotebookEditor, { resultId, filter, sort }: InsertFilteredCell): Promise<{}> {
    const source = this.sqlCellOf(editor, resultId, 'rerun as a query');
    const { code } = await this.kernel.request<{ code: string }>('filteredQuery', {
      resultId,
      code: source.document.getText(),
      filter,
      sort,
    });
    await this.insertBelow(editor, source, code, 'sql');
    return {};
  }

  /**
   * "New cell" in a result's Chart view: a Python cell below the result's own that draws the chart (with
   * Altair, else Plotly) over the cell's query, filtered like the grid, and runs it.
   */
  async insertChartCell(editor: vscode.NotebookEditor, request: InsertChartCell): Promise<{}> {
    const source = this.sqlCellOf(editor, request.resultId, 'kept as a chart');
    const code = await chartCell(this.kernel, request, source.document.getText());
    await this.insertBelow(editor, source, code, 'python');
    return {};
  }

  /** The SQL cell whose output shows the result. */
  private sqlCellOf(editor: vscode.NotebookEditor, resultId: string, what: string): vscode.NotebookCell {
    const source = editor.notebook.getCells().find((cell) => tableIn(cell, resultId));
    if (!source) {
      throw new Error('the cell that made this result was run again or removed.');
    }
    if (source.document.languageId !== 'sql') {
      throw new Error(`only results of SQL cells can be ${what}.`);
    }
    return source;
  }

  /** Adds a cell below `source`, selects it and runs it. */
  private async insertBelow(editor: vscode.NotebookEditor, source: vscode.NotebookCell, text: string, language: 'sql' | 'python'): Promise<void> {
    const index = source.index + 1;
    const edit = new vscode.WorkspaceEdit();
    edit.set(editor.notebook.uri, [
      vscode.NotebookEdit.insertCells(index, [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, text, language)]),
    ]);
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error('the notebook could not be edited.');
    }
    const range = new vscode.NotebookRange(index, index + 1);
    editor.selection = range;
    editor.revealRange(range, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
    this.enqueue([editor.notebook.cellAt(index)]);
  }

  /** "Export" under a result: its rows as the grid shows them, to a file (by default beside the notebook). */
  exportResult(editor: vscode.NotebookEditor, { resultId, filter, sort }: ExportResult, choice?: ExportChoice): Promise<Exported | undefined> {
    const { uri } = editor.notebook;
    const cell = editor.notebook.getCells().find((c) => tableIn(c, resultId));
    const stem = path.basename(uri.path, path.extname(uri.path));
    // A result kept as `-- name: sales` is saved as sales.csv.
    const name = (cell && tableIn(cell, resultId)?.boundTo?.[1]) ?? (cell ? `${stem}-cell${cell.index + 1}` : stem);
    const source: ExportSource = {
      title: filter ? 'Export the filtered rows' : 'Export the rows',
      name,
      folder: notebookDirectory(uri),
      method: 'exportResult',
      params: { resultId, filter, sort },
      rerun: 'Run the cell again',
    };
    return exportRows(this.kernel, source, choice);
  }
}

/** How a SQL cell went, for the history. */
function cellOutcome(outputs: KernelOutput[], error: ExecuteResult['error']): HistoryOutcome {
  if (error) {
    return error.ename === 'KeyboardInterrupt' ? { kind: 'interrupted' } : { kind: 'error', message: withoutExcerpt(error.evalue) };
  }
  const table = outputs.find((output) => output.type === 'table')?.table;
  return table ? { kind: 'rows', rows: table.rowCount } : { kind: 'done' };
}

/** The result `resultId` among the cell's outputs. */
function tableIn(cell: vscode.NotebookCell, resultId: string): TableResult | undefined {
  for (const item of cell.outputs.flatMap((output) => output.items)) {
    const table = item.mime === TABLE_MIME ? (JSON.parse(Buffer.from(item.data).toString('utf8')) as TableResult) : undefined;
    if (table?.id === resultId) return table;
  }
  return undefined;
}

/** The folder a notebook's cells run in: relative paths in them resolve against it. */
export function notebookDirectory(uri: vscode.Uri): string | undefined {
  if (uri.scheme === 'file') {
    return path.dirname(uri.fsPath);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
