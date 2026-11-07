import * as vscode from 'vscode';
import { KernelClient } from '../kernel/kernelProcess';
import { NOTEBOOK_TYPE, PreviewMessage, PreviewReply, SchemaTree } from '../kernel/protocol';
import { SqlCatalog } from './catalog';
import { baseDirectory, notebookOf } from './documents';
import { isDuckSql, labelOf, PREVIEW_ROWS } from './livePreview';
import { SqlResultsView } from './resultsView';
import { splitStatements, statementAt } from './statements';
import { repairPrompt, sqlOfAnswer, sqlPrompt, trailingDescription } from './textToSql';

/** A language model as VS Code offers it (vscode.lm); tests give their own. */
export type ChatModel = Pick<vscode.LanguageModelChat, 'id' | 'name' | 'vendor' | 'family' | 'sendRequest'>;

/** What Write SQL did, for tests. */
export interface WrittenSql {
  sql: string;
  /** Where the SQL is in the document now (the line with the request, then the statement). */
  range: vscode.Range;
  /** How the statement ran as a preview (the first rows of a query), or DuckDB's error. */
  check: PreviewMessage;
  /** Whether the model was asked again, with DuckDB's error for its first statement. */
  repaired: boolean;
}

/** How Write SQL went: the SQL written, or why there is none (shown to the user), or the user cancelled. */
export type WriteOutcome =
  | { written: WrittenSql }
  | { problem: string; level: 'error' | 'warning' | 'info' }
  | { cancelled: true };

/** Where Write SQL writes: a SQL cell's or .sql file's document, and the selection (or cursor) in it. */
export interface WriteTarget {
  document: vscode.TextDocument;
  selection: vscode.Selection;
}

const JUSTIFICATION = 'DuckExplorer writes the SQL you describe from the names and types of your tables, views, columns and DataFrames.';
const LINE_COMMENT = /^\s*--\s?(.*)$/;

/**
 * Text-to-SQL ("Write SQL from a Description"): a language model that VS Code offers (vscode.lm: GitHub
 * Copilot's, or another extension's) writes a DuckDB statement for a request in the user's words, from
 * the schema the kernel knows (attached databases, opened files, temporary tables, the notebook's
 * DataFrames) and the SQL around the cursor. The statement goes in at the cursor, with the request
 * above it as a comment; it runs as a live preview, and when DuckDB rejects it, the model is asked once
 * more with DuckDB's error.
 */
export class SqlWriter {
  /** The models to choose from. */
  models: () => Thenable<ChatModel[]> = () => vscode.lm.selectChatModels();

  constructor(
    private readonly kernel: KernelClient,
    private readonly catalog: SqlCatalog,
    private readonly view: SqlResultsView,
  ) {}

  /**
   * Asks for the request (unless given) and writes its SQL at `target`: by default the cursor of the
   * active SQL editor, else the selected cell of the active DuckDB notebook (a new SQL cell below it,
   * when that one isn't SQL).
   */
  async write(request?: string, target?: WriteTarget): Promise<WrittenSql | undefined> {
    const outcome = await this.attempt(request, target);
    if ('problem' in outcome) {
      const message = `DuckExplorer: ${outcome.problem}`;
      void (outcome.level === 'error'
        ? vscode.window.showErrorMessage(message)
        : outcome.level === 'warning'
          ? vscode.window.showWarningMessage(message)
          : vscode.window.showInformationMessage(message));
    }
    return 'written' in outcome ? outcome.written : undefined;
  }

  /** Write SQL, saying what went wrong rather than showing it (a cell shows it in its output). */
  async attempt(request?: string, target?: WriteTarget): Promise<WriteOutcome> {
    target ??= await activeTarget();
    if (!target || !isDuckSql(target.document)) {
      return { problem: 'put the cursor in a SQL cell of a DuckDB notebook or in a .sql file, to write SQL there.', level: 'info' };
    }
    const { document } = target;
    const version = document.version;
    const place = placeFor(document, target.selection);
    request ??= await vscode.window.showInputBox({
      title: 'Write SQL from a Description',
      prompt: 'What should the query do? A language model writes it from the names of your tables, views, columns and DataFrames.',
      placeHolder: 'e.g. revenue by month in 2024, and the change from the month before',
      value: place.suggestion,
      ignoreFocusOut: true,
    });
    if (!request?.trim()) {
      return { cancelled: true };
    }
    const model = await this.pickModel();
    if (model === undefined) {
      return { cancelled: true };
    }
    if (typeof model === 'string') {
      return { problem: model, level: 'error' };
    }
    const notebook = notebookOf(document);
    const cwd = baseDirectory(document);
    const snapshot = await this.catalog.snapshot(notebook?.uri.toString(), true, true);
    const text = document.getText();
    const prompt = sqlPrompt({
      request,
      schema: snapshot?.schema ?? EMPTY_SCHEMA,
      frames: snapshot?.frames ?? [],
      duckdbVersion: this.kernel.kernelInfo?.duckdb,
      before: text.slice(0, place.start),
      after: text.slice(place.end),
      notebook: notebook !== undefined,
    });

    const written = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `DuckExplorer: writing SQL with ${model.name}…`, cancellable: true },
      async (_progress, token) => {
        const messages = [vscode.LanguageModelChatMessage.User(prompt)];
        let sql = await ask(model, messages, token);
        let check = await this.check(sql, notebook, cwd);
        let repaired = false;
        if (check.error !== undefined && !token.isCancellationRequested) {
          messages.push(vscode.LanguageModelChatMessage.Assistant(`\`\`\`sql\n${sql}\n\`\`\``), vscode.LanguageModelChatMessage.User(repairPrompt(sql, check.error)));
          sql = await ask(model, messages, token);
          check = await this.check(sql, notebook, cwd);
          repaired = true;
        }
        return token.isCancellationRequested ? undefined : { sql, check, repaired };
      },
    ).then(undefined, (err: unknown) => (err instanceof vscode.CancellationError ? undefined : (err as Error)));
    if (written instanceof Error) {
      return { problem: `${model.name} couldn't write the SQL: ${written.message}`, level: 'error' };
    }
    if (!written) {
      return { cancelled: true };
    }
    if (!written.sql) {
      return { problem: `${model.name} answered without any SQL. Try describing the query another way.`, level: 'warning' };
    }

    // The request goes above the statement as a comment, unless it came from a comment there already.
    const comment = place.fromComment ? '' : `-- ${request.trim().replace(/\s+/g, ' ')}\n`;
    const body = `${comment}${written.sql};`;
    const now = vscode.window.visibleTextEditors.find((e) => e.document === document)?.selection ?? target.selection;
    const at = document.version === version ? place : placeFor(document, document.validateRange(now) as vscode.Selection);
    const startPos = document.positionAt(at.start);
    const endPos = document.positionAt(at.end);
    const lead = at.newLine ? '\n' : '';
    const rest = document.lineAt(endPos.line).text.slice(endPos.character).trim() ? '\n' : '';
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(startPos, endPos), `${lead}${body}${rest}`);
    if (!(await vscode.workspace.applyEdit(edit))) {
      return { problem: 'the SQL could not be added to the editor.', level: 'error' };
    }
    // Where it is now, in lines (the edit takes the document's line endings, which don't change them).
    const lines = body.split('\n');
    const firstLine = startPos.line + (lead ? 1 : 0);
    const firstChar = lead ? 0 : startPos.character;
    const first = new vscode.Position(firstLine, firstChar);
    const range = new vscode.Range(first, new vscode.Position(firstLine + lines.length - 1, (lines.length === 1 ? firstChar : 0) + lines[lines.length - 1].length));
    const shown = vscode.window.visibleTextEditors.find((e) => e.document === document);
    if (shown) {
      shown.selection = new vscode.Selection(range.end, range.end);
      shown.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
    const check: PreviewMessage = { ...written.check, source: { ...written.check.source, label: labelOf(document, document.offsetAt(first), notebook) } };
    void this.view.show(check);
    return { written: { sql: written.sql, range, check, repaired: written.repaired } };
  }

  /**
   * The `duckexplorer.languageModel` setting's model, else the only one, else the one the user picks (and
   * is kept in the setting); undefined when the user picks none, a message when there are none.
   */
  private async pickModel(): Promise<ChatModel | string | undefined> {
    let models: ChatModel[] = [];
    try {
      models = [...(await this.models())];
    } catch {
      // none
    }
    if (!models.length) {
      return 'no language model is available in VS Code to write SQL. Install GitHub Copilot (or another extension that provides chat models) and sign in.';
    }
    const config = vscode.workspace.getConfiguration('duckexplorer');
    const wanted = config.get<string>('languageModel', '').trim().toLowerCase();
    const named = wanted ? models.find((m) => [m.id, m.family, m.name].some((v) => v.toLowerCase() === wanted)) : undefined;
    if (named || models.length === 1) {
      return named ?? models[0];
    }
    type Pick = vscode.QuickPickItem & { model: ChatModel };
    const pick = await vscode.window.showQuickPick<Pick>(
      models.map((model) => ({ label: model.name, description: `${model.vendor} · ${model.family}`, model })),
      {
        title: 'Language model for Write SQL',
        placeHolder: wanted ? `No model "${wanted}" (duckexplorer.languageModel): pick another` : 'Pick the model that writes SQL (kept in the duckexplorer.languageModel setting)',
      },
    );
    if (pick) {
      await config.update('languageModel', pick.model.id, vscode.ConfigurationTarget.Global);
    }
    return pick?.model;
  }

  /** Runs the statement as a preview: its first rows, or DuckDB's error (a statement that isn't a query is only parsed). */
  private async check(sql: string, notebook: vscode.NotebookDocument | undefined, cwd: string | undefined): Promise<PreviewMessage> {
    const source = { label: '', sql, ctes: [] };
    try {
      const reply = await this.kernel.request<PreviewReply>('previewSql', { code: sql, notebook: notebook?.uri.toString(), cwd, limit: PREVIEW_ROWS });
      if (reply.error) return { type: 'preview', source, error: reply.error.evalue };
      if (reply.table) return { type: 'preview', source, table: reply.table };
      return { type: 'preview', source, note: reply.skipped === 'not a query' ? 'Not a query, so not run: run the statement to see what it does.' : 'Not run: run the statement to see its rows.' };
    } catch (err) {
      return { type: 'preview', source, note: `Not run: ${(err as Error).message}` };
    }
  }
}

const EMPTY_SCHEMA: SchemaTree = { current: '', currentSchema: 'main', databases: [] };

/**
 * The cursor of the active SQL editor; else, in the active DuckDB notebook, the selected cell if it is a
 * SQL cell (at its cursor, else its end), or a new SQL cell below it.
 */
async function activeTarget(): Promise<WriteTarget | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && isDuckSql(editor.document)) {
    return { document: editor.document, selection: editor.selection };
  }
  const notebook = vscode.window.activeNotebookEditor;
  if (notebook?.notebook.notebookType !== NOTEBOOK_TYPE) {
    return undefined;
  }
  const index = notebook.selection.isEmpty ? notebook.notebook.cellCount : notebook.selection.end - 1;
  const cell = index < notebook.notebook.cellCount ? notebook.notebook.cellAt(index) : undefined;
  if (cell?.kind === vscode.NotebookCellKind.Code && cell.document.languageId === 'sql') {
    return cellTarget(cell);
  }
  const at = cell ? cell.index + 1 : notebook.notebook.cellCount;
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.notebook.uri, [vscode.NotebookEdit.insertCells(at, [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', 'sql')])]);
  if (!(await vscode.workspace.applyEdit(edit))) {
    return undefined;
  }
  notebook.selection = new vscode.NotebookRange(at, at + 1);
  return cellTarget(notebook.notebook.cellAt(at));
}

/** A cell, at `offset`; else at its editor's cursor when it has one, else after its text (a request in comments at its end: after those). */
export function cellTarget(cell: vscode.NotebookCell, offset?: number): WriteTarget {
  if (offset !== undefined) {
    const at = cell.document.positionAt(offset);
    return { document: cell.document, selection: new vscode.Selection(at, at) };
  }
  const shown = vscode.window.visibleTextEditors.find((e) => e.document === cell.document);
  if (shown) {
    return { document: cell.document, selection: shown.selection };
  }
  const { document } = cell;
  const described = trailingDescription(document.getText());
  const end = described ? document.positionAt(described.end) : document.lineAt(document.lineCount - 1).range.end;
  return { document, selection: new vscode.Selection(end, end) };
}

/**
 * "Write SQL" above a request written as comments at the end of a SQL cell or .sql file (after its last
 * statement): `-- customers who bought books and toys`.
 */
export class WriteSqlLenses implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isDuckSql(document)) {
      return [];
    }
    const described = trailingDescription(document.getText());
    if (!described) {
      return [];
    }
    const start = document.positionAt(described.start);
    return [
      new vscode.CodeLens(new vscode.Range(start, start), {
        title: '$(sparkle) Write SQL',
        tooltip: 'Ask a language model for the DuckDB SQL this comment describes',
        command: 'duckexplorer.writeSql',
        arguments: [described.request, document.uri, described.end],
      }),
    ];
  }
}

/** The model's answer, as SQL. */
async function ask(model: ChatModel, messages: vscode.LanguageModelChatMessage[], token: vscode.CancellationToken): Promise<string> {
  const response = await model.sendRequest(messages, { justification: JUSTIFICATION }, token);
  let answer = '';
  for await (const part of response.text) {
    answer += part;
  }
  return sqlOfAnswer(answer);
}

interface Place {
  /** Offsets the SQL replaces (the same for an insertion). */
  start: number;
  end: number;
  /** It starts a line of its own after the cursor's line. */
  newLine: boolean;
  /** What the input box suggests: a comment on the cursor's line, or the selected text. */
  suggestion: string;
  /** The request came from a comment that stays above the statement. */
  fromComment: boolean;
}

/** Where the SQL goes: in place of the selection; after a comment on the cursor's line; else at the cursor (on a line of its own). */
function placeFor(document: vscode.TextDocument, selection: vscode.Selection): Place {
  const start = document.offsetAt(selection.start);
  const end = document.offsetAt(selection.end);
  if (!selection.isEmpty) {
    const selected = document.getText(selection);
    const suggestion = selected.split(/\r?\n/).map((line) => LINE_COMMENT.exec(line)?.[1] ?? line).join(' ').replace(/\s+/g, ' ').trim();
    return { start, end, newLine: false, suggestion, fromComment: false };
  }
  const line = document.lineAt(selection.active.line);
  const comment = LINE_COMMENT.exec(line.text);
  if (comment) {
    const after = document.offsetAt(line.range.end);
    return { start: after, end: after, newLine: true, suggestion: comment[1].trim(), fromComment: true };
  }
  if (line.isEmptyOrWhitespace) {
    const lineStart = document.offsetAt(line.range.start);
    return { start: lineStart, end: document.offsetAt(line.range.end), newLine: false, suggestion: '', fromComment: false };
  }
  // In a statement: after it (its last line), not in the middle of it.
  const text = document.getText();
  const statement = statementAt(splitStatements(text), text, start);
  const last = statement ? document.lineAt(document.positionAt(statement.through).line) : line;
  const after = document.offsetAt(last.range.end);
  return { start: after, end: after, newLine: true, suggestion: '', fromComment: false };
}
