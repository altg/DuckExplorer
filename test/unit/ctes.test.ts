import * as assert from 'assert';
import { previewTarget, withClause } from '../../src/sql/ctes';

/** The preview for a cursor at the `|` in `sql`. */
function targetAt(sql: string) {
  const offset = sql.indexOf('|');
  return previewTarget(sql.slice(0, offset) + sql.slice(offset + 1), offset);
}

const QUERY = `WITH RECURSIVE "big orders" (id, amount) AS (
  SELECT id, amount FROM orders WHERE amount > (SELECT avg(amount) FROM orders)
), totals AS MATERIALIZED (SELECT customer, sum(amount) AS total FROM "big orders" GROUP BY ALL),
-- a comment, (with brackets
ranked AS NOT MATERIALIZED (SELECT *, rank() OVER (ORDER BY total DESC) AS r FROM totals)
SELECT * FROM ranked WHERE r <= 10`;

suite('CTEs of the live preview', () => {
  test('the CTEs of a WITH clause, and where its query starts', () => {
    const clause = withClause(QUERY)!;
    assert.deepStrictEqual(
      clause.ctes.map((cte) => [cte.name, QUERY.slice(cte.start, cte.end).split('\n')[0]]),
      [
        ['big orders', '"big orders" (id, amount) AS ('],
        ['totals', 'totals AS MATERIALIZED (SELECT customer, sum(amount) AS total FROM "big orders" GROUP BY ALL)'],
        ['ranked', 'ranked AS NOT MATERIALIZED (SELECT *, rank() OVER (ORDER BY total DESC) AS r FROM totals)'],
      ],
    );
    assert.ok(QUERY.slice(clause.ctes[0].start, clause.ctes[0].end).endsWith('FROM orders)\n)'));
    assert.ok(QUERY.slice(clause.queryStart).startsWith('SELECT * FROM ranked'));
    // Only the statement's own: not a subquery's, nor a query without one.
    assert.strictEqual(withClause('SELECT * FROM (WITH a AS (SELECT 1) FROM a)'), undefined);
    assert.strictEqual(withClause('-- note\nSELECT 1'), undefined);
  });

  test('with the cursor in a CTE, its rows; else the whole query', () => {
    const inTotals = targetAt(QUERY.replace('sum(amount)', 'sum(am|ount)'));
    assert.strictEqual(inTotals.cte, 'totals');
    assert.deepStrictEqual(inTotals.ctes, ['big orders', 'totals', 'ranked']);
    assert.ok(inTotals.sql.endsWith('GROUP BY ALL)\nSELECT * FROM totals'), inTotals.sql);
    assert.ok(!inTotals.sql.includes('ranked'));
    // On its name, too; the name is quoted when it must be.
    assert.ok(targetAt(QUERY.replace('"big orders" (id', '"big| orders" (id')).sql.endsWith('\nSELECT * FROM "big orders"'));
    const inQuery = targetAt(QUERY.replace('r <= 10', 'r <= |10'));
    assert.strictEqual(inQuery.cte, undefined);
    assert.strictEqual(inQuery.sql, QUERY);
    assert.deepStrictEqual(targetAt('SELECT |1'), { sql: 'SELECT 1', ctes: [] });
  });

  test('a query being written: an unclosed CTE runs to the end', () => {
    const typing = 'WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a WHERE |';
    const target = targetAt(typing);
    assert.strictEqual(target.cte, 'b');
    assert.deepStrictEqual(withClause(typing.replace('|', ''))!.queryStart, typing.length - 1);
    assert.deepStrictEqual(targetAt('WITH a AS (SELECT 1) SELECT * FROM |').ctes, ['a']);
    assert.strictEqual(withClause('WITH a'), undefined);
  });
});
