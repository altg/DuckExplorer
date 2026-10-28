import * as assert from 'assert';
import { analyze, RelationRef, SqlContext } from '../../src/sql/context';
import { tokenize } from '../../src/sql/tokens';

/** The context at the `|` in `sql`. */
function at(sql: string): SqlContext & { offset: number } {
  const offset = sql.indexOf('|');
  return { ...analyze(sql.slice(0, offset) + sql.slice(offset + 1), offset), offset };
}

function describe(ref: RelationRef): string {
  const name = ref.file !== undefined ? `'${ref.file}'` : ref.query ? '(query)' : ref.parts.join('.') + (ref.call ? '()' : '');
  return [name, ref.alias, ref.outer ? '(outer)' : ''].filter(Boolean).join(' ');
}

const scope = (sql: string) => at(sql).scope.map(describe);
const kind = (sql: string) => at(sql).position.kind;

suite('SQL tokens', () => {
  test('strings, quoted names, comments and operators', () => {
    const tokens = tokenize(`SELECT 'it''s', "a""b", E'x\\'y', $$q$$, 1.5e3, x::int, $1 -- c\n/* d */ "open`);
    assert.deepStrictEqual(
      tokens.map((t) => `${t.kind}:${t.text}${t.open ? '…' : ''}`),
      [
        'word:SELECT', "string:'it''s'", 'punct:,', 'quoted:"a""b"', 'punct:,', "string:E'x\\'y'", 'punct:,',
        'string:$$q$$', 'punct:,', 'number:1.5e3', 'punct:,', 'word:x', 'punct:::', 'word:int', 'punct:,',
        'number:$1', 'comment:-- c', 'comment:/* d */', 'quoted:"open…',
      ],
    );
  });
});

suite('SQL context', () => {
  test('statement starts', () => {
    for (const sql of ['|', 'sel|', 'SELECT 1; |', '-- note\n|', 'SELECT * FROM (|)', 'CREATE TABLE t AS |']) {
      assert.strictEqual(kind(sql), 'statement', sql);
    }
    assert.strictEqual(at('sel|').prefix, 'sel');
  });

  test('table names after FROM, JOIN and the like', () => {
    for (const sql of [
      'SELECT * FROM |',
      'SELECT * FROM ord|',
      'FROM |',
      'SELECT * FROM a JOIN |',
      'SELECT * FROM a, |',
      'SELECT * FROM a LEFT JOIN b ON a.x = b.x JOIN |',
      'INSERT INTO |',
      'UPDATE |',
      'DESCRIBE |',
      'SUMMARIZE |',
      'DROP TABLE |',
      'DELETE FROM |',
      'PIVOT |',
      'SELECT * FROM demo.ma|',
    ]) {
      assert.strictEqual(kind(sql), 'relation', sql);
    }
    assert.strictEqual(kind('CREATE TABLE |'), 'none');
    assert.strictEqual(kind('CREATE VIEW v|'), 'none');
    const qualified = at('SELECT * FROM demo.main.|');
    assert.deepStrictEqual([qualified.qualifier, qualified.prefix, qualified.position.kind], [['demo', 'main'], '', 'relation']);
  });

  test('after a table name: an alias or the next clause', () => {
    for (const sql of ['SELECT * FROM orders |', 'SELECT * FROM orders o |', "FROM read_csv('x.csv') |", "FROM 'x.csv' w|", 'UPDATE t |']) {
      assert.strictEqual(kind(sql), 'afterRelation', sql);
    }
    assert.strictEqual(kind('SELECT * FROM orders AS |'), 'none');
    assert.strictEqual(kind('SELECT a AS |'), 'none');
  });

  test('expressions, and whether an operand was just completed', () => {
    const cases: [string, boolean][] = [
      ['SELECT |', false],
      ['SELECT a, |', false],
      ['SELECT a |', true],
      ['SELECT * |', true],
      ['SELECT * FROM t WHERE |', false],
      ['SELECT * FROM t WHERE x = 1 AND |', false],
      ['SELECT * FROM t WHERE x = 1 |', true],
      ['SELECT * FROM t ORDER BY |', false],
      ['SELECT * FROM a JOIN b ON |', false],
      ['SELECT sum(|)', false],
      ['UPDATE t SET |', false],
    ];
    for (const [sql, afterValue] of cases) {
      assert.deepStrictEqual(at(sql).position, { kind: 'expression', afterValue }, sql);
    }
  });

  test('FROM items with aliases, joins, table functions and files', () => {
    const ctx = at(
      "SELECT | FROM demo.main.orders o JOIN customers AS c USING (customer_id), read_csv('x.csv') r, 'y.parquet' LEFT JOIN \"My Table\" WHERE 1",
    );
    assert.deepStrictEqual(ctx.scope.map(describe), ['demo.main.orders o', 'customers c', 'read_csv() r', "'y.parquet'", 'My Table']);
    assert.deepStrictEqual(scope('SELECT * FROM t1 x(a, b) WHERE |'), ['t1 x']);
    assert.deepStrictEqual(at('SELECT * FROM t1 x(a, b) WHERE |').scope[0].columnAliases, ['a', 'b']);
  });

  test('qualified and quoted names', () => {
    const dotted = at('SELECT o.| FROM orders o');
    assert.deepStrictEqual([dotted.qualifier, dotted.prefix, dotted.position.kind], [['o'], '', 'expression']);
    const partial = at('SELECT o.st| FROM orders o');
    assert.deepStrictEqual([partial.qualifier, partial.prefix, partial.start, partial.end], [['o'], 'st', 9, 11]);
    const middle = at('SELECT o.st|atus FROM orders o');
    assert.deepStrictEqual([middle.prefix, middle.start, middle.end], ['st', 9, 15]);
    const open = at('SELECT "ord|');
    assert.deepStrictEqual([open.quoted, open.prefix, open.start, open.end], [true, 'ord', 7, 11]);
    const closed = at('SELECT * FROM "My Ta|"');
    assert.deepStrictEqual([closed.quoted, closed.prefix, closed.start, closed.end, closed.position.kind], [true, 'My Ta', 14, 21, 'relation']);
  });

  test('subqueries see the tables around them, but not their siblings', () => {
    assert.deepStrictEqual(scope('SELECT * FROM orders o WHERE o.id IN (SELECT | FROM items i)'), ['items i', 'orders o (outer)']);
    assert.deepStrictEqual(scope('SELECT * FROM (SELECT | FROM items) t'), ['items']);
    const derived = at('SELECT t.| FROM (SELECT a, b AS bee, count(*) n, x.* EXCLUDE (z), total: a + 1, a + 2 FROM x) t');
    assert.deepStrictEqual(derived.scope.map(describe), ['(query) t']);
    assert.deepStrictEqual(derived.scope[0].query!.items, [
      { name: 'a', ref: ['a'] },
      { name: 'bee' },
      { name: 'n' },
      { star: 'x', exclude: ['z'] },
      { name: 'total' },
    ]);
    assert.deepStrictEqual(at('SELECT * FROM (VALUES (1, 2)) v(a, b) WHERE |').scope[0].query!.items, [{ name: 'col0' }, { name: 'col1' }]);
    assert.deepStrictEqual(at('SELECT * FROM (FROM t) s WHERE |').scope[0].query!.items, [{ star: undefined, exclude: [] }]);
  });

  test('WITH queries', () => {
    const ctx = at('WITH m AS (SELECT a FROM t), n(x, y) AS (SELECT 1, 2) SELECT | FROM m JOIN n ON true');
    assert.deepStrictEqual(ctx.ctes.map((cte) => [cte.name, cte.columns]), [['m', undefined], ['n', ['x', 'y']]]);
    assert.deepStrictEqual(ctx.ctes[0].query.items, [{ name: 'a', ref: ['a'] }]);
    assert.deepStrictEqual(ctx.ctes[0].query.from.map(describe), ['t']);
    assert.deepStrictEqual(ctx.scope.map(describe), ['m', 'n']);
    assert.deepStrictEqual(scope('WITH m AS (SELECT | FROM t) SELECT * FROM m'), ['t']);
    assert.deepStrictEqual(at('WITH m AS (SELECT | FROM t) SELECT * FROM m').ctes.map((c) => c.name), ['m']);
    assert.strictEqual(kind('WITH m AS (SELECT 1) SELECT * FROM |'), 'relation');
    assert.strictEqual(kind('WITH |'), 'none');
  });

  test('set operations and statements with their own table', () => {
    assert.deepStrictEqual(scope('SELECT a FROM t1 UNION ALL SELECT | FROM t2'), ['t2']);
    assert.deepStrictEqual(scope('SELECT | FROM t1 UNION ALL SELECT b FROM t2'), ['t1']);
    assert.deepStrictEqual(scope('UPDATE orders SET |'), ['orders']);
    assert.deepStrictEqual(scope('UPDATE orders o SET x = 1 FROM items i WHERE |'), ['orders o', 'items i']);
    assert.deepStrictEqual(scope('INSERT INTO orders (|)'), ['orders']);
    assert.strictEqual(kind('INSERT INTO orders (|)'), 'expression');
    assert.deepStrictEqual(scope('PIVOT sales ON |'), ['sales']);
  });

  test('nothing in comments, strings and numbers', () => {
    for (const sql of ['SELECT 1 -- a|', 'SELECT /* a| */ 1', "SELECT 'ab|'", 'SELECT 12|', "SELECT * FROM t WHERE s = 'da|'"]) {
      assert.strictEqual(kind(sql), 'none', sql);
    }
    assert.strictEqual(kind('SELECT /* x */ |'), 'expression');
  });

  test('file names in strings where DuckDB reads a file', () => {
    const plain = at("SELECT * FROM 'data/sal|");
    assert.deepStrictEqual(plain.position, { kind: 'path', typed: 'data/sal' });
    assert.deepStrictEqual([plain.prefix, plain.start, plain.end], ['sal', plain.offset - 3, plain.offset]);
    const call = at("SELECT * FROM read_csv('da|ta.csv', header = true)");
    assert.deepStrictEqual([call.position, call.end], [{ kind: 'path', typed: 'da' }, call.offset + 6]);
    assert.strictEqual(kind("ATTACH 'x|"), 'path');
    assert.strictEqual(kind("SELECT * FROM read_parquet(['a.parquet', 'b|'])"), 'path');
    assert.strictEqual(kind("COPY t TO 'out|"), 'path');
    assert.strictEqual(kind("SELECT * FROM read_csv('x.csv', sep = '|')"), 'none');
  });

  test('types', () => {
    for (const sql of ['SELECT x::|', 'SELECT x::VARCH|', 'SELECT CAST(x AS |)', 'SELECT try_cast(x AS i|)', 'CREATE TABLE t (id |)']) {
      assert.strictEqual(kind(sql), 'type', sql);
    }
    assert.strictEqual(kind('CREATE TABLE t (id INTEGER, |)'), 'none');
  });

  test('function calls', () => {
    assert.deepStrictEqual(at("SELECT date_diff('day', a, |)").call, { name: 'date_diff', argument: 2, atArgumentStart: true });
    assert.deepStrictEqual(at('SELECT sum(x + (y|))').call, { name: 'sum', argument: 0, atArgumentStart: false });
    assert.deepStrictEqual(at("SELECT * FROM read_csv('x.csv', |)").call, { name: 'read_csv', argument: 1, atArgumentStart: true });
    assert.deepStrictEqual(at('SELECT round(x, 2|)').call, { name: 'round', argument: 1, atArgumentStart: true });
    assert.deepStrictEqual(at('SELECT list_sum([1, 2, 3], |)').call?.argument, 1);
    assert.deepStrictEqual(at('SELECT demo.main.f(|)').call?.name, 'f');
    assert.strictEqual(at('SELECT * FROM t WHERE x IN (|)').call, undefined);
    assert.strictEqual(at('SELECT count(*) OVER (|)').call, undefined);
  });

  test('databases after USE and DETACH', () => {
    assert.strictEqual(kind('USE |'), 'database');
    assert.strictEqual(kind('DETACH de|'), 'database');
  });

  test('keyword case follows the cell', () => {
    assert.strictEqual(at('select * from |').upperKeywords, false);
    assert.strictEqual(at('SELECT * FROM |').upperKeywords, true);
    assert.strictEqual(at('|').upperKeywords, true);
    assert.strictEqual(at('sel|').upperKeywords, false);
  });

  test('select list aliases', () => {
    assert.deepStrictEqual(at('SELECT a + 1 AS b, c, sum(d) total FROM t ORDER BY |').selectAliases, ['b', 'total']);
  });
});
