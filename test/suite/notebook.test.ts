import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const SAMPLES = path.resolve(__dirname, '..', '..', 'samples');
const TABLE_MIME = 'application/vnd.duckexplorer.table+json';
const PLOTLY_MIME = 'application/vnd.duckexplorer.plotly+json';
const VEGALITE_MIME = 'application/vnd.duckexplorer.vegalite+json';

async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function mimes(cell: vscode.NotebookCell): string[] {
  return cell.outputs.flatMap((output) => output.items.map((item) => item.mime));
}

function describeFailure(cell: vscode.NotebookCell): string {
  const texts = cell.outputs.flatMap((o) => o.items.map((i) => `${i.mime}: ${Buffer.from(i.data).toString('utf8').slice(0, 500)}`));
  return `cell ${cell.index} (${cell.document.languageId}) failed:\n${texts.join('\n')}`;
}

suite('DuckExplorer notebook', () => {
  let workDir: string;

  suiteSetup(() => {
    assert.ok(fs.existsSync(path.join(SAMPLES, 'demo.duckdb')), 'Run `python samples/make_sample_db.py` first');
    // Work on a copy so saving outputs doesn't touch the checked-in demo notebook.
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duckexplorer-test-'));
    const source = fs.readFileSync(path.join(SAMPLES, 'demo.duckbook'), 'utf8');
    const dbPath = path.join(SAMPLES, 'demo.duckdb').replace(/'/g, "''");
    fs.writeFileSync(path.join(workDir, 'demo.duckbook'), source.replace("'demo.duckdb'", `'${dbPath.replace(/\\/g, '\\\\')}'`));
  });

  test('runs every cell of the demo notebook and saves the outputs', async () => {
    const uri = vscode.Uri.file(path.join(workDir, 'demo.duckbook'));
    const notebook = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(notebook);
    await vscode.commands
      .executeCommand('notebook.selectKernel', { id: 'duckexplorer-kernel', extension: 'duckexplorer.duckexplorer' })
      .then(undefined, () => undefined);

    const codeCells = notebook.getCells().filter((c) => c.kind === vscode.NotebookCellKind.Code);
    await vscode.commands.executeCommand('notebook.execute', notebook.uri);
    await waitFor(
      () => codeCells.every((c) => c.executionSummary?.success !== undefined),
      150_000,
      'all cells to finish',
    );

    for (const cell of codeCells) {
      assert.strictEqual(cell.executionSummary?.success, true, describeFailure(cell));
    }
    const byLanguage = codeCells.map((c) => [c.document.languageId, mimes(c)] as const);
    assert.deepStrictEqual(byLanguage, [
      ['sql', ['text/plain']],
      ['sql', [TABLE_MIME]],
      ['python', [PLOTLY_MIME]],
      ['sql', [TABLE_MIME]],
      ['python', ['image/png']],
      ['python', [TABLE_MIME]],
      ['sql', [TABLE_MIME]],
      ['python', [VEGALITE_MIME]],
      ['sql', [TABLE_MIME]],
    ]);

    const big = JSON.parse(Buffer.from(codeCells[8].outputs[0].items[0].data).toString('utf8'));
    assert.strictEqual(big.rowCount, 300_107);
    assert.strictEqual(big.rows.length, big.pageSize);

    await notebook.save();
    const saved = JSON.parse(fs.readFileSync(uri.fsPath, 'utf8'));
    const savedMimes = saved.cells
      .filter((c: any) => c.kind === 'code')
      .map((c: any) => c.outputs?.[0]?.items?.[0]?.mime);
    assert.deepStrictEqual(savedMimes, byLanguage.map(([, m]) => m[0]));
  });

  test('a Python cell shows its output while it runs', async () => {
    const code = "import time\nprint('first', flush=True)\ntime.sleep(4)\nprint('second')\n42";
    const notebook = await vscode.workspace.openNotebookDocument(
      'duckexplorer-notebook',
      new vscode.NotebookData([new vscode.NotebookCellData(vscode.NotebookCellKind.Code, code, 'python')]),
    );
    await vscode.window.showNotebookDocument(notebook);
    const cell = notebook.cellAt(0);
    await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 0, end: 1 }], document: notebook.uri });
    const text = () => cell.outputs.flatMap((o) => o.items.map((i) => Buffer.from(i.data).toString('utf8'))).join('');
    await waitFor(() => text().includes('first'), 60_000, 'the first line');
    assert.strictEqual(cell.executionSummary?.success, undefined, 'the first line shows before the cell is done');
    await waitFor(() => cell.executionSummary?.success !== undefined, 30_000, 'the cell to finish');
    assert.strictEqual(cell.executionSummary?.success, true, describeFailure(cell));
    // As if the outputs had come at once: one stdout item, then the value.
    assert.deepStrictEqual(
      cell.outputs.map((o) => o.items.map((i) => [i.mime, Buffer.from(i.data).toString('utf8')])),
      [[['application/vnd.code.notebook.stdout', 'first\nsecond\n']], [['text/plain', '42']]],
    );
  });

  test('a chart from the Chart view becomes a Python cell below the result', async () => {
    const api = await vscode.extensions.getExtension('duckexplorer.duckexplorer')!.activate();
    const source = "SELECT 'kind ' || (range % 4) AS kind, range AS amount FROM range(100)";
    const notebook = await vscode.workspace.openNotebookDocument(
      'duckexplorer-notebook',
      new vscode.NotebookData([new vscode.NotebookCellData(vscode.NotebookCellKind.Code, source, 'sql')]),
    );
    const editor = await vscode.window.showNotebookDocument(notebook);
    await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 0, end: 1 }], document: notebook.uri });
    await waitFor(() => notebook.cellAt(0).executionSummary?.success !== undefined, 60_000, 'the cell to finish');
    const table = JSON.parse(Buffer.from(notebook.cellAt(0).outputs[0].items[0].data).toString('utf8'));

    const filter = { conditions: [{ column: 0, op: 'ne', value: 'kind 3' }] };
    const preview = await api.kernel.request('chartSpec', { resultId: table.id, filter });
    assert.deepStrictEqual(preview.chart, { mark: 'bar', x: 0, y: 1, aggregate: 'sum', color: null, timeUnit: 'none' });
    assert.deepStrictEqual(
      preview.spec.data.values.map((v: any) => [v.kind, v.amount]),
      [['kind 2', 1250], ['kind 1', 1225], ['kind 0', 1200]],
    );

    await api.controller.insertChartCell(editor, { type: 'insertChartCell', requestId: 0, resultId: table.id, chart: preview.chart, filter });
    const added = notebook.cellAt(1);
    assert.strictEqual(added.document.languageId, 'python');
    assert.match(added.document.getText(), /^import altair as alt\n/);
    assert.match(added.document.getText(), /WHERE kind IS DISTINCT FROM 'kind 3'/);
    await waitFor(() => added.executionSummary?.success !== undefined, 60_000, 'the chart cell to run');
    assert.strictEqual(added.executionSummary?.success, true, describeFailure(added));
    assert.deepStrictEqual(mimes(added), [VEGALITE_MIME]);
    const spec = JSON.parse(Buffer.from(added.outputs[0].items[0].data).toString('utf8'));
    assert.deepStrictEqual(Object.values(spec.datasets)[0], preview.spec.data.values);
  });

  test('a SQL error is reported on the cell', async () => {
    const notebook = await vscode.workspace.openNotebookDocument(
      'duckexplorer-notebook',
      new vscode.NotebookData([
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'SELECT * FROM table_that_does_not_exist', 'sql'),
      ]),
    );
    await vscode.window.showNotebookDocument(notebook);
    const cell = notebook.cellAt(0);
    await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 0, end: 1 }], document: notebook.uri });
    await waitFor(() => cell.executionSummary?.success !== undefined, 60_000, 'the cell to finish');
    assert.strictEqual(cell.executionSummary?.success, false);
    const error = JSON.parse(Buffer.from(cell.outputs[0].items[0].data).toString('utf8'));
    assert.strictEqual(error.name, 'CatalogException');
    assert.match(error.message, /table_that_does_not_exist/);
  });

  test('the kernel serves sorted and filtered pages and column statistics for a result', async () => {
    const api = await vscode.extensions.getExtension('duckexplorer.duckexplorer')!.activate();
    const notebook = await vscode.workspace.openNotebookDocument(
      'duckexplorer-notebook',
      new vscode.NotebookData([
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'SELECT range AS n, range % 3 AS k FROM range(1000)', 'sql'),
      ]),
    );
    await vscode.window.showNotebookDocument(notebook);
    const cell = notebook.cellAt(0);
    await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 0, end: 1 }], document: notebook.uri });
    await waitFor(() => cell.executionSummary?.success !== undefined, 60_000, 'the cell to finish');
    const table = JSON.parse(Buffer.from(cell.outputs[0].items[0].data).toString('utf8'));

    const { rows } = await api.kernel.request('fetchPage', {
      resultId: table.id,
      offset: 0,
      limit: 3,
      sort: { column: 0, descending: true },
    });
    assert.deepStrictEqual(rows, [['999', '0'], ['998', '2'], ['997', '1']]);

    const filter = { conditions: [{ column: 1, op: 'eq', value: '2' }], where: 'n < 100' };
    const filtered = await api.kernel.request('fetchPage', { resultId: table.id, offset: 0, limit: 3, filter });
    assert.deepStrictEqual(filtered, { rows: [['2', '2'], ['5', '2'], ['8', '2']], rowCount: 33 });
    const filteredProfile = await api.kernel.request('profileResult', { resultId: table.id, filter });
    assert.strictEqual(filteredProfile.rowCount, 33);
    await assert.rejects(
      api.kernel.request('fetchPage', { resultId: table.id, offset: 0, limit: 3, filter: { conditions: [], where: 'm < 1' } }),
      (err: any) => err.code === 'invalid' && /Binder Error/.test(err.message),
    );

    const profile = await api.kernel.request('profileResult', { resultId: table.id });
    assert.strictEqual(profile.rowCount, 1000);
    assert.deepStrictEqual(
      profile.columns[1].histogram.map((bar: any) => [bar.start, bar.count]),
      [['0', 334], ['1', 333], ['2', 333]],
    );
  });

  test('a filtered result becomes a new SQL cell below its own', async () => {
    const api = await vscode.extensions.getExtension('duckexplorer.duckexplorer')!.activate();
    const source = '-- name: numbers\nSELECT range AS n, range % 3 AS k FROM range(1000);';
    const notebook = await vscode.workspace.openNotebookDocument(
      'duckexplorer-notebook',
      new vscode.NotebookData([
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, source, 'sql'),
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'SELECT 1 AS later', 'sql'),
      ]),
    );
    const editor = await vscode.window.showNotebookDocument(notebook);
    await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 0, end: 1 }], document: notebook.uri });
    await waitFor(() => notebook.cellAt(0).executionSummary?.success !== undefined, 60_000, 'the cell to finish');
    const table = JSON.parse(Buffer.from(notebook.cellAt(0).outputs[0].items[0].data).toString('utf8'));

    const filter = { conditions: [{ column: 1, op: 'eq', value: '2' }], where: 'n < 100' };
    const sort = { column: 0, descending: true };
    const { where } = await api.kernel.request('filterSql', { resultId: table.id, filter });
    assert.strictEqual(where, 'k = 2 AND (n < 100)');

    await api.controller.insertFilteredCell(editor, { type: 'insertFilteredCell', requestId: 0, resultId: table.id, filter, sort });
    assert.strictEqual(notebook.cellCount, 3);
    const added = notebook.cellAt(1);
    assert.strictEqual(added.document.languageId, 'sql');
    assert.strictEqual(
      added.document.getText(),
      'SELECT *\nFROM (\nSELECT range AS n, range % 3 AS k FROM range(1000)\n)\nWHERE k = 2 AND (n < 100)\nORDER BY n DESC NULLS LAST',
    );
    await waitFor(() => added.executionSummary?.success !== undefined, 60_000, 'the new cell to run');
    assert.strictEqual(added.executionSummary?.success, true);
    const rerun = JSON.parse(Buffer.from(added.outputs[0].items[0].data).toString('utf8'));
    assert.strictEqual(rerun.rowCount, 33);
    assert.deepStrictEqual(rerun.rows.slice(0, 2), [['98', '2'], ['95', '2']]);
  });

  test('Export writes a result to a file, filtered and sorted like the grid', async () => {
    const api = await vscode.extensions.getExtension('duckexplorer.duckexplorer')!.activate();
    const notebook = await vscode.workspace.openNotebookDocument(
      'duckexplorer-notebook',
      new vscode.NotebookData([
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "SELECT range AS n, range % 3 AS k, 'n=' || range AS label FROM range(1000)", 'sql'),
      ]),
    );
    const editor = await vscode.window.showNotebookDocument(notebook);
    await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 0, end: 1 }], document: notebook.uri });
    await waitFor(() => notebook.cellAt(0).executionSummary?.success !== undefined, 60_000, 'the cell to finish');
    const table = JSON.parse(Buffer.from(notebook.cellAt(0).outputs[0].items[0].data).toString('utf8'));
    const request = {
      type: 'exportResult',
      requestId: 0,
      resultId: table.id,
      filter: { conditions: [{ column: 1, op: 'eq', value: '2' }], where: 'n < 100' },
      sort: { column: 0, descending: true },
    };

    const csv = vscode.Uri.file(path.join(workDir, 'filtered numbers.csv'));
    const exported = await api.controller.exportResult(editor, request, { format: 'csv', uri: csv });
    assert.deepStrictEqual([exported.uri.fsPath, exported.rowCount], [csv.fsPath, 33]);
    const lines = fs.readFileSync(csv.fsPath, 'utf8').trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 34);
    assert.deepStrictEqual(lines.slice(0, 3), ['n,k,label', '98,2,n=98', '95,2,n=95']);
    assert.strictEqual(lines[33], '2,2,n=2');

    const parquet = vscode.Uri.file(path.join(workDir, "it's numbers.parquet"));
    assert.strictEqual((await api.controller.exportResult(editor, request, { format: 'parquet', uri: parquet })).rowCount, 33);
    const back = await api.kernel.request('executeSql', {
      notebook: 'export-test',
      code: `SELECT count(*) AS rows, max(n) AS top, typeof(any_value(k)) AS type FROM '${parquet.fsPath.replace(/'/g, "''")}'`,
    });
    assert.deepStrictEqual(back.outputs[0].table.rows, [['33', '98', 'BIGINT']]);

    // A result the kernel no longer holds: the grid is told so (and the user is asked to run the cell again).
    await assert.rejects(
      api.controller.exportResult(editor, { ...request, resultId: 'gone-1' }, { format: 'csv', uri: csv }),
      (err: any) => err.code === 'expired',
    );
  });

  test('the schema tree lists attached databases down to columns', async () => {
    const api = await vscode.extensions.getExtension('duckexplorer.duckexplorer')!.activate();
    const { alias } = await api.kernel.request('attach', { path: path.join(SAMPLES, 'demo.duckdb'), readOnly: true });
    const roots: any[] = await api.tree.getChildren();
    const demo = roots.find((n) => n.kind === 'database' && n.db.name === alias);
    assert.ok(demo, `database ${alias} in ${roots.map((n) => n.db?.name)}`);
    assert.match(String(api.tree.getTreeItem(demo).description), /demo\.duckdb · read-only/);

    const [main] = await api.tree.getChildren(demo);
    const relations: any[] = await api.tree.getChildren(main);
    assert.deepStrictEqual(
      relations.map((n) => n.relation.name),
      ['customers', 'order_items', 'order_totals', 'orders', 'products'],
    );
    const orders = relations.find((n) => n.relation.name === 'orders');
    assert.strictEqual(api.tree.getTreeItem(orders).description, '120,000 rows');
    const columns: any[] = await api.tree.getChildren(orders);
    assert.deepStrictEqual(
      columns.map((n) => `${n.column.name} ${n.column.type}`),
      ['order_id BIGINT', 'customer_id BIGINT', 'order_date DATE', 'status VARCHAR', 'channel VARCHAR'],
    );
  });

  test('SQL cells complete tables, columns, DataFrames and functions, and show parameter hints', async () => {
    const api = await vscode.extensions.getExtension('duckexplorer.duckexplorer')!.activate();
    const { alias } = await api.kernel.request('attach', { path: path.join(SAMPLES, 'demo.duckdb'), readOnly: true });
    await api.kernel.request('executeSql', { notebook: 'completion-test', code: `USE ${alias}` });
    api.catalog.invalidate();

    // `|` marks where completions are asked for.
    const probes = [
      'SELECT * FROM |',
      'SELECT o.| FROM orders o JOIN customers c USING (customer_id)',
      'SELECT | FROM orders o JOIN customers c USING (customer_id)',
      'SELECT t.| FROM targets t',
      'WITH m AS (SELECT order_id, status AS state FROM orders) SELECT m.| FROM m',
      "SELECT date_diff('day', order_date, |) FROM orders",
    ];
    const notebook = await vscode.workspace.openNotebookDocument(
      'duckexplorer-notebook',
      new vscode.NotebookData([
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "import pandas as pd\ntargets = pd.DataFrame({'category': ['x'], 'goal': [1]})", 'python'),
        ...probes.map((probe) => new vscode.NotebookCellData(vscode.NotebookCellKind.Code, probe.replace('|', ''), 'sql')),
      ]),
    );
    await vscode.window.showNotebookDocument(notebook);
    await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 0, end: 1 }], document: notebook.uri });
    await waitFor(() => notebook.cellAt(0).executionSummary?.success !== undefined, 60_000, 'the Python cell to finish');

    const where = (i: number) => notebook.cellAt(i + 1).document.positionAt(probes[i].indexOf('|'));
    const labels = async (i: number) => {
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        notebook.cellAt(i + 1).document.uri,
        where(i),
      );
      return list.items.map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
    };

    const tables = await labels(0);
    for (const name of ['orders', 'customers', 'order_totals', 'targets', 'read_csv']) {
      assert.ok(tables.includes(name), `${name} in ${tables.slice(0, 40)}`);
    }
    assert.deepStrictEqual(await labels(1), ['order_id', 'customer_id', 'order_date', 'status', 'channel']);
    const columns = await labels(2);
    for (const name of ['status', 'country', 'segment', 'o', 'c', 'date_trunc', 'WHERE']) {
      assert.ok(columns.includes(name), `${name} in ${columns.slice(0, 40)}`);
    }
    assert.ok(!columns.includes('goal'));
    assert.deepStrictEqual(await labels(3), ['category', 'goal']);
    assert.deepStrictEqual(await labels(4), ['order_id', 'state']);

    const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
      'vscode.executeSignatureHelpProvider',
      notebook.cellAt(6).document.uri,
      where(5),
    );
    const active = help.signatures[help.activeSignature];
    assert.match(active.label, /^date_diff\(part VARCHAR, startdate \w+, enddate \w+\) → BIGINT$/);
    assert.strictEqual(help.activeParameter, 2);
  });

  test('clicking a table in the tree opens its summary', async () => {
    const api = await vscode.extensions.getExtension('duckexplorer.duckexplorer')!.activate();
    const { alias } = await api.kernel.request('attach', { path: path.join(workDir, 'summary.duckdb') });
    try {
      await api.kernel.request('executeSql', {
        notebook: 'summary-test',
        code: `CREATE TABLE ${alias}.main.items AS SELECT range AS id, 'item ' || (range % 4) AS label FROM range(50)`,
      });
      const roots: any[] = await api.tree.getChildren();
      const [main] = await api.tree.getChildren(roots.find((n) => n.kind === 'database' && n.db.name === alias));
      const [items] = await api.tree.getChildren(main);
      const { command } = api.tree.getTreeItem(items);
      assert.strictEqual(command?.command, 'duckexplorer.showSummary');

      await vscode.commands.executeCommand(command!.command, ...(command!.arguments ?? []));
      await waitFor(() => api.summary.current?.type === 'summary', 30_000, 'the summary');
      // The panel's page (a module script and its chunks) runs: it says it is ready.
      await waitFor(() => (api.summary as any).ready === true, 30_000, 'the summary page to load');
      const { relation, table } = api.summary.current;
      assert.deepStrictEqual([relation.database, relation.name, relation.kind], [alias, 'items', 'table']);
      assert.strictEqual(table.rowCount, 50);
      const profile = await api.kernel.request('profileResult', { resultId: table.id });
      assert.deepStrictEqual(
        profile.columns[1].top.map((t: any) => [t.value, t.count]),
        [['item 0', 13], ['item 1', 13], ['item 2', 12], ['item 3', 12]],
      );
      // The tab model is updated asynchronously.
      const summaryTab = () =>
        vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .some((tab) => tab.input instanceof vscode.TabInputWebview && tab.label === 'Summary: items');
      await waitFor(summaryTab, 10_000, 'the summary tab');

      // "New cell" in the panel's filter bar: the whole table, filtered, in a visible notebook.
      const filter = { conditions: [{ column: 1, op: 'eq', value: 'item 2' }] };
      await (api.summary as any).insertFilteredCell({ type: 'insertFilteredCell', requestId: 0, resultId: table.id, filter });
      const added = () =>
        vscode.workspace.notebookDocuments
          .flatMap((doc) => doc.getCells())
          .find((cell) => cell.document.getText().endsWith("WHERE label = 'item 2'"));
      await waitFor(() => added()?.executionSummary?.success !== undefined, 30_000, 'the new cell to run');
      assert.strictEqual(added()!.executionSummary?.success, true);
      assert.strictEqual(JSON.parse(Buffer.from(added()!.outputs[0].items[0].data).toString('utf8')).rowCount, 12);

      // Export under the panel's grid, and on the table in the tree.
      const csv = vscode.Uri.file(path.join(workDir, 'items.csv'));
      const sort = { column: 0, descending: true };
      const request = { type: 'exportResult', requestId: 0, resultId: table.id, filter, sort };
      assert.strictEqual((await (api.summary as any).exportResult(request, { format: 'csv', uri: csv })).rowCount, 12);
      assert.deepStrictEqual(fs.readFileSync(csv.fsPath, 'utf8').split(/\r?\n/).slice(0, 3), ['id,label', '46,item 2', '42,item 2']);
      const parquet = vscode.Uri.file(path.join(workDir, 'items.parquet'));
      const whole = await vscode.commands.executeCommand<any>('duckexplorer.exportTable', items, { format: 'parquet', uri: parquet });
      assert.strictEqual(whole.rowCount, 50);
      assert.ok(fs.statSync(parquet.fsPath).size > 0);
    } finally {
      await api.kernel.request('detach', { alias });
    }
  });
});
