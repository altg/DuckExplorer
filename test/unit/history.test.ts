import * as assert from 'assert';
import { clock, condense, dayLabel, errorKind, hasCredentials, outcomeText, withoutExcerpt } from '../../src/history/entries';

suite('Query history entries', () => {
  test('a query on one line, without comments or its last semicolon', () => {
    assert.strictEqual(condense('-- Orders\nSELECT a,\n       b  -- the b\nFROM t /* x */ WHERE s = \'--\';\n'), "SELECT a, b FROM t WHERE s = '--'");
    assert.strictEqual(condense('SELECT 1;\nSELECT 2;'), 'SELECT 1; SELECT 2');
    assert.strictEqual(condense(`SELECT ${'x, '.repeat(20)}y`, 20), 'SELECT x, x, x, x, …');
  });

  test('how it went, in a few words', () => {
    assert.strictEqual(outcomeText({ kind: 'rows', rows: 1 }), '1 row');
    assert.strictEqual(outcomeText({ kind: 'rows', rows: 1204 }), '1,204 rows');
    assert.strictEqual(outcomeText({ kind: 'done', message: '3 rows inserted' }), '3 rows inserted');
    assert.strictEqual(outcomeText({ kind: 'done' }), '');
    assert.strictEqual(outcomeText({ kind: 'interrupted' }), 'interrupted');
    assert.strictEqual(outcomeText({ kind: 'error', message: 'Binder Error: Referenced column "x" not found' }), 'Binder Error');
    assert.strictEqual(errorKind('Invalid Input Error: no'), 'Invalid Input Error');
    assert.strictEqual(errorKind('The kernel stopped'), 'failed');
  });

  test("DuckDB's excerpt of the line in error is left out", () => {
    const message = 'Binder Error: Referenced column "missing" not found\n\nLINE 2:   missing\n          ^';
    assert.strictEqual(withoutExcerpt(message), 'Binder Error: Referenced column "missing" not found');
    assert.strictEqual(withoutExcerpt('Catalog Error: Table with name x does not exist!'), 'Catalog Error: Table with name x does not exist!');
  });

  test('secrets and credentials are found', () => {
    for (const sql of [
      "CREATE SECRET (TYPE s3, KEY_ID 'k', SECRET 's')",
      "create or replace persistent secret s3 (type s3, key_id 'k')",
      "SELECT 1; CREATE TEMPORARY SECRET IF NOT EXISTS x (TYPE http, BEARER_TOKEN 't')",
      "SET s3_secret_access_key = 'abc'",
      "SET GLOBAL s3_access_key_id = 'abc'",
      "ATTACH 'md:my_db?motherduck_token=abc'",
      "ATTACH 'dbname=shop host=db password=hunter2' AS shop (TYPE postgres)",
      "ATTACH 'postgresql://admin:hunter2@db.example.com:5432/shop' AS shop (TYPE postgres)",
      "ATTACH 'mysql://root:hunter2@localhost/db' AS m (TYPE mysql)",
      "SELECT * FROM read_parquet('https://acct.blob.core.windows.net/c/x.parquet?sv=2022-11-02&sig=AbC%2Bx')",
      "SET VARIABLE api_password = 'hunter2'",
    ]) {
      assert.ok(hasCredentials(sql), sql);
    }
    for (const sql of [
      'CREATE TABLE secret (id INT)',
      'SELECT * FROM duckdb_secrets()',
      "SET threads = 4; SET search_path = 'main'",
      "SELECT 'token' AS word",
      '-- CREATE SECRET in a comment\nSELECT 1',
      "ATTACH 'postgresql://admin@db.example.com/shop' AS shop (TYPE postgres)",
      "SELECT * FROM 's3://bucket/2024/a@b.parquet'",
      "SELECT * FROM read_csv('https://example.com:8443/data.csv?signed=1')",
      'SET VARIABLE row_limit = 10',
    ]) {
      assert.ok(!hasCredentials(sql), sql);
    }
  });

  test('days and times', () => {
    const now = new Date(2026, 9, 28, 14, 32, 5).getTime();
    assert.strictEqual(dayLabel(now - 60_000, now), 'Today');
    assert.strictEqual(dayLabel(new Date(2026, 9, 27, 23, 59).getTime(), now), 'Yesterday');
    assert.ok(/26/.test(dayLabel(new Date(2026, 9, 26, 9, 0).getTime(), now)));
    assert.ok(/2025/.test(dayLabel(new Date(2025, 9, 26, 9, 0).getTime(), now)));
    assert.strictEqual(clock(now), '14:32');
    assert.strictEqual(clock(new Date(2026, 9, 28, 9, 5, 7).getTime(), true), '09:05:07');
  });
});
