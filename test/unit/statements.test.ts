import * as assert from 'assert';
import { splitStatements, statementAt } from '../../src/sql/statements';

/** The statement run for a cursor at the `|` in `sql`. */
function runAt(sql: string): string | undefined {
  const offset = sql.indexOf('|');
  const text = sql.slice(0, offset) + sql.slice(offset + 1);
  return statementAt(splitStatements(text), text, offset)?.text;
}

suite('SQL statements', () => {
  test('split on semicolons outside strings, names and comments', () => {
    const sql = `-- header\nSELECT ';' AS "a;b"; /* ; */\n\nINSERT INTO t VALUES ($$;$$) -- x;\n;;\nSELECT 3`;
    const statements = splitStatements(sql);
    assert.deepStrictEqual(
      statements.map((s) => s.text),
      [`SELECT ';' AS "a;b"`, 'INSERT INTO t VALUES ($$;$$)', 'SELECT 3'],
    );
    const [first, second, third] = statements;
    assert.strictEqual(sql.slice(first.start, first.through), `SELECT ';' AS "a;b";`);
    // The `;` after a trailing comment still ends the statement.
    assert.strictEqual(sql.slice(second.end, second.through), ' -- x;\n;');
    assert.strictEqual(third.through, third.end);
  });

  test('offsets of a selection are kept', () => {
    const [statement] = splitStatements('  SELECT 1;', 100);
    assert.deepStrictEqual([statement.start, statement.end, statement.through], [102, 110, 111]);
  });

  test('empty text and comments alone have no statements', () => {
    assert.deepStrictEqual(splitStatements(''), []);
    assert.deepStrictEqual(splitStatements('-- just a note\n/* and another */ ;'), []);
  });

  test('the statement at the cursor', () => {
    const sql = 'SELECT 1;\n\n-- second\nSELECT\n  2;  -- done\nSELECT 3';
    assert.strictEqual(runAt('|' + sql), 'SELECT 1');
    assert.strictEqual(runAt(sql.replace('1;', '1|;')), 'SELECT 1'); // before the `;`
    assert.strictEqual(runAt(sql.replace('1;', '1;|')), 'SELECT 1'); // right after it
    assert.strictEqual(runAt(sql.replace('\n\n', '\n|\n')), 'SELECT\n  2'); // on a blank line above it
    assert.strictEqual(runAt(sql.replace('-- second', '-- se|cond')), 'SELECT\n  2'); // on its comment
    assert.strictEqual(runAt(sql.replace('  2', '  |2')), 'SELECT\n  2');
    assert.strictEqual(runAt(sql.replace('-- done', '-- do|ne')), 'SELECT\n  2'); // later on its last line
    assert.strictEqual(runAt(sql + '|'), 'SELECT 3');
    assert.strictEqual(runAt(sql + '\n\n|'), 'SELECT 3'); // below the last one
    assert.strictEqual(runAt('|'), undefined);
  });
});
