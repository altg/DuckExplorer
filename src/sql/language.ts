/**
 * DuckExplorer's own SQL language. Notebook SQL cells, and the SQL editors DuckExplorer opens (the
 * query history, a view's SQL, copies to change and run), use it rather than VS Code's `sql`, which
 * other extensions take for their own dialect: SQL Server's checks every `sql` document as T-SQL, so
 * `LIMIT 100` would show as an error. Its highlighting is the `sql` grammar's.
 *
 * `.sql` files stay `sql`, for the other tools people use on them; DuckExplorer runs and completes
 * both (and `"files.associations": { "*.sql": "duckdb-sql" }` gives `.sql` files to DuckExplorer alone).
 */
export const DUCKDB_SQL = 'duckdb-sql';

/** The language ids DuckExplorer treats as DuckDB SQL. */
export const SQL_LANGUAGES: readonly string[] = [DUCKDB_SQL, 'sql'];

export function isSqlLanguage(languageId: string): boolean {
  return SQL_LANGUAGES.includes(languageId);
}

/** A cell's language as `.duckbook` files keep it: `sql`, as before DuckDB SQL had its own id, so older versions still read them. */
export function fileLanguage(languageId: string): string {
  return languageId === DUCKDB_SQL ? 'sql' : languageId;
}

/** A cell's language from a `.duckbook` file: its SQL (`sql`, or none for a code cell) is DuckDB SQL. */
export function cellLanguage(fileLanguage: string | undefined, markdown: boolean): string {
  if (markdown) return fileLanguage ?? 'markdown';
  return !fileLanguage || fileLanguage === 'sql' ? DUCKDB_SQL : fileLanguage;
}
