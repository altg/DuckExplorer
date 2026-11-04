import * as assert from 'assert';
import * as path from 'path';
import { fileKind, fileStatement, pathForSql, sqlString } from '../../src/sql/files';

const root = path.resolve('/work/project');
const at = (...parts: string[]) => path.join(root, ...parts);

suite('Dropped files', () => {
  test('databases are attached, data files read, anything else left alone', () => {
    for (const name of ['shop.duckdb', 'x.DDB', 'legacy.db']) assert.strictEqual(fileKind(name), 'database', name);
    for (const name of ['a.csv', 'b.TSV', 'c.parquet', 'd.json', 'e.jsonl', 'f.ndjson', 'g.xlsx', 'h.csv.gz', 'i.json.zst']) {
      assert.strictEqual(fileKind(name), 'data', name);
    }
    for (const name of ['notes.txt', 'a.csv.bak', 'archive.gz', 'parquet', 'x.xls']) assert.strictEqual(fileKind(name), undefined, name);
  });

  test('paths are relative to the folder the SQL runs in, when the file is in it', () => {
    assert.strictEqual(pathForSql(at('notebooks', 'data', 'sales.csv'), at('notebooks')), "'data/sales.csv'");
    assert.strictEqual(pathForSql(at('sales.csv'), root), "'sales.csv'");
  });

  test('or in the same workspace folder; absolute otherwise', () => {
    const file = at('data', 'sales.csv');
    assert.strictEqual(pathForSql(file, at('notebooks'), root), "'../data/sales.csv'");
    const absolute = `'${file.split(path.sep).join('/')}'`;
    assert.strictEqual(pathForSql(file, at('notebooks')), absolute); // no workspace folder
    assert.strictEqual(pathForSql(file, path.resolve('/elsewhere'), root), absolute); // the notebook is outside it
    assert.strictEqual(pathForSql(file, undefined, root), absolute);
    // A sibling folder whose name starts like the base's isn't inside it.
    assert.strictEqual(pathForSql(at('data2', 'x.csv'), at('data')), `'${at('data2', 'x.csv').split(path.sep).join('/')}'`);
  });

  test('quotes are doubled', () => {
    assert.strictEqual(sqlString("it's"), "'it''s'");
    assert.strictEqual(pathForSql(at("o'brien.csv"), root), "'o''brien.csv'");
  });

  test('statements', () => {
    assert.strictEqual(fileStatement('data', "'a.csv'"), "SELECT * FROM 'a.csv';");
    assert.strictEqual(fileStatement('database', "'shop.duckdb'"), "ATTACH 'shop.duckdb';");
  });
});
