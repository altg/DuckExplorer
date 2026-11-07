import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { EXTENSION_ID } from './extensionId';

async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** What VS Code hands a drop target when files are dragged from the Explorer. */
function dropOf(...files: string[]): vscode.DataTransfer {
  const dataTransfer = new vscode.DataTransfer();
  dataTransfer.set('text/uri-list', new vscode.DataTransferItem(files.map((file) => vscode.Uri.file(file).toString()).join('\r\n')));
  return dataTransfer;
}

const token = () => new vscode.CancellationTokenSource().token;

/** The same file, as the extension compares them (src/explorer/paths.ts). */
function samePath(a: string, b: string): boolean {
  const canonical = (file: string) => {
    const resolved = fs.realpathSync.native(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return canonical(a) === canonical(b);
}

suite('DuckExplorer dropped files', () => {
  let dir: string;
  let csv: string;
  let api: any;

  suiteSetup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duckexplorer-drop-'));
    fs.mkdirSync(path.join(dir, 'data'));
    csv = path.join(dir, 'data', 'cities.csv');
    fs.writeFileSync(csv, 'id,city\n1,Oslo\n2,Lima\n3,Oslo\n4,Pune\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not data');
    // A saved notebook in the same folder, so paths written into it are relative to it.
    fs.writeFileSync(path.join(dir, 'report.duckbook'), JSON.stringify({ version: 1, cells: [{ kind: 'code', language: 'sql', source: '' }] }));
    api = await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
  });

  /** The views of opened files, as the Databases view lists them. */
  async function fileNodes(): Promise<any[]> {
    const roots: any[] = await api.tree.getChildren();
    const files = roots.find((n) => n.kind === 'database' && n.db.name === 'files' && !n.db.path);
    if (!files) return [];
    const [main] = await api.tree.getChildren(files);
    return (await api.tree.getChildren(main)).filter((n: any) => n.kind === 'relation');
  }

  async function waitForFiles(names: string[], what: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    let shown: string[] = [];
    while (Date.now() < deadline) {
      shown = (await fileNodes()).map((n) => n.relation.name).sort();
      if (JSON.stringify(shown) === JSON.stringify([...names].sort())) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for ${what}: the files database lists ${shown.join(', ') || 'nothing'}`);
  }

  test('a data file dropped on the Databases view is listed there, as a view in the files database', async () => {
    const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(path.join(dir, 'report.duckbook')));
    await vscode.window.showNotebookDocument(notebook, { viewColumn: vscode.ViewColumn.One });

    await api.treeDrop.handleDrop(undefined, dropOf(csv, path.join(dir, 'notes.txt')), token());
    const [cities] = await fileNodes();
    assert.strictEqual(cities?.relation.name, 'cities');
    const item = api.tree.getTreeItem(cities);
    assert.deepStrictEqual([item.contextValue, item.description], ['view.file', 'cities.csv']);
    assert.deepStrictEqual(cities.relation.columns.map((c: any) => [c.name, c.type]), [['id', 'BIGINT'], ['city', 'VARCHAR']]);

    // Its summary opens, as if it had been clicked.
    await waitFor(() => api.summary.current?.type === 'summary', 30_000, 'the summary');
    const { relation, table } = api.summary.current;
    assert.deepStrictEqual([relation.database, relation.name, relation.kind], ['files', 'cities', 'view']);
    assert.strictEqual(table.rowCount, 4);

    // "New cell" queries the view, like any other in the tree.
    const filter = { conditions: [{ column: 1, op: 'eq', value: 'Oslo' }] };
    await api.summary.insertFilteredCell({ type: 'insertFilteredCell', requestId: 0, resultId: table.id, filter });
    const added = () => notebook.getCells().find((cell) => cell.document.getText().includes('files.main.cities'));
    await waitFor(() => added()?.executionSummary?.success !== undefined, 30_000, 'the new cell to run');
    assert.ok(added()!.document.getText().endsWith("WHERE city = 'Oslo'"), added()!.document.getText());
    assert.strictEqual(added()!.executionSummary?.success, true);
    assert.strictEqual(JSON.parse(Buffer.from(added()!.outputs[0].items[0].data).toString('utf8')).rowCount, 2);
  });

  test('Open in DuckExplorer, from the Explorer, does the same; opened files come back after a restart until closed', async () => {
    const parquet = path.join(dir, 'data', 'squares.parquet');
    await api.kernel.request('executeSql', {
      notebook: 'drop-test',
      code: `COPY (SELECT range AS n, range * range AS square FROM range(7)) TO '${parquet.replace(/'/g, "''")}' (FORMAT parquet)`,
    });
    const uri = vscode.Uri.file(parquet);
    await vscode.commands.executeCommand('duckexplorer.openFiles', uri, [uri]);
    await waitForFiles(['cities', 'squares'], 'both files');
    await waitFor(() => api.summary.current?.type === 'summary' && api.summary.current.relation.name === 'squares', 30_000, 'the summary');
    assert.strictEqual(api.summary.current.table.rowCount, 7);

    await api.kernel.restart();
    await waitForFiles(['cities', 'squares'], 'the files to be opened again');

    const squares = (await fileNodes()).find((n) => n.relation.name === 'squares');
    await vscode.commands.executeCommand('duckexplorer.closeFile', squares);
    await waitForFiles(['cities'], 'squares to close');
    await api.kernel.restart();
    await waitForFiles(['cities'], 'cities alone to be opened again');
    await vscode.commands.executeCommand('duckexplorer.closeFile', (await fileNodes())[0]);
    await waitForFiles([], 'cities to close');
  });

  test('a database file dropped on the Databases view is attached', async () => {
    const db = path.join(dir, 'drop shop.duckdb');
    await api.kernel.request('executeSql', {
      notebook: 'drop-test',
      code: `ATTACH '${db.replace(/'/g, "''")}' AS made; CREATE TABLE made.items AS SELECT 1 AS id; DETACH made`,
    });
    await api.treeDrop.handleDrop(undefined, dropOf(db), token());
    const roots: any[] = await api.tree.getChildren();
    // DuckDB reports the file's final path: on CI's Windows runners the temp folder is C:\Users\RUNNER~1\….
    const node = roots.find((n) => n.kind === 'database' && n.db.path && samePath(n.db.path, db));
    assert.ok(node, `attached: ${roots.map((n) => n.db?.name).join(', ')}`);
    assert.strictEqual(node.db.readOnly, false);
    const [main] = await api.tree.getChildren(node);
    assert.deepStrictEqual((await api.tree.getChildren(main)).map((n: any) => n.relation.name), ['items']);
    await vscode.commands.executeCommand('duckexplorer.detachDatabase', node);
  });

  test('files dropped into SQL become queries on an empty line, else their paths', async () => {
    const sqlFile = path.join(dir, 'queries.sql');
    fs.writeFileSync(sqlFile, 'SELECT count(*) FROM \n\n');
    const document = await vscode.workspace.openTextDocument(sqlFile);
    const shop = path.join(dir, 'shop.duckdb');
    const edits = async (line: number, character: number, ...files: string[]) =>
      ((await api.sqlDrop.provideDocumentDropEdits(document, new vscode.Position(line, character), dropOf(...files), token())) ?? []).map(
        (edit: vscode.DocumentDropEdit) => [edit.kind?.value, edit.insertText],
      );

    assert.deepStrictEqual(await edits(1, 0, csv, shop), [
      ['duckexplorer.query', "SELECT * FROM 'data/cities.csv';\nATTACH 'shop.duckdb';"],
      ['duckexplorer.path', "'data/cities.csv', 'shop.duckdb'"],
    ]);
    assert.deepStrictEqual(await edits(0, 21, csv), [
      ['duckexplorer.path', "'data/cities.csv'"],
      ['duckexplorer.query', "SELECT * FROM 'data/cities.csv';"],
    ]);
    // Files DuckDB can't read are left to VS Code's own drop.
    assert.deepStrictEqual(await edits(1, 0, path.join(dir, 'notes.txt')), []);
  });

  test('a query dropped into a notebook cell reads the file from the notebook folder', async () => {
    const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(path.join(dir, 'report.duckbook')));
    const cell = notebook.cellAt(0);
    const [query] = await api.sqlDrop.provideDocumentDropEdits(cell.document, new vscode.Position(0, 0), dropOf(csv), token());
    const edit = new vscode.WorkspaceEdit();
    edit.insert(cell.document.uri, new vscode.Position(0, 0), query.insertText as string);
    await vscode.workspace.applyEdit(edit);
    assert.strictEqual(cell.document.getText(), "SELECT * FROM 'data/cities.csv';");

    await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 0, end: 1 }], document: notebook.uri });
    await waitFor(() => cell.executionSummary?.success !== undefined, 30_000, 'the cell to run');
    assert.strictEqual(cell.executionSummary?.success, true);
    assert.strictEqual(JSON.parse(Buffer.from(cell.outputs[0].items[0].data).toString('utf8')).rowCount, 4);
  });
});
