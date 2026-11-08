import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DatabasesDropController } from './explorer/dropFiles';
import {
  AttachedDatabases,
  FILES_DATABASE,
  inFilesDatabase,
  OpenedFiles,
  qualifiedName,
  SchemaTreeProvider,
  TreeNode,
} from './explorer/schemaTree';
import { TableSummaryPanel } from './explorer/summaryPanel';
import { ViewSqlDocuments } from './explorer/viewSql';
import { HistoryEntry } from './history/entries';
import { HistoryNode, QueryHistoryView } from './history/historyView';
import { HISTORY_SCHEME, QueryHistory } from './history/queryHistory';
import { KernelClient } from './kernel/kernelProcess';
import { NOTEBOOK_TYPE } from './kernel/protocol';
import { DuckbookController } from './notebook/controller';
import { ExportChoice, exportRows, ExportSource } from './notebook/export';
import { openNotebookWith, runInNotebook } from './notebook/insert';
import { DuckbookSerializer } from './notebook/serializer';
import { SqlCatalog } from './sql/catalog';
import { SqlLanguageFeatures, TRIGGER_CHARACTERS } from './sql/completion';
import { SqlDropProvider } from './sql/drop';
import { LivePreview } from './sql/livePreview';
import { fileKind, READABLE } from './sql/files';
import { quoteIdentifier } from './sql/identifiers';
import { SqlResultsView } from './sql/resultsView';
import { SqlFileRunner } from './sql/runner';
import { cellTarget, SqlWriter, WriteSqlLenses } from './sql/sqlWriter';

/** Returned from activate() so integration tests can reach the kernel, tree, controller, summary, catalog, runner, history and drops. */
export interface DuckExplorerApi {
  kernel: KernelClient;
  tree: SchemaTreeProvider;
  controller: DuckbookController;
  summary: TableSummaryPanel;
  catalog: SqlCatalog;
  runner: SqlFileRunner;
  history: QueryHistory;
  historyView: QueryHistoryView;
  /** Files dropped on the Databases view. */
  treeDrop: DatabasesDropController;
  /** Files dropped into SQL cells and .sql files. */
  sqlDrop: SqlDropProvider;
  livePreview: LivePreview;
  sqlWriter: SqlWriter;
}

export function activate(context: vscode.ExtensionContext): DuckExplorerApi {
  const log = vscode.window.createOutputChannel('DuckExplorer', { log: true });
  const kernel = new KernelClient(context.extensionPath, log, kernelSettings);
  const attached = new AttachedDatabases(context.workspaceState);
  const opened = new OpenedFiles(context.workspaceState);
  const tree = new SchemaTreeProvider(kernel, attached, opened);
  const catalog = new SqlCatalog(kernel, log);
  // After anything that may add or drop tables, functions or DataFrames.
  const refreshNames = (soon = false) => {
    catalog.invalidate();
    if (soon) {
      tree.scheduleRefresh();
    } else {
      tree.refresh();
    }
  };
  const history = new QueryHistory(context.workspaceState);
  const historyView = new QueryHistoryView(history);
  const controller = new DuckbookController(kernel, history, () => refreshNames(true));
  const summary = new TableSummaryPanel(context.extensionUri, kernel);
  const viewSql = new ViewSqlDocuments(kernel);
  const runner = new SqlFileRunner(context.extensionUri, kernel, history, () => refreshNames(true));
  const sql = new SqlLanguageFeatures(catalog);
  const livePreview = new LivePreview(kernel, runner.view);
  const sqlWriter = new SqlWriter(kernel, catalog, runner.view);
  // Running a SQL cell of comments only writes the SQL they describe, then runs it.
  controller.describedCell = (cell, { request, end }) => sqlWriter.attempt(request, cellTarget(cell, end));
  const sqlFiles: vscode.DocumentFilter[] = [
    { language: 'sql', scheme: 'file' },
    { language: 'sql', scheme: 'untitled' },
    { language: 'sql', scheme: HISTORY_SCHEME },
  ];
  // History commands act on the entry they're given (from the view), else the view's selection.
  const onEntry = (action: (entry: HistoryEntry) => unknown) => (node?: HistoryNode) => {
    const [entry] = historyView.entriesOf(node);
    return entry && action(entry);
  };
  const sqlEditors: vscode.DocumentSelector = [{ notebookType: NOTEBOOK_TYPE, language: 'sql' }, ...sqlFiles];
  const open = (files: vscode.Uri[]) => openFiles(files, kernel, attached, opened, summary, refreshNames);
  const treeDrop = new DatabasesDropController(open);
  const sqlDrop = new SqlDropProvider();

  context.subscriptions.push(
    log,
    kernel,
    controller,
    summary,
    viewSql,
    catalog,
    runner,
    livePreview,
    history,
    historyView,
    vscode.languages.registerCompletionItemProvider(sqlEditors, sql, ...TRIGGER_CHARACTERS),
    vscode.languages.registerSignatureHelpProvider(sqlEditors, sql, { triggerCharacters: ['(', ','], retriggerCharacters: [','] }),
    vscode.languages.registerCodeLensProvider(sqlFiles, runner),
    vscode.window.registerWebviewViewProvider(SqlResultsView.id, runner.view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new DuckbookSerializer(), DuckbookSerializer.options),
    vscode.window.createTreeView('duckexplorer.schema', { treeDataProvider: tree, dragAndDropController: treeDrop }),
    vscode.languages.registerDocumentDropEditProvider(sqlEditors, sqlDrop, SqlDropProvider.metadata),

    kernel.onDidStart(async () => {
      for (const db of attached.list()) {
        try {
          await kernel.request('attach', { path: db.path, readOnly: db.readOnly });
        } catch (err) {
          log.warn(`Could not re-attach ${db.path}: ${(err as Error).message}`);
          void vscode.window.showWarningMessage(`DuckExplorer: could not re-attach ${path.basename(db.path)}: ${(err as Error).message}`);
        }
      }
      for (const file of opened.list()) {
        if (!fs.existsSync(file.path)) {
          await opened.remove(file.path);
          void vscode.window.showWarningMessage(`DuckExplorer: ${path.basename(file.path)} is gone, so ${FILES_DATABASE}.${file.name} was closed.`);
          continue;
        }
        try {
          const { name } = await kernel.request<{ name: string }>('openFile', { path: file.path, name: file.name });
          if (name !== file.name) await opened.add({ path: file.path, name });
        } catch (err) {
          log.warn(`Could not open ${file.path} again: ${(err as Error).message}`);
          void vscode.window.showWarningMessage(`DuckExplorer: could not open ${path.basename(file.path)} again: ${(err as Error).message}`);
        }
      }
      refreshNames();
      summary.reload();
    }),
    vscode.window.onDidChangeActiveColorTheme(() => kernel.reconfigure()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('duckexplorer.pageSize') || e.affectsConfiguration('duckexplorer.maxPandasRows')) {
        void kernel.reconfigure();
      }
      if (e.affectsConfiguration('duckexplorer.pythonPath') && kernel.isRunning) {
        void vscode.window
          .showInformationMessage('DuckExplorer: restart the kernel to use the new Python interpreter.', 'Restart Kernel')
          .then((choice) => choice && vscode.commands.executeCommand('duckexplorer.restartKernel'));
      }
    }),

    vscode.commands.registerCommand('duckexplorer.addDatabase', () => addDatabase(kernel, attached, refreshNames)),
    // From the Explorer: the file clicked, and every file selected.
    vscode.commands.registerCommand('duckexplorer.openFiles', (uri?: unknown, uris?: unknown) => {
      const files = Array.isArray(uris) && uris.length ? uris : [uri];
      return open(files.filter((file): file is vscode.Uri => file instanceof vscode.Uri));
    }),
    vscode.commands.registerCommand('duckexplorer.detachDatabase', async (node?: TreeNode) => {
      if (node?.kind !== 'database' || !node.db.path) {
        return;
      }
      await attached.remove(node.db.path);
      try {
        await kernel.request('detach', { alias: node.db.name });
      } catch (err) {
        void vscode.window.showErrorMessage(`DuckExplorer: ${(err as Error).message}`);
      }
      refreshNames();
    }),
    vscode.commands.registerCommand('duckexplorer.closeFile', async (node?: TreeNode) => {
      if (node?.kind !== 'relation' || !inFilesDatabase(node)) {
        return;
      }
      const file = opened.list().find((entry) => entry.name === node.relation.name);
      if (file) await opened.remove(file.path);
      try {
        await kernel.request('closeFile', { name: node.relation.name });
      } catch (err) {
        void vscode.window.showErrorMessage(`DuckExplorer: ${(err as Error).message}`);
      }
      refreshNames();
    }),
    vscode.commands.registerCommand('duckexplorer.refresh', () => refreshNames()),
    // From a CodeLens: the file and the statement's offset. From the editor title: the file.
    vscode.commands.registerCommand('duckexplorer.runStatement', (uri?: unknown, offset?: unknown) =>
      runner.runStatement(uri instanceof vscode.Uri ? uri : undefined, typeof offset === 'number' ? offset : undefined),
    ),
    vscode.commands.registerCommand('duckexplorer.runFile', (uri?: unknown) => runner.runFile(uri instanceof vscode.Uri ? uri : undefined)),
    vscode.commands.registerCommand('duckexplorer.newNotebook', () =>
      openNotebookWith('-- Attach databases from the DuckExplorer view, then query them here.\nSELECT 42 AS answer;'),
    ),
    vscode.commands.registerCommand('duckexplorer.previewTable', (node?: TreeNode) => {
      if (node?.kind === 'relation') {
        return runInNotebook(`SELECT * FROM ${qualifiedName(node)} LIMIT 100;`);
      }
    }),
    vscode.commands.registerCommand('duckexplorer.showSummary', (node?: TreeNode) => {
      if (node?.kind === 'relation') {
        const { db, schema, relation } = node;
        return summary.show({
          database: db.name,
          schema: schema.name,
          name: relation.name,
          kind: relation.kind,
          comment: relation.comment,
          qualified: qualifiedName(node),
        });
      }
    }),
    vscode.commands.registerCommand('duckexplorer.showViewSql', (node?: TreeNode) => {
      if (node?.kind === 'relation' && node.relation.kind === 'view') {
        return viewSql.show(node);
      }
    }),
    // Tests pass the format and file instead of choosing them.
    vscode.commands.registerCommand('duckexplorer.exportTable', (node?: TreeNode, choice?: ExportChoice) => {
      if (node?.kind === 'relation') {
        const { db, schema, relation } = node;
        const source: ExportSource = {
          title: `Export ${relation.name}`,
          name: relation.name,
          method: 'exportRelation',
          params: { database: db.name, schema: schema.name, name: relation.name },
        };
        return exportRows(kernel, source, choice);
      }
    }),
    vscode.commands.registerCommand('duckexplorer.copyName', (node?: TreeNode) => {
      const name =
        node?.kind === 'relation'
          ? qualifiedName(node)
          : node?.kind === 'column'
            ? quoteIdentifier(node.column.name)
            : node?.kind === 'schema'
              ? `${quoteIdentifier(node.db.name)}.${quoteIdentifier(node.schema.name)}`
              : node?.kind === 'database'
                ? quoteIdentifier(node.db.name)
                : undefined;
      if (name) {
        return vscode.env.clipboard.writeText(name);
      }
    }),
    vscode.commands.registerCommand('duckexplorer.toggleLivePreview', () => livePreview.toggle()),
    // From a lens: the request, its document and where it ends. Tests pass the request instead of typing it.
    vscode.commands.registerCommand('duckexplorer.writeSql', (request?: unknown, uri?: unknown, offset?: unknown) => {
      const document = uri instanceof vscode.Uri ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) : undefined;
      const at = document && typeof offset === 'number' ? document.positionAt(offset) : undefined;
      const target = document && at ? { document, selection: new vscode.Selection(at, at) } : undefined;
      return sqlWriter.write(typeof request === 'string' ? request : undefined, target);
    }),
    vscode.languages.registerCodeLensProvider(sqlEditors, new WriteSqlLenses()),
    vscode.commands.registerCommand('duckexplorer.startLivePreview', () => livePreview.toggle(true)),
    vscode.commands.registerCommand('duckexplorer.stopLivePreview', () => livePreview.toggle(false)),
    vscode.commands.registerCommand('duckexplorer.restartKernel', async () => {
      try {
        await kernel.restart();
        void vscode.window.showInformationMessage('DuckExplorer: kernel restarted. Python variables and query results were cleared.');
      } catch {
        // reported by the kernel client
      }
    }),
    vscode.commands.registerCommand('duckexplorer.showLog', () => log.show()),
    vscode.commands.registerCommand('duckexplorer.showQuery', onEntry((entry) => historyView.show(entry))),
    vscode.commands.registerCommand('duckexplorer.rerunQuery', onEntry((entry) => historyView.run(entry))),
    vscode.commands.registerCommand('duckexplorer.openQuery', onEntry((entry) => historyView.openCopy(entry))),
    vscode.commands.registerCommand('duckexplorer.runQueryInNotebook', onEntry((entry) => runInNotebook(entry.sql))),
    vscode.commands.registerCommand('duckexplorer.goToQuerySource', onEntry((entry) => historyView.goToSource(entry))),
    vscode.commands.registerCommand('duckexplorer.copyQuery', onEntry((entry) => vscode.env.clipboard.writeText(entry.sql))),
    vscode.commands.registerCommand('duckexplorer.removeQuery', (node?: HistoryNode, nodes?: HistoryNode[]) =>
      historyView.remove(historyView.entriesOf(node, nodes)),
    ),
    vscode.commands.registerCommand('duckexplorer.clearHistory', () => historyView.clear()),
    vscode.commands.registerCommand('duckexplorer.searchHistory', () => historyView.search()),
  );
  return { kernel, tree, controller, summary, catalog, runner, history, historyView, treeDrop, sqlDrop, livePreview, sqlWriter };
}

export function deactivate(): void {
  // Disposables registered in activate() stop the kernel.
}

function kernelSettings(): Record<string, unknown> {
  const config = vscode.workspace.getConfiguration('duckexplorer');
  const kind = vscode.window.activeColorTheme.kind;
  return {
    pageSize: config.get<number>('pageSize', 200),
    maxPandasRows: config.get<number>('maxPandasRows', 1_000_000),
    theme: kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast ? 'dark' : 'light',
  };
}

async function addDatabase(kernel: KernelClient, attached: AttachedDatabases, refreshNames: () => void): Promise<void> {
  type Choice = vscode.QuickPickItem & { action: 'open' | 'readonly' | 'create' };
  const choice = await vscode.window.showQuickPick<Choice>(
    [
      { label: '$(folder-opened) Open database file…', action: 'open' },
      { label: '$(lock) Open database file read-only…', description: 'Safe when another process uses the file', action: 'readonly' },
      { label: '$(new-file) Create new database file…', action: 'create' },
    ],
    { title: 'Add DuckDB database' },
  );
  if (!choice) {
    return;
  }
  const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  const filters = { 'DuckDB databases': ['duckdb', 'db', 'ddb'], 'All files': ['*'] };
  let uris: readonly vscode.Uri[] | undefined;
  if (choice.action === 'create') {
    const uri = await vscode.window.showSaveDialog({ defaultUri, filters, saveLabel: 'Create database' });
    uris = uri ? [uri] : undefined;
  } else {
    uris = await vscode.window.showOpenDialog({ defaultUri, filters, canSelectMany: true, openLabel: 'Attach' });
  }
  if (uris?.length) {
    await attachFiles(uris, choice.action === 'readonly', kernel, attached, refreshNames);
  }
}

/** Attaches database files and remembers them for the next kernel start. */
async function attachFiles(
  uris: readonly vscode.Uri[],
  readOnly: boolean,
  kernel: KernelClient,
  attached: AttachedDatabases,
  refreshNames: () => void,
): Promise<void> {
  for (const uri of uris) {
    try {
      await vscode.window.withProgress(
        { location: { viewId: 'duckexplorer.schema' }, title: `Attaching ${path.basename(uri.fsPath)}` },
        () => kernel.request('attach', { path: uri.fsPath, readOnly }),
      );
      await attached.add({ path: uri.fsPath, readOnly });
    } catch (err) {
      const message = (err as Error).message;
      const hint = /lock/i.test(message) ? ' Another process (DuckDB CLI or UI?) has the file open.' : '';
      void vscode.window.showErrorMessage(`DuckExplorer: could not attach ${path.basename(uri.fsPath)}: ${message}${hint}`);
    }
  }
  refreshNames();
}

/**
 * Files dropped on the Databases view, or opened from the Explorer: database files are attached
 * (read-write), and data files become views in the `files` database, all of them again at the next
 * kernel start. The first data file's summary opens, as if it had been clicked in the tree.
 */
async function openFiles(
  uris: readonly vscode.Uri[],
  kernel: KernelClient,
  attached: AttachedDatabases,
  opened: OpenedFiles,
  summary: TableSummaryPanel,
  refreshNames: () => void,
): Promise<void> {
  const kindOf = (uri: vscode.Uri) => (uri.scheme === 'file' ? fileKind(uri.fsPath) : undefined);
  const databases = uris.filter((uri) => kindOf(uri) === 'database');
  const data = uris.filter((uri) => kindOf(uri) === 'data');
  const others = uris.filter((uri) => !kindOf(uri)).map((uri) => path.basename(uri.fsPath));
  if (others.length) {
    void vscode.window.showWarningMessage(
      `DuckExplorer can't open ${others.join(', ')}: it attaches .duckdb, .ddb and .db databases and reads ${READABLE} files.`,
    );
  }
  if (databases.length) {
    await attachFiles(databases, false, kernel, attached, refreshNames);
  }
  const views: { name: string; file: string }[] = [];
  for (const uri of data) {
    try {
      const { name } = await vscode.window.withProgress(
        { location: { viewId: 'duckexplorer.schema' }, title: `Opening ${path.basename(uri.fsPath)}` },
        () => kernel.request<{ name: string }>('openFile', { path: uri.fsPath }),
      );
      await opened.add({ path: uri.fsPath, name });
      views.push({ name, file: uri.fsPath });
    } catch (err) {
      void vscode.window.showErrorMessage(`DuckExplorer: could not open ${path.basename(uri.fsPath)}: ${(err as Error).message}`);
    }
  }
  if (!views.length) {
    return;
  }
  refreshNames();
  const [first] = views;
  await summary.show({
    database: FILES_DATABASE,
    schema: 'main',
    name: first.name,
    kind: 'view',
    comment: first.file,
    qualified: qualifiedName({ db: { name: FILES_DATABASE }, schema: { name: 'main' }, relation: first, current: false }),
  });
}
