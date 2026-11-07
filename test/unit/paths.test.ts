import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { samePath } from '../../src/explorer/paths';

suite('Same file', () => {
  let dir: string;

  suiteSetup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duckexplorer-paths-'));
    fs.mkdirSync(path.join(dir, 'real'));
    fs.writeFileSync(path.join(dir, 'real', 'shop.duckdb'), '');
    // A junction (no admin rights needed on Windows): another name for the folder, as RUNNER~1 is for
    // runneradmin on CI's Windows runners. DuckDB reports the file under its final name.
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'alias'), 'junction');
  });

  suiteTeardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a file reached through another name for its folder', () => {
    assert.ok(samePath(path.join(dir, 'alias', 'shop.duckdb'), path.join(dir, 'real', 'shop.duckdb')));
  });

  test('written differently: relative parts, and on Windows case and the drive letter', () => {
    const file = path.join(dir, 'real', 'shop.duckdb');
    assert.ok(samePath(path.join(dir, 'real', '..', 'real', 'shop.duckdb'), file));
    if (process.platform === 'win32') {
      assert.ok(samePath(file.toUpperCase(), file[0].toLowerCase() + file.slice(1)));
    }
  });

  test('different files, existing or gone', () => {
    fs.writeFileSync(path.join(dir, 'real', 'other.duckdb'), '');
    assert.ok(!samePath(path.join(dir, 'real', 'shop.duckdb'), path.join(dir, 'real', 'other.duckdb')));
    assert.ok(samePath(path.join(dir, 'gone', 'x.duckdb'), path.join(dir, 'gone', '.', 'x.duckdb')));
    assert.ok(!samePath(path.join(dir, 'gone', 'x.duckdb'), path.join(dir, 'gone', 'y.duckdb')));
  });
});
