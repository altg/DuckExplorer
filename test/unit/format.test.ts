import * as assert from 'assert';
import { formatSql } from '../../src/sql/format';

/** Lines, as test text: `|` for the indent of each level. */
function layout(sql: string): string[] {
  return formatSql(sql)
    .split('\n')
    .map((line) => line.replace(/^( {4})+/, (indent) => '|'.repeat(indent.length / 4)));
}

suite('SQL layout of view definitions', () => {
  test('short statements stay on one line', () => {
    assert.deepStrictEqual(layout('CREATE VIEW s.w AS SELECT 42 AS answer;'), ['CREATE VIEW s.w AS SELECT 42 AS answer;']);
  });

  test('a clause per line; a long select list an item per line', () => {
    // As duckdb_views() has it: normalized on one line (count_star, ~~, doubled brackets).
    const sql =
      "CREATE VIEW order_totals AS SELECT o.order_id, o.customer_id, count_star() AS items, CASE  WHEN ((o.x > 5)) THEN ('big') ELSE 'small' END AS size, " +
      "round(sum(((oi.quantity * oi.unit_price) * (1 - oi.discount))), 2) AS revenue FROM orders AS o INNER JOIN order_items AS oi USING (order_id) " +
      "LEFT OUTER JOIN c ON ((c.x = o.x)) , d WHERE (o.status ~~ 'a%') GROUP BY ALL HAVING (count_star() > 1) ORDER BY revenue DESC NULLS LAST LIMIT 10 OFFSET 2;";
    assert.deepStrictEqual(layout(sql), [
      'CREATE VIEW order_totals AS',
      'SELECT',
      '|o.order_id,',
      '|o.customer_id,',
      '|count_star() AS items,',
      "|CASE WHEN ((o.x > 5)) THEN ('big') ELSE 'small' END AS size,",
      '|round(sum(((oi.quantity * oi.unit_price) * (1 - oi.discount))), 2) AS revenue',
      'FROM orders AS o',
      'INNER JOIN order_items AS oi USING (order_id)',
      'LEFT OUTER JOIN c ON ((c.x = o.x)), d',
      "WHERE (o.status ~~ 'a%')",
      'GROUP BY ALL',
      'HAVING (count_star() > 1)',
      'ORDER BY revenue DESC NULLS LAST',
      'LIMIT 10',
      'OFFSET 2;',
    ]);
  });

  test('brackets of a function, window or filter keep their clauses on the line', () => {
    const sql =
      'CREATE VIEW w AS SELECT sum(z) FILTER (WHERE (z > 0)) AS s, row_number() OVER (PARTITION BY y ORDER BY x DESC) AS rn, ' +
      'extract(year FROM d) AS yr, x IS DISTINCT FROM y AS changed FROM t;';
    assert.deepStrictEqual(layout(sql), [
      'CREATE VIEW w AS',
      'SELECT',
      '|sum(z) FILTER (WHERE (z > 0)) AS s,',
      '|row_number() OVER (PARTITION BY y ORDER BY x DESC) AS rn,',
      '|extract(year FROM d) AS yr,',
      '|x IS DISTINCT FROM y AS changed',
      'FROM t;',
    ]);
  });

  test('CTEs and long subqueries are indented in their brackets; short ones stay on their line', () => {
    // DuckDB 1.x writes `)SELECT` after the last CTE.
    const sql =
      'CREATE VIEW cte AS WITH a AS (SELECT x, y FROM t WHERE (x > 1)), b AS MATERIALIZED (SELECT * FROM a)SELECT a.x FROM a, ' +
      '(SELECT x, y, z, some_long_column_name, another_long_column_name FROM t) AS s WHERE (a.x = ANY(SELECT x FROM c WHERE (z > 3)));';
    assert.deepStrictEqual(layout(sql), [
      'CREATE VIEW cte AS',
      'WITH a AS (',
      '|SELECT x, y',
      '|FROM t',
      '|WHERE (x > 1)',
      '),',
      'b AS MATERIALIZED (',
      '|SELECT *',
      '|FROM a',
      ')',
      'SELECT a.x',
      'FROM a, (',
      '|SELECT x, y, z, some_long_column_name, another_long_column_name',
      '|FROM t',
      ') AS s',
      'WHERE (a.x = ANY(SELECT x FROM c WHERE (z > 3)));',
    ]);
  });

  test('set operations split their queries', () => {
    const sql = 'CREATE VIEW un AS ((SELECT x FROM t) UNION ALL (SELECT x FROM c)) UNION BY NAME (SELECT 1 AS x);';
    assert.deepStrictEqual(layout(sql), [
      'CREATE VIEW un AS',
      '(',
      '|(SELECT x FROM t)',
      '|UNION ALL',
      '|(SELECT x FROM c)',
      ')',
      'UNION BY NAME',
      '(SELECT 1 AS x);',
    ]);
    const recursive =
      'CREATE VIEW "recursive" AS WITH RECURSIVE r (n) AS ((SELECT 1) UNION  ALL (SELECT (n + 1) FROM r WHERE (n < 5)))SELECT n FROM r;';
    assert.deepStrictEqual(layout(recursive), [
      'CREATE VIEW "recursive" AS',
      'WITH RECURSIVE r (n) AS (',
      '|(SELECT 1)',
      '|UNION ALL',
      '|(SELECT (n + 1) FROM r WHERE (n < 5))',
      ')',
      'SELECT n',
      'FROM r;',
    ]);
  });

  test('a long condition splits at its ANDs and ORs, not at BETWEEN … AND', () => {
    const duckdb =
      "CREATE VIEW v AS SELECT x FROM t WHERE ((a.x = ANY(SELECT x FROM c WHERE (z > 3))) AND (b.y ~~ 'a%') AND (NOT EXISTS(SELECT 1 FROM t WHERE (t.x = c.z))));";
    assert.deepStrictEqual(layout(duckdb), [
      'CREATE VIEW v AS',
      'SELECT x',
      'FROM t',
      'WHERE ((a.x = ANY(SELECT x FROM c WHERE (z > 3)))',
      "|AND (b.y ~~ 'a%')",
      '|AND (NOT EXISTS(SELECT 1 FROM t WHERE (t.x = c.z))));',
    ]);
    const plain = "CREATE VIEW v AS SELECT x FROM t WHERE x BETWEEN 1 AND 10 AND y IS DISTINCT FROM 'some long string value' OR z = 3;";
    assert.deepStrictEqual(layout(plain), [
      'CREATE VIEW v AS',
      'SELECT x',
      'FROM t',
      'WHERE x BETWEEN 1 AND 10',
      "|AND y IS DISTINCT FROM 'some long string value'",
      '|OR z = 3;',
    ]);
  });

  test("DuckDB 2's brackets around joins: a join per line", () => {
    const sql =
      'CREATE VIEW j AS SELECT a.x, d.w FROM (((a INNER JOIN b ON ((a.x = b.x))) LEFT JOIN c ON ((c.x = a.x))) INNER JOIN d ON ((d.y = b.y)));';
    assert.deepStrictEqual(layout(sql), [
      'CREATE VIEW j AS',
      'SELECT a.x, d.w',
      'FROM (((a',
      '|INNER JOIN b ON ((a.x = b.x)))',
      '|LEFT JOIN c ON ((c.x = a.x)))',
      '|INNER JOIN d ON ((d.y = b.y)));',
    ]);
  });

  test('strings, quoted names and comments are kept as they are', () => {
    const sql = `CREATE VIEW "it's" AS SELECT 'FROM x WHERE y' AS "SELECT, FROM", 'it''s' AS q -- a note, (FROM\nFROM "WHERE" WHERE (x > 'a, b');`;
    assert.deepStrictEqual(layout(sql), [
      `CREATE VIEW "it's" AS`,
      'SELECT',
      `|'FROM x WHERE y' AS "SELECT, FROM",`,
      "|'it''s' AS q -- a note, (FROM",
      'FROM "WHERE"',
      "WHERE (x > 'a, b');",
    ]);
  });
});
