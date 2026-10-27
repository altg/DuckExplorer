import * as path from 'path';
import * as vscode from 'vscode';
import { KernelClient } from '../kernel/kernelProcess';
import { ExecuteResult, KernelOutput, NOTEBOOK_TYPE, PLOTLY_MIME, RENDERER_ID, TABLE_MIME } from '../kernel/protocol';
import { answerGridRequest, InsertFilteredCell, isGridRequest } from './gridRequests';

interface QueuedCell {
  cell: vscode.NotebookCell;
  execution: vscode.NotebookCellExecution;
}

/**
 * Runs SQL and Python cells of `.duckbook` notebooks on the shared kernel, one at a time, and
 * answers the results renderer's requests (pages, sorted pages, column statistics).
 */
export class DuckbookController implements vscode.Disposable {
  private readonly controller: vscode.NotebookController;
  private readonly messaging: vscode.NotebookRendererMessaging;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly queue: QueuedCell[] = [];
  private running = false;
  private executionOrder = 0;

  constructor(
    private readonly kernel: KernelClient,
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

    const notebookUri = cell.notebook.uri;
    const params = {
      notebook: notebookUri.toString(),
      code: cell.document.getText(),
      cwd: notebookDirectory(notebookUri),
    };
    try {
      const result = await this.kernel.execute<ExecuteResult>(
        language === 'sql' ? 'executeSql' : 'executePython',
        params,
      );
      const outputs = result.outputs.map(toCellOutput);
      if (result.error) {
        outputs.push(
          errorOutput(result.error.ename, result.error.evalue, result.error.traceback || undefined),
        );
      }
      await execution.replaceOutput(outputs);
      execution.end(!result.error, Date.now());
    } catch (err) {
      await execution.replaceOutput(errorOutput('Kernel error', (err as Error).message));
      execution.end(false, Date.now());
    } finally {
      this.onDidExecute();
    }
  }

  private async onRendererMessage(editor: vscode.NotebookEditor, message: unknown): Promise<void> {
    if (isGridRequest(message)) {
      const response = await answerGridRequest(this.kernel, message, (request) => this.insertFilteredCell(editor, request));
      await this.messaging.postMessage(response, editor);
    }
  }

  /**
   * Adds a SQL cell below the one whose output shows the result, rerunning its query with the grid's
   * filter and sort (the kernel rewrites the query), and runs it.
   */
  async insertFilteredCell(editor: vscode.NotebookEditor, { resultId, filter, sort }: InsertFilteredCell): Promise<{}> {
    const source = editor.notebook.getCells().find((cell) => showsResult(cell, resultId));
    if (!source) {
      throw new Error('the cell that made this result was run again or removed.');
    }
    if (source.document.languageId !== 'sql') {
      throw new Error('only results of SQL cells can be rerun as a query.');
    }
    const { code } = await this.kernel.request<{ code: string }>('filteredQuery', {
      resultId,
      code: source.document.getText(),
      filter,
      sort,
    });
    const index = source.index + 1;
    const edit = new vscode.WorkspaceEdit();
    edit.set(editor.notebook.uri, [
      vscode.NotebookEdit.insertCells(index, [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, code, 'sql')]),
    ]);
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error('the notebook could not be edited.');
    }
    const range = new vscode.NotebookRange(index, index + 1);
    editor.selection = range;
    editor.revealRange(range, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
    this.enqueue([editor.notebook.cellAt(index)]);
    return {};
  }
}

function showsResult(cell: vscode.NotebookCell, resultId: string): boolean {
  return cell.outputs.some((output) =>
    output.items.some((item) => item.mime === TABLE_MIME && JSON.parse(Buffer.from(item.data).toString('utf8')).id === resultId),
  );
}

function notebookDirectory(uri: vscode.Uri): string | undefined {
  if (uri.scheme === 'file') {
    return path.dirname(uri.fsPath);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function toCellOutput(output: KernelOutput): vscode.NotebookCellOutput {
  switch (output.type) {
    case 'stream':
      return new vscode.NotebookCellOutput([
        output.name === 'stderr'
          ? vscode.NotebookCellOutputItem.stderr(output.text)
          : vscode.NotebookCellOutputItem.stdout(output.text),
      ]);
    case 'text':
      return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(output.text)]);
    case 'html':
      return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(output.html, 'text/html')]);
    case 'table':
      return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.json(output.table, TABLE_MIME)]);
    case 'png':
      return new vscode.NotebookCellOutput([new vscode.NotebookCellOutputItem(Buffer.from(output.data, 'base64'), 'image/png')]);
    case 'plotly':
      return new vscode.NotebookCellOutput([new vscode.NotebookCellOutputItem(Buffer.from(output.json, 'utf8'), PLOTLY_MIME)]);
  }
}

function errorOutput(name: string, message: string, stack?: string): vscode.NotebookCellOutput {
  return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error({ name, message, stack })]);
}
