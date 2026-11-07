import * as assert from 'assert';
import type { SchemaTree } from '../../src/kernel/protocol';
import { describeSchema, repairPrompt, sqlOfAnswer, sqlPrompt, trailingDescription } from '../../src/sql/textToSql';

const column = (name: string, type: string) => ({ name, type, nullable: true });

const SCHEMA: SchemaTree = {
  current: 'shop',
  currentSchema: 'main',
  databases: [
    { name: 'memory', path: null, readOnly: false, type: 'duckdb', schemas: [{ name: 'main', relations: [] }] },
    {
      name: 'shop',
      path: '/data/shop.duckdb',
      readOnly: true,
      type: 'duckdb',
      schemas: [
        {
          name: 'main',
          relations: [
            { name: 'orders', kind: 'table', rowEstimate: 1200, comment: 'One row per order', columns: [column('id', 'BIGINT'), column('amount', 'DOUBLE')] },
            { name: 'big orders', kind: 'view', rowEstimate: null, comment: null, columns: [column('id', 'BIGINT')] },
          ],
        },
        { name: 'staging', relations: [{ name: 'raw', kind: 'table', rowEstimate: 3, comment: null, columns: [column('Order ID', 'VARCHAR')] }] },
      ],
    },
    {
      name: 'files',
      path: null,
      readOnly: false,
      type: 'duckdb',
      schemas: [{ name: 'main', relations: [{ name: 'sales', kind: 'view', rowEstimate: null, comment: '/data/sales.csv', columns: [column('region', 'VARCHAR')] }] }],
    },
    { name: 'temp', path: null, readOnly: false, type: 'duckdb', schemas: [{ name: 'main', relations: [{ name: 'picks', kind: 'table', rowEstimate: null, comment: null, columns: [column('n', 'INTEGER')] }] }] },
  ],
};

suite('Text-to-SQL', () => {
  test('the schema as names to use: the default database first, without its name', () => {
    const text = describeSchema(SCHEMA, [{ name: 'df', columns: [{ name: 'x', type: 'BIGINT' }] }]);
    assert.deepStrictEqual(text.split('\n'), [
      'Database shop (the file /data/shop.duckdb), the default: its tables are named without the database, and in schema main without the schema:',
      '  orders (table, about 1,200 rows (One row per order)): id BIGINT, amount DOUBLE',
      '  "big orders" (view): id BIGINT',
      '  staging.raw (table, about 3 rows): "Order ID" VARCHAR',
      'Database files (data files opened in DuckExplorer, as views):',
      '  files.main.sales (view (of the file /data/sales.csv)): region VARCHAR',
      'Database temp (temporary tables and views):',
      '  picks (table): n INTEGER',
      "The notebook's Python DataFrames (and Arrow tables), which SQL reads by name:",
      '  df (DataFrame): x BIGINT',
    ]);
    assert.strictEqual(describeSchema({ current: 'memory', currentSchema: 'main', databases: [] }, []).startsWith('There are no tables'), true);
  });

  test('a large schema: fewer columns, then fewer tables, and says so', () => {
    const relations = Array.from({ length: 400 }, (_, i) => ({
      name: `t${i}`,
      kind: 'table' as const,
      rowEstimate: null,
      comment: null,
      columns: Array.from({ length: 50 }, (_, j) => column(`c${j}`, 'INTEGER')),
    }));
    const big: SchemaTree = { current: 'db', currentSchema: 'main', databases: [{ name: 'db', path: null, readOnly: false, type: 'duckdb', schemas: [{ name: 'main', relations }] }] };
    const text = describeSchema(big, [], 20_000);
    assert.ok(text.length <= 20_000, String(text.length));
    assert.match(text, /t0 \(table\): c0 INTEGER, .*c9 INTEGER, … \(40 more columns\)/);
    assert.match(text, /\(\d+ more tables and views are not listed here\.\)$/);
  });

  test('the prompt: the request, the schema and the SQL around the cursor', () => {
    const prompt = sqlPrompt({
      request: '  top 5 orders by amount ',
      schema: SCHEMA,
      frames: [],
      duckdbVersion: '1.5.5',
      before: 'SELECT 1;\n',
      after: '\nSELECT 2;',
      notebook: false,
    });
    assert.ok(prompt.startsWith('Write one DuckDB 1.5.5 SQL statement for this request:\n\ntop 5 orders by amount\n'), prompt);
    assert.ok(prompt.includes('  orders (table, about 1,200 rows (One row per order)): id BIGINT, amount DOUBLE'));
    assert.ok(prompt.endsWith('this .sql file, which may show the tables, names and style to use:\n```sql\nSELECT 1;\n<cursor>\nSELECT 2;\n```'), prompt);
    // An empty cell has no SQL around the cursor to show.
    assert.ok(!sqlPrompt({ request: 'x', schema: SCHEMA, frames: [], before: '', after: ' ', notebook: true }).includes('<cursor>'));
    assert.ok(repairPrompt('SELECT nope', 'Binder Error: no nope\n').includes('```sql\nSELECT nope\n```\nBinder Error: no nope\n\nFix it.'));
  });

  test('a request written as comments after the last statement, or alone in a cell', () => {
    // A cell of comments only, as it was saved (CRLF, blank lines after).
    const cell = '-- customers who bought books and toys\r\n\r\n\r\n';
    assert.deepStrictEqual(trailingDescription(cell), { request: 'customers who bought books and toys', start: 0, end: 38, alone: true });
    // Several lines are one request; the last block wins.
    const file = 'SELECT 1; -- not this\n-- an old note\n\n  -- revenue by month\n  --   in 2024\n';
    const found = trailingDescription(file)!;
    assert.deepStrictEqual([found.request, found.alone], ['revenue by month in 2024', false]);
    assert.strictEqual(file.slice(found.start, found.end), '-- revenue by month\n  --   in 2024');
    // A comment above a statement documents it; one on a statement's own line belongs to it.
    assert.strictEqual(trailingDescription('-- monthly revenue\nSELECT 1'), undefined);
    assert.strictEqual(trailingDescription('SELECT 1; -- done'), undefined);
    assert.strictEqual(trailingDescription('SELECT 1;\n--\n'), undefined);
    assert.strictEqual(trailingDescription(''), undefined);
  });

  test('the SQL of an answer', () => {
    assert.strictEqual(sqlOfAnswer('Here it is:\n```sql\nSELECT *\nFROM orders;\n```\nEnjoy.'), 'SELECT *\nFROM orders');
    assert.strictEqual(sqlOfAnswer('```\nSELECT 1\n```'), 'SELECT 1');
    assert.strictEqual(sqlOfAnswer('```python\nprint(1)\n```\n```sql\nSELECT 2\n```'), 'SELECT 2');
    assert.strictEqual(sqlOfAnswer('  SELECT 3;  '), 'SELECT 3');
    // An answer cut off in its code block.
    assert.strictEqual(sqlOfAnswer('```sql\nSELECT 4\nFROM t'), 'SELECT 4\nFROM t');
  });
});
