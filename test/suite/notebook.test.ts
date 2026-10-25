import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const SAMPLES = path.resolve(__dirname, '..', '..', 'samples');
const TABLE_MIME = 'application/vnd.duckexplorer.table+json';
const PLOTLY_MIME = 'application/vnd.duckexplorer.plotly+json';

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
      ['sql', [TABLE_MIME]],
    ]);

    const big = JSON.parse(Buffer.from(codeCells[7].outputs[0].items[0].data).toString('utf8'));
    assert.strictEqual(big.rowCount, 300_107);
    assert.strictEqual(big.rows.length, big.pageSize);

    await notebook.save();
    const saved = JSON.parse(fs.readFileSync(uri.fsPath, 'utf8'));
    const savedMimes = saved.cells
      .filter((c: any) => c.kind === 'code')
      .map((c: any) => c.outputs?.[0]?.items?.[0]?.mime);
    assert.deepStrictEqual(savedMimes, byLanguage.map(([, m]) => m[0]));
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
});
