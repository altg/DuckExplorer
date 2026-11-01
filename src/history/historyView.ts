import * as path from 'path';
import * as vscode from 'vscode';
import { StatementsResult } from '../kernel/protocol';
import { setBaseDirectory } from '../sql/documents';
import { clock, condense, dayKey, dayLabel, formatDuration, HistoryEntry, HistoryOutcome, outcomeText } from './entries';
import { entryIdOf, HISTORY_SCHEME, historyUri, QueryHistory } from './queryHistory';

export type HistoryNode = { kind: 'day'; key: string; entries: HistoryEntry[]; newest: boolean } | { kind: 'entry'; entry: HistoryEntry };

/** Lines of SQL in an entry's tooltip. */
const TOOLTIP_LINES = 30;

/**
 * The Query History view: the queries run in this workspace, by day, newest first. Clicking one shows
 * its SQL in a read-only editor, where it can run again (Ctrl+Enter, or Run above a statement).
 */
export class QueryHistoryView implements vscode.TreeDataProvider<HistoryNode>, vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly id = 'duckexplorer.history';
  readonly tree: vscode.TreeView<HistoryNode>;
  private readonly emitter = new vscode.EventEmitter<HistoryNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly history: QueryHistory) {
    this.tree = vscode.window.createTreeView(QueryHistoryView.id, { treeDataProvider: this, canSelectMany: true });
    this.disposables = [
      this.tree,
      this.emitter,
      history.onDidChange(() => this.emitter.fire(undefined)),
      // "Today" is "Yesterday" the next day.
      this.tree.onDidChangeVisibility((e) => e.visible && this.emitter.fire(undefined)),
      vscode.workspace.registerTextDocumentContentProvider(HISTORY_SCHEME, this),
      // Untitled names are reused once closed: the next Untitled-1 mustn't run in an old query's folder.
      vscode.workspace.onDidCloseTextDocument((document) => setBaseDirectory(document.uri, undefined)),
    ];
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  getChildren(node?: HistoryNode): HistoryNode[] {
    if (node) {
      return node.kind === 'day' ? node.entries.map((entry) => ({ kind: 'entry', entry })) : [];
    }
    const days = new Map<string, HistoryEntry[]>();
    for (const entry of this.history.all) {
      const key = dayKey(entry.time);
      const day = days.get(key);
      if (day) day.push(entry);
      else days.set(key, [entry]);
    }
    return [...days].map(([key, entries], index) => ({ kind: 'day', key, entries, newest: index === 0 }));
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    if (node.kind === 'day') {
      const state = node.newest ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
      const item = new vscode.TreeItem(dayLabel(node.entries[0].time), state);
      item.id = `day:${node.key}`;
      item.description = node.entries.length === 1 ? '1 query' : `${node.entries.length} queries`;
      item.contextValue = 'day';
      return item;
    }
    const { entry } = node;
    const item = new vscode.TreeItem(condense(entry.sql), vscode.TreeItemCollapsibleState.None);
    item.id = entry.id;
    const ran = entry.outcome.kind === 'rows' || entry.outcome.kind === 'done';
    item.description = [clock(entry.time), outcomeText(entry.outcome), ran && formatDuration(entry.elapsedMs)].filter(Boolean).join(' · ');
    item.iconPath = iconOf(entry.outcome);
    item.tooltip = tooltipOf(entry);
    item.contextValue = 'query';
    item.command = { command: 'duckexplorer.showQuery', title: 'Show Query', arguments: [node] };
    return item;
  }

  /** The history's documents: an entry's SQL. */
  provideTextDocumentContent(uri: vscode.Uri): string {
    const entry = this.history.get(entryIdOf(uri));
    if (!entry) {
      return '-- This query is no longer in the query history.\n';
    }
    setBaseDirectory(uri, entry.cwd);
    return entry.sql;
  }

  /** The entries of a command's tree nodes (a day's are all of its queries), else of the view's selection. */
  entriesOf(node?: HistoryNode, nodes?: readonly HistoryNode[]): HistoryEntry[] {
    const chosen = nodes?.length ? nodes : node ? [node] : this.tree.selection;
    return chosen.flatMap((n) => (n.kind === 'day' ? n.entries : [n.entry]));
  }

  /** The query in a read-only editor; a preview tab, so the next one shown takes its place. */
  async show(entry: HistoryEntry, preserveFocus = false): Promise<vscode.TextEditor> {
    const document = await vscode.workspace.openTextDocument(historyUri(entry));
    return vscode.window.showTextDocument(document, { preview: true, preserveFocus });
  }

  /** Runs the query again from its read-only editor; the results view shows how it went. */
  async run(entry: HistoryEntry): Promise<StatementsResult | undefined> {
    const editor = await this.show(entry, true);
    return vscode.commands.executeCommand<StatementsResult | undefined>('duckexplorer.runFile', editor.document.uri);
  }

  /** A copy of the query in a new editor, to change and run; it runs in the folder the query ran in. */
  async openCopy(entry: HistoryEntry): Promise<vscode.TextEditor> {
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: entry.sql });
    setBaseDirectory(document.uri, entry.cwd);
    return vscode.window.showTextDocument(document, { preview: false });
  }

  /** Selects the query where it ran: its cell, or its statements in the file (the nearest copy, if the file changed). */
  async goToSource(entry: HistoryEntry): Promise<boolean> {
    const { source } = entry;
    const uri = vscode.Uri.parse(source.uri);
    const name = path.basename(uri.path);
    // Untitled documents (and the history's own) are found only while they are open.
    const openOnly = uri.scheme === 'untitled' || uri.scheme === HISTORY_SCHEME;
    try {
      if (source.kind === 'notebook') {
        const notebook = openOnly
          ? vscode.workspace.notebookDocuments.find((n) => n.uri.toString() === source.uri)
          : await vscode.workspace.openNotebookDocument(uri);
        if (!notebook) {
          throw new Error('closed');
        }
        const cells = notebook.getCells().filter((cell) => cell.document.getText() === entry.sql);
        const cell = nearest(cells, (c) => c.index, source.at);
        const column = vscode.window.visibleNotebookEditors.find((e) => e.notebook === notebook)?.viewColumn;
        const editor = await vscode.window.showNotebookDocument(notebook, { viewColumn: column });
        if (cell) {
          const range = new vscode.NotebookRange(cell.index, cell.index + 1);
          editor.selection = range;
          editor.revealRange(range, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
          return true;
        }
      } else {
        const document = openOnly
          ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === source.uri)
          : await vscode.workspace.openTextDocument(uri);
        if (!document) {
          throw new Error('closed');
        }
        const text = document.getText();
        const offsets: number[] = [];
        for (let at = text.indexOf(entry.sql); at >= 0; at = text.indexOf(entry.sql, at + 1)) offsets.push(at);
        const at = nearest(offsets, (o) => o, source.at);
        const column = vscode.window.visibleTextEditors.find((e) => e.document === document)?.viewColumn;
        const editor = await vscode.window.showTextDocument(document, { viewColumn: column, preview: false });
        if (at !== undefined) {
          editor.selection = new vscode.Selection(document.positionAt(at), document.positionAt(at + entry.sql.length));
          editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          return true;
        }
      }
      void vscode.window.showInformationMessage(`DuckExplorer: the query is no longer in ${name}.`);
    } catch {
      void vscode.window.showWarningMessage(`DuckExplorer: ${name} is no longer there (closed, moved or deleted).`);
    }
    return false;
  }

  /** Searches every query, not only those of the expanded days; shows the one picked. */
  async search(): Promise<void> {
    type Pick = vscode.QuickPickItem & { entry: HistoryEntry };
    const picks = this.history.all.map<Pick>((entry) => ({
      label: condense(entry.sql),
      iconPath: iconOf(entry.outcome),
      description: [dayLabel(entry.time), clock(entry.time), outcomeText(entry.outcome)].filter(Boolean).join(' · '),
      detail: entry.source.label,
      entry,
    }));
    const pick = await vscode.window.showQuickPick(picks, {
      title: 'Query History',
      placeHolder: picks.length ? 'Search the queries run in this workspace' : 'No queries yet',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (pick) {
      await this.show(pick.entry);
    }
  }

  /** Removes entries from the history, asking first when that's more than one (a day's, say). */
  async remove(entries: readonly HistoryEntry[]): Promise<void> {
    if (entries.length > 1) {
      const message = `Remove ${entries.length} queries from the query history?`;
      const choice = await vscode.window.showWarningMessage(message, { modal: true }, 'Remove');
      if (choice !== 'Remove') {
        return;
      }
    }
    await this.history.remove(entries.map((entry) => entry.id));
  }

  async clear(): Promise<void> {
    if (!this.history.all.length) {
      return;
    }
    const choice = await vscode.window.showWarningMessage('Clear the query history of this workspace?', { modal: true }, 'Clear');
    if (choice === 'Clear') {
      await this.history.clear();
    }
  }
}

function iconOf(outcome: HistoryOutcome): vscode.ThemeIcon {
  switch (outcome.kind) {
    case 'rows':
      return new vscode.ThemeIcon('table');
    case 'done':
      return new vscode.ThemeIcon('check');
    case 'error':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
    case 'interrupted':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('list.warningForeground'));
  }
}

function tooltipOf(entry: HistoryEntry): vscode.MarkdownString {
  const { outcome } = entry;
  const time = formatDuration(entry.elapsedMs);
  const several = (entry.statements ?? 1) > 1;
  let how: string;
  switch (outcome.kind) {
    case 'rows':
    case 'done':
      how = `${[several && `${entry.statements} statements`, outcomeText(outcome)].filter(Boolean).join(', ') || 'Ran'} in ${time}`;
      break;
    case 'error': {
      const which = several && outcome.statement !== undefined ? `Statement ${outcome.statement + 1} of ${entry.statements}` : 'It';
      const message = outcome.message.length > 500 ? `${outcome.message.slice(0, 499)}…` : outcome.message;
      how = `${which} failed: ${message}`;
      break;
    }
    case 'interrupted':
      how = `Interrupted after ${time}`;
      break;
  }
  const when = new Date(entry.time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  const lines = entry.sql.split(/\r?\n/);
  const sql = lines.length > TOOLTIP_LINES ? [...lines.slice(0, TOOLTIP_LINES), '…'].join('\n') : entry.sql;
  const tooltip = new vscode.MarkdownString();
  tooltip.appendText(`${entry.source.label} · ${when}\n${how}\n`);
  tooltip.appendCodeblock(sql, 'sql');
  return tooltip;
}

function nearest<T>(items: T[], position: (item: T) => number, at: number): T | undefined {
  return [...items].sort((a, b) => Math.abs(position(a) - at) - Math.abs(position(b) - at))[0];
}
