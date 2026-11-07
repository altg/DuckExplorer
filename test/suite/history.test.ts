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

const QUERIES = `-- Scratch data
CREATE OR REPLACE TEMP TABLE hist AS SELECT range AS id FROM range(10);

SELECT count(*) AS n FROM hist;

SELECT * FROM read_csv('picks.csv') ORDER BY id;

SELECT nope FROM hist;
`;

suite('DuckExplorer query history', () => {
  let dir: string;
  let uri: vscode.Uri;
  let api: any;

  /** The offset of `text` in the .sql file, as it is on disk. */
  const offsetOf = (text: string) => QUERIES.indexOf(text) + 2;

  suiteSetup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duckexplorer-history-'));
    uri = vscode.Uri.file(path.join(dir, 'queries.sql'));
    fs.writeFileSync(uri.fsPath, QUERIES);
    fs.writeFileSync(path.join(dir, 'picks.csv'), 'id,label\n1,one\n2,two\n3,three\n');
    api = await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
    // The test instance keeps workspace state between runs.
    await api.history.clear();
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('runs of a .sql file are recorded, newest first, by day', async () => {
    const failed = await vscode.commands.executeCommand<any>('duckexplorer.runFile', uri);
    assert.strictEqual(failed.completed, 3);
    await vscode.commands.executeCommand('duckexplorer.runStatement', uri, offsetOf('SELECT count'));

    const [count, file] = api.history.all;
    assert.strictEqual(count.sql, 'SELECT count(*) AS n FROM hist;');
    assert.deepStrictEqual(count.outcome, { kind: 'rows', rows: 1 });
    // VS Code's file paths (fsPath) have a lowercase drive letter.
    assert.deepStrictEqual([count.source.kind, count.source.label, count.cwd], ['file', 'queries.sql:4', path.dirname(uri.fsPath)]);

    const last = 'SELECT nope FROM hist;';
    assert.strictEqual(file.sql, QUERIES.slice(QUERIES.indexOf('CREATE'), QUERIES.indexOf(last) + last.length));
    assert.strictEqual(file.statements, 4);
    assert.strictEqual(file.outcome.kind, 'error');
    assert.strictEqual(file.outcome.statement, 3);
    assert.match(file.outcome.message, /^Binder Error: Referenced column "nope" not found/);
    assert.ok(!file.outcome.message.includes('LINE'), file.outcome.message);

    const view = api.historyView;
    const [today, ...others] = view.getChildren();
    assert.deepStrictEqual(others, []);
    assert.strictEqual(view.getTreeItem(today).label, 'Today');
    const items = view.getChildren(today).map((node: any) => view.getTreeItem(node));
    assert.strictEqual(items[0].label, 'SELECT count(*) AS n FROM hist');
    assert.match(items[0].description, /^\d\d:\d\d · 1 row · /);
    assert.match(items[1].label, /^CREATE OR REPLACE TEMP TABLE hist AS .* SELECT nope FROM hist$/);
    assert.match(items[1].description, /^\d\d:\d\d · Binder Error$/);
    assert.strictEqual(items[1].iconPath.id, 'error');
  });

  test('SQL cells of notebooks are recorded, Python cells are not', async () => {
    const before = api.history.all.length;
    const notebook = await vscode.workspace.openNotebookDocument(
      'duckexplorer-notebook',
      new vscode.NotebookData([
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'SELECT 42 AS answer', 'sql'),
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'x = 1', 'python'),
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'SELECT * FROM nowhere', 'sql'),
      ]),
    );
    await vscode.window.showNotebookDocument(notebook);
    await vscode.commands
      .executeCommand('notebook.selectKernel', { id: 'duckexplorer-kernel', extension: EXTENSION_ID })
      .then(undefined, () => undefined);
    await vscode.commands.executeCommand('notebook.execute', notebook.uri);
    await waitFor(() => notebook.getCells().every((c) => c.executionSummary?.success !== undefined), 60_000, 'the cells to run');

    assert.strictEqual(api.history.all.length, before + 2);
    const [failed, answer] = api.history.all;
    assert.deepStrictEqual([answer.sql, answer.outcome, answer.source.kind], ['SELECT 42 AS answer', { kind: 'rows', rows: 1 }, 'notebook']);
    assert.match(answer.source.label, /, cell 1$/);
    assert.strictEqual(failed.outcome.kind, 'error');
    assert.match(failed.outcome.message, /^Catalog Error: Table with name nowhere does not exist/);
    assert.ok(!failed.outcome.message.includes('LINE'), failed.outcome.message);

    // Go to Source selects the cell (an untitled notebook while it is open).
    await vscode.window.showTextDocument(uri);
    assert.ok(await api.historyView.goToSource(failed));
    assert.strictEqual(vscode.window.activeNotebookEditor?.notebook, notebook);
    assert.strictEqual(vscode.window.activeNotebookEditor?.selection.start, 2);
  });

  test('queries with credentials are not recorded', async () => {
    const before = api.history.all.length;
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: "SELECT 'host=db password=hunter2' AS dsn;" });
    const result = await vscode.commands.executeCommand<any>('duckexplorer.runFile', document.uri);
    assert.strictEqual(result.table.rowCount, 1);
    assert.strictEqual(api.history.all.length, before);
  });

  test('an entry opens read-only, and runs again in the folder it first ran in', async () => {
    await vscode.commands.executeCommand('duckexplorer.runStatement', uri, offsetOf('SELECT * FROM read_csv'));
    const [csv] = api.history.all;
    assert.deepStrictEqual(csv.outcome, { kind: 'rows', rows: 3 });

    const editor = await api.historyView.show(csv);
    assert.strictEqual(editor.document.uri.scheme, 'duckexplorer-history');
    assert.strictEqual(editor.document.languageId, 'sql');
    assert.strictEqual(editor.document.getText(), csv.sql);
    assert.match(path.basename(editor.document.uri.path), /^History \d\d:\d\d:\d\d\.sql$/);

    // The workspace folder (samples) has no picks.csv: the query runs in the .sql file's folder.
    const again = await api.historyView.run(csv);
    assert.strictEqual(again.table.rowCount, 3);
    const [rerun] = api.history.all;
    assert.notStrictEqual(rerun.id, csv.id);
    assert.deepStrictEqual([rerun.sql, rerun.source, rerun.cwd], [csv.sql, csv.source, path.dirname(uri.fsPath)]);

    // "Insert query" can't change the history's document: the query goes to a new editor, and runs.
    const filter = { conditions: [{ column: 1, op: 'ne', value: 'two' }] };
    await api.runner.insertQuery({ type: 'insertFilteredCell', requestId: 0, resultId: again.table.id, filter });
    await waitFor(() => api.runner.view.current?.result?.table?.id !== again.table.id && api.runner.view.current?.type === 'result', 30_000, 'the new query to run');
    assert.strictEqual(api.runner.view.current.result.table.rowCount, 2);
    const copy = vscode.window.activeTextEditor!.document;
    assert.strictEqual(copy.uri.scheme, 'untitled');
    assert.match(copy.getText(), /^SELECT \*\nFROM \(\nSELECT \* FROM read_csv\('picks.csv'\) ORDER BY id\n\)\nWHERE label IS DISTINCT FROM 'two';\n$/);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  test("a copy's folder goes when it closes, so the next editor with its name runs in the workspace folder", async () => {
    const csv = api.history.all.find((entry: any) => entry.sql.startsWith('SELECT * FROM read_csv'));
    const copy = await api.historyView.openCopy(csv);
    const name = copy.document.uri.toString();
    const ran = await vscode.commands.executeCommand<any>('duckexplorer.runFile', copy.document.uri);
    assert.strictEqual(ran.table.rowCount, 3);

    const closed = new Promise<void>((resolve) => {
      const listener = vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.toString() === name) {
          listener.dispose();
          resolve();
        }
      });
    });
    await vscode.window.showTextDocument(copy.document);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await closed;
    // VS Code names a new untitled document with the lowest free number: the copy's.
    const next = await vscode.workspace.openTextDocument({ language: 'sql', content: csv.sql });
    assert.strictEqual(next.uri.toString(), name);
    const result = await vscode.commands.executeCommand<any>('duckexplorer.runFile', next.uri);
    assert.match(result.error?.message ?? '', /picks\.csv/);
  });

  test('Go to Source finds the statements in the file, where they are now', async () => {
    const count = api.history.all.find((entry: any) => entry.sql.startsWith('SELECT count'));
    assert.ok(await api.historyView.goToSource(count));
    let editor = vscode.window.activeTextEditor!;
    assert.strictEqual(editor.document.uri.fsPath, uri.fsPath);
    assert.strictEqual(editor.document.getText(editor.selection), count.sql);
    assert.strictEqual(editor.selection.start.line, 3);

    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), '-- moved\n\n'));
    assert.ok(await api.historyView.goToSource(count));
    editor = vscode.window.activeTextEditor!;
    assert.strictEqual(editor.document.getText(editor.selection), count.sql);
    assert.strictEqual(editor.selection.start.line, 5);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  test('entries are removed one by one, or all at once', async () => {
    const [first, second] = api.history.all;
    const before = api.history.all.length;
    await vscode.commands.executeCommand('duckexplorer.removeQuery', { kind: 'entry', entry: first });
    assert.strictEqual(api.history.all.length, before - 1);
    assert.strictEqual(api.history.all[0].id, second.id);
    assert.strictEqual(api.history.get(first.id), undefined);
    // Its document says so.
    const gone = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: 'duckexplorer-history', path: `/${first.id}/x.sql` }));
    assert.match(gone.getText(), /no longer in the query history/);

    const config = vscode.workspace.getConfiguration('duckexplorer');
    await config.update('historySize', 2, vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand('duckexplorer.runStatement', uri, offsetOf('SELECT count'));
      assert.strictEqual(api.history.all.length, 2);
    } finally {
      await config.update('historySize', undefined, vscode.ConfigurationTarget.Global);
    }

    await api.history.clear();
    assert.deepStrictEqual(api.historyView.getChildren(), []);
  });
});
