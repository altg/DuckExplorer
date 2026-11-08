import * as path from 'path';
import * as vscode from 'vscode';
import { HISTORY_SCHEME } from '../history/queryHistory';
import { KernelClient } from '../kernel/kernelProcess';
import { NOTEBOOK_TYPE, PreviewMessage, PreviewReply, PreviewSource } from '../kernel/protocol';
import { previewTarget, withClause } from './ctes';
import { baseDirectory, notebookOf, sqlFilesEnabled } from './documents';
import { SqlResultsView } from './resultsView';
import { splitStatements, statementAt } from './statements';

/** How long typing or moving the cursor must pause before the preview runs. */
const DELAY_MS = 300;
/** After "busy" (a cell runs), the preview asks again this much later. */
const RETRY_MS = 1000;
/** Rows a preview shows: the kernel fetches one more, to tell whether there are more. */
export const PREVIEW_ROWS = 100;

const FILE_SCHEMES = new Set(['file', 'untitled', HISTORY_SCHEME]);

/** Where the last preview came from, for the results view's CTE chips. */
interface Shown {
  document: vscode.TextDocument;
  /** The statement's offset in the document when it was previewed. */
  statementStart: number;
}

/**
 * Live preview, like DuckDB's Instant SQL: with `duckexplorer.livePreview` on, the query at the cursor
 * in a SQL cell or .sql file runs as you write it (once typing pauses), and the results view shows its
 * first rows. With the cursor in one of its CTEs, it shows that CTE's rows instead (CTE inspection); the
 * view's chips move the cursor to the query or another CTE. Only queries run (the kernel checks):
 * nothing that changes the database, and a preview stops for any other work or after a few seconds.
 * Previews aren't recorded in the query history and don't bind to `df`.
 */
export class LivePreview implements vscode.Disposable {
  private readonly status = vscode.window.createStatusBarItem('duckexplorer.livePreview', vscode.StatusBarAlignment.Right, 100);
  private readonly disposables: vscode.Disposable[];
  private timer: NodeJS.Timeout | undefined;
  /** Bumped for each preview sent: a reply to an older one is dropped. */
  private generation = 0;
  /** What the last preview ran, so that moving within the same query doesn't run it again. */
  private lastKey: string | undefined;
  private shown: Shown | undefined;
  /** The view is revealed for the first preview after turning it on, not on every keystroke. */
  private revealed = false;

  constructor(
    private readonly kernel: KernelClient,
    private readonly view: SqlResultsView,
  ) {
    this.status.name = 'DuckExplorer Live Preview';
    this.status.command = 'duckexplorer.toggleLivePreview';
    this.disposables = [
      this.status,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.updateStatus();
        if (editor) this.schedule(editor);
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => this.schedule(e.textEditor)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode.window.activeTextEditor;
        if (editor?.document === e.document && e.contentChanges.length) this.schedule(editor);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('duckexplorer.livePreview') && !e.affectsConfiguration('duckexplorer.sqlFiles')) return;
        this.updateStatus();
        this.lastKey = undefined;
        this.revealed = false;
        const editor = vscode.window.activeTextEditor;
        if (this.enabled && editor) this.schedule(editor, 0);
        else clearTimeout(this.timer);
      }),
      view.onDidPickPreviewPart((cte) => void this.showPart(cte)),
    ];
    this.updateStatus();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }

  get enabled(): boolean {
    return vscode.workspace.getConfiguration('duckexplorer').get<boolean>('livePreview', false);
  }

  /**
   * Turns the setting on or off (for every workspace). Turned on from a .sql file, it starts the kernel
   * for that file, which otherwise previews only on a kernel that runs already (see preview()).
   */
  async toggle(on = !this.enabled): Promise<void> {
    const document = vscode.window.activeTextEditor?.document;
    if (on && document && isDuckSql(document) && FILE_SCHEMES.has(document.uri.scheme) && !this.kernel.startFailed) {
      void this.kernel.ensureStarted().then(
        () => {
          const editor = vscode.window.activeTextEditor;
          if (editor) this.schedule(editor, 0);
        },
        () => undefined, // reported by the kernel client
      );
    }
    await vscode.workspace.getConfiguration('duckexplorer').update('livePreview', on, vscode.ConfigurationTarget.Global);
  }

  /** Previews the query at the cursor of `editor` now, rather than once typing pauses; for tests. */
  async previewNow(editor: vscode.TextEditor): Promise<PreviewMessage | undefined> {
    clearTimeout(this.timer);
    this.lastKey = undefined;
    return this.preview(editor);
  }

  private schedule(editor: vscode.TextEditor, delay = DELAY_MS): void {
    if (!this.enabled || !isDuckSql(editor.document)) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.preview(editor), delay);
  }

  private async preview(editor: vscode.TextEditor): Promise<PreviewMessage | undefined> {
    const { document } = editor;
    // The setting holds in every workspace, and a .sql file may not be DuckDB's at all: it doesn't
    // start the kernel (as completions don't), unless turned on from there (toggle()).
    const file = FILE_SCHEMES.has(document.uri.scheme);
    if (document.isClosed || this.kernel.startFailed || (file && !this.kernel.isRunning)) {
      return undefined;
    }
    const text = document.getText();
    const offset = document.offsetAt(editor.selection.active);
    const statement = statementAt(splitStatements(text), text, offset);
    if (!statement) {
      return undefined;
    }
    const target = previewTarget(statement.text, offset - statement.start);
    const notebook = notebookOf(document);
    const cwd = baseDirectory(document);
    const key = JSON.stringify([document.uri.toString(), target.sql, cwd]);
    if (key === this.lastKey) {
      return undefined;
    }
    this.lastKey = key;
    const generation = ++this.generation;
    const source: PreviewSource = { label: labelOf(document, statement.start, notebook), sql: statement.text, ctes: target.ctes, cte: target.cte };
    let message: PreviewMessage;
    try {
      const reply = await this.kernel.request<PreviewReply>('previewSql', {
        code: target.sql,
        notebook: notebook?.uri.toString(),
        cwd,
        limit: PREVIEW_ROWS,
      });
      if (generation !== this.generation || reply.skipped === 'superseded') {
        return undefined;
      }
      if (reply.skipped === 'busy' || reply.skipped === 'interrupted') {
        // Asked again once the cell is done (or if the cursor stays, after a pause).
        this.lastKey = undefined;
        this.schedule(editor, RETRY_MS);
        return undefined;
      }
      message = reply.skipped
        ? { type: 'preview', source, note: noteFor(reply.skipped) }
        : reply.error
          ? { type: 'preview', source, error: reply.error.evalue }
          : { type: 'preview', source, table: reply.table };
    } catch (err) {
      if (generation !== this.generation) return undefined;
      message = { type: 'preview', source, error: (err as Error).message };
    }
    this.shown = { document, statementStart: statement.start };
    void this.view.show(message, !this.revealed);
    this.revealed = true;
    return message;
  }

  /** A CTE chip: the cursor goes to the CTE (or the query after the CTEs), which previews it. */
  private async showPart(cte: string | undefined): Promise<void> {
    const shown = this.shown;
    if (!shown || shown.document.isClosed) {
      return;
    }
    const { document } = shown;
    const text = document.getText();
    const statement = statementAt(splitStatements(text), text, shown.statementStart);
    if (!statement) {
      return;
    }
    const clause = withClause(statement.text);
    const found = cte === undefined ? undefined : clause?.ctes.find((c) => c.name === cte);
    const at = statement.start + (found ? found.start : cte === undefined && clause ? clause.queryStart : 0);
    const editor = await showDocument(document);
    const position = document.positionAt(at);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.schedule(editor, 0);
  }

  private updateStatus(): void {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || !isDuckSql(document)) {
      this.status.hide();
      return;
    }
    const on = this.enabled;
    this.status.text = on ? '$(eye) Live Preview' : '$(eye-closed) Live Preview';
    this.status.tooltip = on
      ? `Live preview is on: the query at the cursor runs as you write it, and DuckDB Results shows its first ${PREVIEW_ROWS} rows (or a CTE's, with the cursor in one). Click to turn it off.`
      : 'Live preview is off. Click to run the query at the cursor as you write it.';
    this.status.show();
  }
}

/** SQL cells of DuckDB notebooks, and SQL files where DuckExplorer runs them (`duckexplorer.sqlFiles`). */
export function isDuckSql(document: vscode.TextDocument): boolean {
  if (document.languageId !== 'sql') {
    return false;
  }
  if (FILE_SCHEMES.has(document.uri.scheme)) {
    return sqlFilesEnabled();
  }
  return notebookOf(document)?.notebookType === NOTEBOOK_TYPE;
}

export function labelOf(document: vscode.TextDocument, start: number, notebook: vscode.NotebookDocument | undefined): string {
  if (notebook) {
    const cell = notebook.getCells().find((c) => c.document === document);
    return `${path.basename(notebook.uri.path)}, cell ${(cell?.index ?? 0) + 1}`;
  }
  return `${path.basename(document.uri.path)}:${document.positionAt(start).line + 1}`;
}

function noteFor(skipped: string): string {
  return skipped === 'side effects'
    ? 'Not previewed: the query changes something as it runs (nextval, setseed). Run it to see its rows.'
    : 'Live preview runs queries only (SELECT, FROM, WITH, VALUES…): run this statement to see what it does.';
}

/** The editor of a .sql file or of a notebook's cell, shown and focused. */
async function showDocument(document: vscode.TextDocument): Promise<vscode.TextEditor> {
  const visible = vscode.window.visibleTextEditors.find((e) => e.document === document);
  const notebook = notebookOf(document);
  if (notebook) {
    const editor = await vscode.window.showNotebookDocument(notebook, { preserveFocus: false });
    const cell = notebook.getCells().find((c) => c.document === document);
    if (cell) {
      editor.revealRange(new vscode.NotebookRange(cell.index, cell.index + 1), vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
    }
    return visible ?? vscode.window.showTextDocument(document);
  }
  return vscode.window.showTextDocument(document, { viewColumn: visible?.viewColumn, preview: false });
}
