import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Context keys the manifest's `when` clauses may use: ones VS Code sets where these menus and
 * keybindings are shown, and `config.*`. A key VS Code doesn't set is never true, so its button
 * silently never shows (as `cellLangId` did: VS Code has no language key for notebook cells).
 */
const KNOWN = new Set([
  'view',
  'viewItem',
  'editorLangId',
  'resourceLangId',
  'resourceScheme',
  'resourceFilename',
  'notebookType',
  'notebookCellType',
  'notebookEditorFocused',
  'editorTextFocus',
  'focusedView',
  'inputFocus',
  'false',
  'true',
]);

function whenClauses(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((item) => whenClauses(item, found));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'when' && typeof value === 'string') found.push(value);
      else whenClauses(value, found);
    }
  }
  return found;
}

/** The context keys a clause tests: what is left of each comparison, or a bare key. */
function keysOf(when: string): string[] {
  const withoutRegexes = when.replace(/=~\s*\/(?:\\.|[^/\\])*\/[a-z]*/g, '== x');
  return withoutRegexes
    .split(/&&|\|\||[()]|!(?!=)/)
    .map((term) => term.split(/==|!=|=~|<=|>=|<|>/)[0].trim())
    .filter(Boolean);
}

suite('Manifest', () => {
  test('when clauses use only context keys that VS Code sets', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
    const clauses = whenClauses(manifest.contributes);
    assert.ok(clauses.length > 20, `${clauses.length} when clauses`);
    const unknown = clauses.flatMap((when) => keysOf(when).filter((key) => !KNOWN.has(key) && !key.startsWith('config.')).map((key) => `${key} (in "${when}")`));
    assert.deepStrictEqual(unknown, []);
  });

  test('the clauses are read as keys and values', () => {
    assert.deepStrictEqual(keysOf('view == duckexplorer.schema && viewItem =~ /^(table|view)/'), ['view', 'viewItem']);
    assert.deepStrictEqual(keysOf('viewItem != message && !inputFocus'), ['viewItem', 'inputFocus']);
    assert.deepStrictEqual(keysOf('editorLangId == sql && (notebookEditorFocused || !config.duckexplorer.sqlFiles)'), [
      'editorLangId',
      'notebookEditorFocused',
      'config.duckexplorer.sqlFiles',
    ]);
  });
});
