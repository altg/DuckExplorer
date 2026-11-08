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
    api = await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
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
    // The view's page (a module script and its chunks) runs: it says it is ready.
    await waitFor(() => (api.runner.view as any).ready === true, 30_000, 'the results page to load');
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

  test('live preview: the query at the cursor, or the CTE it is in, as it is written', async () => {
    const sql = [
      'WITH evens AS (SELECT id FROM picks WHERE id % 2 = 0), big AS (SELECT id FROM evens WHERE id > 40)',
      'SELECT count(*) AS n FROM big;',
      "INSERT INTO picks VALUES (99, 'x');",
      'SELECT * FROM range(1000);',
    ].join('\n');
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
    const editor = await vscode.window.showTextDocument(document);
    const at = (text: string, from = 0) => {
      const position = document.positionAt(document.getText().indexOf(text) + from);
      editor.selection = new vscode.Selection(position, position);
      return editor;
    };
    const preview = api.livePreview;
    await preview.toggle(true);
    try {
      const query = await preview.previewNow(at('count(*)'));
      assert.deepStrictEqual([query.source.cte, query.source.ctes, query.table.rows], [undefined, ['evens', 'big'], [['4']]]);
      assert.match(query.source.label, /^Untitled-\d+:1$/);
      const big = await preview.previewNow(at('id > 40'));
      assert.deepStrictEqual([big.source.cte, big.table.rows], ['big', [['42'], ['44'], ['46'], ['48']]]);
      assert.strictEqual(api.runner.view.current, big);
      // Only queries run.
      const insert = await preview.previewNow(at('INSERT', 3));
      assert.ok(insert.note && !insert.table, insert.note);
      // The first rows of a long result.
      const long = await preview.previewNow(at('range(1000)'));
      assert.deepStrictEqual([long.table.rowCount, long.table.truncated], [100, true]);
      // Moving the cursor previews where it goes, once it rests: the CTE evens.
      at('id % 2');
      await waitFor(() => api.runner.view.current?.source?.cte === 'evens', 10_000, 'the preview of evens');
      assert.strictEqual(api.runner.view.current.table.rowCount, 25);
      // A query being written: an error, with the last rows kept.
      await editor.edit((edit) => edit.insert(document.positionAt(document.getText().indexOf('% 2')), 'nope '));
      await waitFor(() => api.runner.view.current?.error !== undefined, 10_000, 'the preview error');
      assert.match(api.runner.view.current.error, /nope/);
      // Nothing was inserted.
      const count = await api.kernel.request('runStatements', { statements: ['SELECT count(*) FROM picks'] });
      assert.deepStrictEqual(count.table.rows, [['50']]);
    } finally {
      await preview.toggle(false);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });

  test('Write SQL from a Description: a model writes the statement below the comment, and fixes what DuckDB rejects', async () => {
    const asked: string[] = [];
    const answers = [
      'Here you go:\n```sql\nSELECT label, count(*) AS n FROM pick GROUP BY label\n```',
      '```sql\nSELECT label, count(*) AS n\nFROM picks\nGROUP BY ALL\nORDER BY label;\n```',
      'SELECT 42 AS answer',
    ];
    const model = {
      id: 'test-model',
      name: 'Test Model',
      vendor: 'tests',
      family: 'test',
      sendRequest: async (messages: vscode.LanguageModelChatMessage[]) => {
        const last = messages[messages.length - 1];
        asked.push(last.content.map((part: any) => part.value ?? '').join(''));
        const answer = answers[asked.length - 1];
        return { text: (async function* () { yield answer.slice(0, 20); yield answer.slice(20); })() };
      },
    };
    const models = api.sqlWriter.models;
    api.sqlWriter.models = async () => [model];
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT 1;\n-- how many picks per label\n' });
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(1, 5, 1, 5);
    try {
      const written = await vscode.commands.executeCommand<any>('duckexplorer.writeSql', 'how many picks per label');
      assert.ok(written, 'nothing written');
      // The prompt: the request, the schema (the temporary table, its columns), the SQL around the cursor.
      assert.match(asked[0], /how many picks per label/);
      assert.match(asked[0], /picks \(table\): id BIGINT, label VARCHAR/);
      assert.ok(asked[0].includes('SELECT 1;\n-- how many picks per label<cursor>\n'), asked[0]);
      // DuckDB rejected the first answer: asked again, with its error.
      assert.strictEqual(written.repaired, true);
      assert.match(asked[1], /FROM pick GROUP BY label\n```\nCatalog Error: .*pick/);
      assert.strictEqual(
        document.getText(),
        'SELECT 1;\n-- how many picks per label\nSELECT label, count(*) AS n\nFROM picks\nGROUP BY ALL\nORDER BY label;\n',
      );
      assert.strictEqual(document.getText(written.range), 'SELECT label, count(*) AS n\nFROM picks\nGROUP BY ALL\nORDER BY label;');
      // Its first rows, in the results view.
      assert.deepStrictEqual(written.check.table.rows.map((row: string[]) => row[1]), ['13', '13', '12', '12']);
      assert.strictEqual(api.runner.view.current, written.check);
      assert.match(written.check.source.label, /^Untitled-\d+:3$/);
      // With the cursor inside a statement, the next one goes after it, with its request as a comment.
      editor.selection = new vscode.Selection(4, 3, 4, 3);
      const answer = await vscode.commands.executeCommand<any>('duckexplorer.writeSql', 'the answer');
      assert.strictEqual(answer.repaired, false);
      assert.ok(document.getText().endsWith('ORDER BY label;\n-- the answer\nSELECT 42 AS answer;\n'), document.getText());
      assert.deepStrictEqual(answer.check.table.rows, [['42']]);
    } finally {
      api.sqlWriter.models = models;
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
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
