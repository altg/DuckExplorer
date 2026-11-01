import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

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
CREATE OR REPLACE TEMP TABLE picks AS
SELECT range AS id, 'item ' || (range % 4) AS label FROM range(50);

SELECT label, count(*) AS n
FROM picks
GROUP BY label
ORDER BY label;

SELECT id,
  missing
FROM picks;
`;

suite('DuckExplorer .sql files', () => {
  let uri: vscode.Uri;
  let api: any;

  suiteSetup(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duckexplorer-sql-'));
    uri = vscode.Uri.file(path.join(dir, 'queries.sql'));
    fs.writeFileSync(uri.fsPath, QUERIES);
    api = await vscode.extensions.getExtension('duckexplorer.duckexplorer')!.activate();
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('a Run CodeLens above each statement', async () => {
    await vscode.workspace.openTextDocument(uri);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri);
    const ours = lenses.filter((lens) => lens.command?.command === 'duckexplorer.runStatement');
    assert.deepStrictEqual(
      ours.map((lens) => lens.range.start.line),
      [1, 4, 9],
    );
  });

  test('Ctrl+Enter runs the statement at the cursor, or the selection', async () => {
    const editor = await vscode.window.showTextDocument(uri);
    // The cursor on the comment above the first statement.
    editor.selection = new vscode.Selection(0, 3, 0, 3);
    const created = await vscode.commands.executeCommand<any>('duckexplorer.runStatement');
    assert.deepStrictEqual([created.completed, created.message, created.error], [1, '50 rows inserted', undefined]);
    assert.strictEqual(api.runner.view.current.type, 'result');
    assert.strictEqual(api.runner.view.current.source.label, 'queries.sql:2');

    const text = editor.document.getText();
    const start = editor.document.positionAt(text.indexOf('SELECT label'));
    const end = editor.document.positionAt(text.indexOf('ORDER BY label;'));
    editor.selection = new vscode.Selection(start, end.translate(0, 'ORDER BY label'.length));
    const grouped = await vscode.commands.executeCommand<any>('duckexplorer.runStatement');
    assert.strictEqual(grouped.table.rowCount, 4);
    assert.deepStrictEqual(grouped.table.rows[2], ['item 2', '12']);
    const { current } = api.runner.view;
    assert.strictEqual(current.type, 'result');
    assert.strictEqual(current.result.table.id, grouped.table.id);
    assert.strictEqual(current.source.label, 'queries.sql:5');
  });

  test('Export under the results view writes its rows to a file', async () => {
    const { result, source } = api.runner.view.current;
    assert.strictEqual(source.label, 'queries.sql:5');
    const csv = vscode.Uri.file(path.join(path.dirname(uri.fsPath), 'labels.csv'));
    const sort = { column: 0, descending: true };
    const request = { type: 'exportResult', requestId: 0, resultId: result.table.id, sort };
    assert.strictEqual((await api.runner.exportResult(request, { format: 'csv', uri: csv })).rowCount, 4);
    assert.deepStrictEqual(fs.readFileSync(csv.fsPath, 'utf8').trim().split(/\r?\n/), [
      'label,n',
      'item 3,12',
      'item 2,12',
      'item 1,13',
      'item 0,13',
    ]);
  });

  test('a failing statement stops the file and is marked where DuckDB says', async () => {
    const result = await vscode.commands.executeCommand<any>('duckexplorer.runFile', uri);
    assert.strictEqual(result.completed, 2);
    assert.deepStrictEqual([result.error.ename, result.error.statement], ['BinderException', 2]);
    const [diagnostic] = vscode.languages.getDiagnostics(uri);
    assert.strictEqual(diagnostic.source, 'DuckDB');
    assert.match(diagnostic.message, /^Binder Error: Referenced column "missing" not found/);
    assert.ok(!diagnostic.message.includes('LINE'), diagnostic.message);
    const document = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(document.getText(diagnostic.range), 'missing');
    assert.strictEqual(diagnostic.range.start.line, 10);

    // Editing the file clears the mark: its place may have moved.
    const editor = await vscode.window.showTextDocument(document);
    await editor.edit((edit) => edit.insert(new vscode.Position(11, 10), ' '));
    assert.deepStrictEqual(vscode.languages.getDiagnostics(uri), []);
    await vscode.commands.executeCommand('undo');
  });

  test('"Insert query" adds the filtered statement below its own and runs it', async () => {
    const document = await vscode.workspace.openTextDocument(uri);
    const offset = document.getText().indexOf('SELECT label');
    const grouped = await vscode.commands.executeCommand<any>('duckexplorer.runStatement', uri, offset + 3);
    const filter = { conditions: [{ column: 0, op: 'ne', value: 'item 0' }] };
    const sort = { column: 0, descending: true };
    await api.runner.insertQuery({ type: 'insertFilteredCell', requestId: 0, resultId: grouped.table.id, filter, sort });

    const text = document.getText();
    const added = text.indexOf('SELECT *\nFROM (\nSELECT label');
    assert.ok(added > offset && added < text.indexOf('SELECT id'), text);
    assert.ok(text.includes("WHERE label IS DISTINCT FROM 'item 0'\nORDER BY label DESC NULLS LAST;\n\nSELECT id"), text);
    await waitFor(() => api.runner.view.current?.type === 'result' && api.runner.view.current.result.table?.id !== grouped.table.id, 30_000, 'the new query to run');
    const { table } = api.runner.view.current.result;
    assert.deepStrictEqual(table.rows.map((row: string[]) => row[0]), ['item 3', 'item 2', 'item 1']);
    assert.strictEqual(api.runner.view.current.source.label, `queries.sql:${document.positionAt(added).line + 1}`);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  test('completions in a .sql file once the kernel runs', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT  FROM picks' });
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      new vscode.Position(0, 7),
    );
    const labels = list.items.map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
    for (const name of ['id', 'label', 'count']) {
      assert.ok(labels.includes(name), `${name} in ${labels.slice(0, 40)}`);
    }
    assert.ok(labels.indexOf('id') < labels.indexOf('count'));
  });
});
