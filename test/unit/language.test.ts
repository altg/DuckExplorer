import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { cellLanguage, DUCKDB_SQL, fileLanguage, isSqlLanguage } from '../../src/sql/language';

const ROOT = path.resolve(__dirname, '../../..');

suite('DuckDB SQL language', () => {
  test('SQL cells of .duckbook files open as DuckDB SQL', () => {
    assert.strictEqual(cellLanguage('sql', false), DUCKDB_SQL);
    assert.strictEqual(cellLanguage(undefined, false), DUCKDB_SQL);
    assert.strictEqual(cellLanguage(DUCKDB_SQL, false), DUCKDB_SQL);
    assert.strictEqual(cellLanguage('python', false), 'python');
    assert.strictEqual(cellLanguage(undefined, true), 'markdown');
    assert.strictEqual(cellLanguage('markdown', true), 'markdown');
  });

  test('and save as sql, so older versions still read them', () => {
    assert.strictEqual(fileLanguage(DUCKDB_SQL), 'sql');
    assert.strictEqual(fileLanguage('python'), 'python');
    assert.strictEqual(fileLanguage('markdown'), 'markdown');
  });

  test('both sql and DuckDB SQL documents are DuckDB SQL to run and complete', () => {
    assert.deepStrictEqual(['sql', DUCKDB_SQL, 'python', 'plaintext'].map(isSqlLanguage), [true, true, false, false]);
  });

  test('the manifest contributes the language, highlighted with the sql grammar', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const language = manifest.contributes.languages.find((l: any) => l.id === DUCKDB_SQL);
    assert.ok(language, 'duckdb-sql in contributes.languages');
    assert.ok(fs.existsSync(path.join(ROOT, language.configuration)), language.configuration);
    const grammar = manifest.contributes.grammars.find((g: any) => g.language === DUCKDB_SQL);
    const tm = JSON.parse(fs.readFileSync(path.join(ROOT, grammar.path), 'utf8'));
    assert.strictEqual(tm.scopeName, grammar.scopeName);
    assert.deepStrictEqual(tm.patterns, [{ include: 'source.sql' }]);
    assert.ok(manifest.activationEvents.includes(`onLanguage:${DUCKDB_SQL}`));
  });
});
