import * as path from 'path';
import * as vscode from 'vscode';
import { AttachedDatabases, qualifiedName, SchemaTreeProvider, TreeNode } from './explorer/schemaTree';
import { TableSummaryPanel } from './explorer/summaryPanel';
import { KernelClient } from './kernel/kernelProcess';
import { NOTEBOOK_TYPE } from './kernel/protocol';
import { DuckbookController } from './notebook/controller';
import { openNotebookWith, runInNotebook } from './notebook/insert';
import { DuckbookSerializer } from './notebook/serializer';
import { SqlCatalog } from './sql/catalog';
import { SqlLanguageFeatures, TRIGGER_CHARACTERS } from './sql/completion';
import { quoteIdentifier } from './sql/identifiers';

/** Returned from activate() so integration tests can reach the kernel, tree, controller, summary and catalog. */
export interface DuckExplorerApi {
  kernel: KernelClient;
  tree: SchemaTreeProvider;
  controller: DuckbookController;
  summary: TableSummaryPanel;
  catalog: SqlCatalog;
}

export function activate(context: vscode.ExtensionContext): DuckExplorerApi {
  const log = vscode.window.createOutputChannel('DuckExplorer', { log: true });
  const kernel = new KernelClient(context.extensionPath, log, kernelSettings);
  const attached = new AttachedDatabases(context.workspaceState);
  const tree = new SchemaTreeProvider(kernel, attached);
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
  const controller = new DuckbookController(kernel, () => refreshNames(true));
  const summary = new TableSummaryPanel(context.extensionUri, kernel);
  const sql = new SqlLanguageFeatures(catalog);
  const sqlCells: vscode.DocumentSelector = { notebookType: NOTEBOOK_TYPE, language: 'sql' };

  context.subscriptions.push(
    log,
    kernel,
    controller,
    summary,
    catalog,
    vscode.languages.registerCompletionItemProvider(sqlCells, sql, ...TRIGGER_CHARACTERS),
    vscode.languages.registerSignatureHelpProvider(sqlCells, sql, { triggerCharacters: ['(', ','], retriggerCharacters: [','] }),
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new DuckbookSerializer(), DuckbookSerializer.options),
    vscode.window.registerTreeDataProvider('duckexplorer.schema', tree),

    kernel.onDidStart(async () => {
      for (const db of attached.list()) {
        try {
          await kernel.request('attach', { path: db.path, readOnly: db.readOnly });
        } catch (err) {
          log.warn(`Could not re-attach ${db.path}: ${(err as Error).message}`);
          void vscode.window.showWarningMessage(`DuckExplorer: could not re-attach ${path.basename(db.path)}: ${(err as Error).message}`);
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
    vscode.commands.registerCommand('duckexplorer.refresh', () => refreshNames()),
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
    vscode.commands.registerCommand('duckexplorer.restartKernel', async () => {
      try {
        await kernel.restart();
        void vscode.window.showInformationMessage('DuckExplorer: kernel restarted. Python variables and query results were cleared.');
      } catch {
        // reported by the kernel client
      }
    }),
    vscode.commands.registerCommand('duckexplorer.showLog', () => log.show()),
  );
  return { kernel, tree, controller, summary, catalog };
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
  if (!uris?.length) {
    return;
  }
  const readOnly = choice.action === 'readonly';
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
