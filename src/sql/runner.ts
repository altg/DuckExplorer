import * as path from 'path';
import * as vscode from 'vscode';
import { HistoryOutcome } from '../history/entries';
import { HISTORY_SCHEME, QueryHistory, QueryRun } from '../history/queryHistory';
import { KernelClient } from '../kernel/kernelProcess';
import { RunSource, StatementError, StatementsResult } from '../kernel/protocol';
import { ExportChoice, Exported, exportRows, ExportSource } from '../notebook/export';
import { chartCell, ExportResult, InsertChartCell, InsertFilteredCell } from '../notebook/gridRequests';
import { runInNotebook } from '../notebook/insert';
import { baseDirectory, setBaseDirectory, sqlFilesEnabled } from './documents';
import { SqlResultsView } from './resultsView';
import { splitStatements, Statement, statementAt } from './statements';

/** What a DuckDB error position points at: a name, a quoted name or string, else one character. */
const ERROR_TOKEN = /"(?:[^"]|"")*"|'(?:[^']|'')*'|[\w$]+/;

/** A run of statements from a .sql file, and where they were when it started. */
interface Run {
  document: vscode.TextDocument;
  version: number;
  statements: Statement[];
  source: RunSource;
  result?: StatementsResult;
}

/**
 * Runs the statements of .sql files on the shared kernel (the same session as notebooks): the one
 * at the cursor, the selected ones, or the whole file. The results view shows the last one's rows;
 * an error is also marked in the file. Also offers a Run CodeLens above each statement. Each run
 * goes into the query history.
 */
export class SqlFileRunner implements vscode.CodeLensProvider, vscode.Disposable {
  readonly view: SqlResultsView;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('duckexplorer');
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  private readonly disposables: vscode.Disposable[];
  private latest: Run | undefined;

  constructor(
    extensionUri: vscode.Uri,
    private readonly kernel: KernelClient,
    private readonly history: QueryHistory,
    private readonly onDidExecute: () => void,
  ) {
    this.view = new SqlResultsView(extensionUri, kernel, {
      cancel: () => void kernel.interrupt(),
      reveal: () => void this.reveal(),
      insertFilteredCell: (request) => this.insertQuery(request),
      insertChartCell: (request) => this.insertChartCell(request),
      exportResult: (request) => this.exportResult(request),
    });
    this.disposables = [
      this.diagnostics,
      this.lensesChanged,
      // An error's place moves with edits: it is cleared until the next run.
      vscode.workspace.onDidChangeTextDocument((e) => e.contentChanges.length && this.diagnostics.delete(e.document.uri)),
      vscode.workspace.onDidCloseTextDocument((document) => this.diagnostics.delete(document.uri)),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('duckexplorer.sqlFiles') && this.lensesChanged.fire()),
    ];
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!sqlFilesEnabled()) {
      return [];
    }
    return splitStatements(document.getText()).map((statement) => {
      const start = document.positionAt(statement.start);
      return new vscode.CodeLens(new vscode.Range(start, start), {
        title: '$(play) Run',
        tooltip: 'Run this statement with DuckDB',
        command: 'duckexplorer.runStatement',
        arguments: [document.uri, statement.start],
      });
    });
  }

  /** The statement at `offset` (a CodeLens) or the cursor, or the statements in the selection. */
  async runStatement(uri?: vscode.Uri, offset?: number): Promise<StatementsResult | undefined> {
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri?.toString()) ??
      (uri ? undefined : vscode.window.activeTextEditor);
    const document = editor?.document ?? (uri ? await vscode.workspace.openTextDocument(uri) : undefined);
    if (!document) {
      return undefined;
    }
    let statements: Statement[];
    if (typeof offset !== 'number' && editor && !editor.selection.isEmpty) {
      statements = splitStatements(document.getText(editor.selection), document.offsetAt(editor.selection.start));
    } else {
      const text = document.getText();
      const at = typeof offset === 'number' ? offset : editor ? document.offsetAt(editor.selection.active) : 0;
      const statement = statementAt(splitStatements(text), text, at);
      statements = statement ? [statement] : [];
    }
    return this.run(document, statements);
  }

  async runFile(uri?: vscode.Uri): Promise<StatementsResult | undefined> {
    const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    return document && this.run(document, splitStatements(document.getText()));
  }

  private async run(document: vscode.TextDocument, statements: Statement[]): Promise<StatementsResult | undefined> {
    if (!statements.length) {
      void vscode.window.showInformationMessage('DuckExplorer: there is no SQL statement to run here.');
      return undefined;
    }
    const line = document.positionAt(statements[0].start).line + 1;
    const source: RunSource = {
      label: `${path.basename(document.uri.path)}:${line}`,
      sql: statements.map((s) => s.text).join(';\n'),
      statements: statements.length,
    };
    const run: Run = { document, version: document.version, statements, source };
    this.latest = run;
    this.diagnostics.delete(document.uri);
    void this.view.show({ type: 'running', source });
    const cwd = baseDirectory(document);
    // For the history: the statements as written, with what is between them.
    const sql = document.getText().slice(statements[0].start, statements[statements.length - 1].through);
    const started = Date.now();
    const ran = (outcome: HistoryOutcome, elapsedMs = Date.now() - started): QueryRun => ({
      sql,
      time: started,
      elapsedMs,
      statements: statements.length,
      outcome,
      source: { kind: 'file', uri: document.uri.toString(), label: source.label, at: statements[0].start },
      cwd,
    });
    try {
      const result = await this.kernel.execute<StatementsResult>('runStatements', {
        statements: statements.map((s) => s.text),
        cwd,
      });
      run.result = result;
      this.history.record(ran(outcomeOf(result), result.elapsedMs));
      if (result.error && result.error.ename !== 'KeyboardInterrupt') {
        this.mark(run, result.error);
      }
      if (this.latest === run) void this.view.show({ type: 'result', source, result });
      return result;
    } catch (err) {
      this.history.record(ran({ kind: 'error', message: (err as Error).message }));
      if (this.latest === run) void this.view.show({ type: 'failed', source, message: (err as Error).message });
      return undefined;
    } finally {
      this.onDidExecute();
    }
  }

  /** Marks the error in the file, where DuckDB says it is (else on the statement's first line). */
  private mark(run: Run, error: StatementError): void {
    const { document } = run;
    if (!unchanged(run, document)) {
      return;
    }
    const statement = run.statements[error.statement];
    let range: vscode.Range;
    if (error.position !== undefined) {
      const start = document.positionAt(statement.start + error.position);
      range = document.getWordRangeAtPosition(start, ERROR_TOKEN) ?? document.validateRange(new vscode.Range(start, start.translate(0, 1)));
    } else {
      const start = document.positionAt(statement.start);
      const end = document.positionAt(statement.end);
      range = new vscode.Range(start, end.line === start.line ? end : document.lineAt(start.line).range.end);
    }
    const diagnostic = new vscode.Diagnostic(range, error.message, vscode.DiagnosticSeverity.Error);
    diagnostic.source = 'DuckDB';
    this.diagnostics.set(document.uri, [diagnostic]);
  }

  /** The results view's file link: the statement (or its error) in the editor. */
  private async reveal(): Promise<void> {
    const run = this.latest;
    if (!run) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(run.document.uri);
    const editor = await vscode.window.showTextDocument(document, { viewColumn: this.columnOf(document), preview: false });
    const last = run.statements[run.statements.length - 1];
    const failed = run.result?.error && run.statements[run.result.error.statement];
    const statement = this.find(run, document, failed || last);
    if (statement) {
      const error = run.result?.error;
      const at = failed && error?.position !== undefined && unchanged(run, document) ? statement.start + error.position : undefined;
      editor.selection =
        at !== undefined
          ? new vscode.Selection(document.positionAt(at), document.positionAt(at))
          : new vscode.Selection(document.positionAt(statement.start), document.positionAt(statement.through));
      editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  /**
   * The grid's "Insert query": the statement that made the result, rewritten to the grid's filter and
   * sort, goes below that statement, and runs.
   */
  private async insertQuery({ resultId, filter, sort }: InsertFilteredCell): Promise<{}> {
    const run = this.latest;
    if (run?.result?.table?.id !== resultId) {
      throw new Error('the results view shows another result since.');
    }
    const statement = run.statements[run.statements.length - 1];
    const { code } = await this.kernel.request<{ code: string }>('filteredQuery', { resultId, code: statement.text, filter, sort });
    const document = await vscode.workspace.openTextDocument(run.document.uri);
    if (document.uri.scheme === HISTORY_SCHEME) {
      // The history's documents are read-only: the query goes into a new editor.
      const copy = await vscode.workspace.openTextDocument({ language: 'sql', content: `${code};\n` });
      setBaseDirectory(copy.uri, baseDirectory(document));
      await vscode.window.showTextDocument(copy, { viewColumn: this.columnOf(document), preview: false });
      void this.run(copy, splitStatements(copy.getText()));
      return {};
    }
    const current = this.find(run, document, statement);
    if (!current) {
      throw new Error('the statement that made this result was changed or removed.');
    }
    const line = document.positionAt(current.through).line;
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, document.lineAt(line).range.end, `\n\n${code};`);
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error('the file could not be edited.');
    }
    // The edit takes the file's line endings, so the new statement is found rather than computed.
    const start = document.offsetAt(new vscode.Position(line + 2, 0));
    const added = splitStatements(document.getText()).find((s) => s.start === start);
    if (!added) {
      throw new Error('the query was added, but could not be found to run it.');
    }
    const editor = await vscode.window.showTextDocument(document, { viewColumn: this.columnOf(document), preview: false });
    editor.selection = new vscode.Selection(document.positionAt(added.start), document.positionAt(added.through));
    editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    void this.run(document, [added]);
    return {};
  }

  /**
   * "New cell" in the Chart view: a .sql file has no Python, so the chart's code goes into a notebook (the
   * active or a visible one, else a new one), over the statement that made the result.
   */
  private async insertChartCell(request: InsertChartCell): Promise<{}> {
    const run = this.latest;
    if (run?.result?.table?.id !== request.resultId) {
      throw new Error('the results view shows another result since.');
    }
    const statement = run.statements[run.statements.length - 1];
    await runInNotebook(await chartCell(this.kernel, request, statement.text), 'python');
    return {};
  }

  /** The grid's "Export": the rows as the grid shows them, to a file (by default beside the .sql file). */
  exportResult({ resultId, filter, sort }: ExportResult, choice?: ExportChoice): Promise<Exported | undefined> {
    const run = this.latest?.result?.table?.id === resultId ? this.latest : undefined;
    const uri = run?.document.uri;
    const source: ExportSource = {
      title: filter ? 'Export the filtered rows' : 'Export the rows',
      name: uri ? path.basename(uri.path, path.extname(uri.path)) : 'results',
      folder: run && baseDirectory(run.document),
      method: 'exportResult',
      params: { resultId, filter, sort },
      rerun: 'Run the statement again',
    };
    return exportRows(this.kernel, source, choice);
  }

  /** Where a statement of `run` is now: where it was while the file is unchanged, else the same text nearest to there. */
  private find(run: Run, document: vscode.TextDocument, statement: Statement): Statement | undefined {
    if (unchanged(run, document)) {
      return statement;
    }
    const distance = (s: Statement) => Math.abs(s.start - statement.start);
    return splitStatements(document.getText())
      .filter((s) => s.text === statement.text)
      .sort((a, b) => distance(a) - distance(b))[0];
  }

  private columnOf(document: vscode.TextDocument): vscode.ViewColumn | undefined {
    return vscode.window.visibleTextEditors.find((e) => e.document === document)?.viewColumn;
  }
}

function outcomeOf(result: StatementsResult): HistoryOutcome {
  if (result.error) {
    return result.error.ename === 'KeyboardInterrupt'
      ? { kind: 'interrupted' }
      : { kind: 'error', message: result.error.message, statement: result.error.statement };
  }
  return result.table ? { kind: 'rows', rows: result.table.rowCount } : { kind: 'done', message: result.message || undefined };
}

/** The file is as it was when the run started, so the run's offsets still hold. */
function unchanged(run: Run, document: vscode.TextDocument): boolean {
  return document === run.document && !document.isClosed && document.version === run.version;
}
