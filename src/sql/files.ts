// Data and database files as SQL: what DuckDB can read or attach, and their paths as string literals.
// No vscode imports: shared with the unit tests.
import * as path from 'path';

/** A database to attach, or a file DuckDB reads with `FROM 'file'`. */
export type FileKind = 'database' | 'data';

const DATABASE = /\.(duckdb|ddb|db)$/i;
// DuckDB's replacement scans read these by extension; text formats may also be compressed.
const DATA = /\.((csv|tsv|json|jsonl|ndjson)(\.(gz|zst))?|parquet|xlsx)$/i;

export function fileKind(fileName: string): FileKind | undefined {
  if (DATABASE.test(fileName)) return 'database';
  if (DATA.test(fileName)) return 'data';
  return undefined;
}

/** The file types, for messages. */
export const READABLE = '.csv, .tsv, .parquet, .json, .jsonl, .ndjson and .xlsx';

/** A SQL string literal. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A file's path as SQL that runs with `base` as the current folder: relative when the file is in
 * `base` or in the same `root` (the workspace folder) as it, so the notebook still works when the
 * folder moves; absolute otherwise. Forward slashes, which DuckDB reads on every platform.
 */
export function pathForSql(file: string, base: string | undefined, root?: string): string {
  const relative =
    base !== undefined && (within(base, file) || (root !== undefined && within(root, file) && within(root, base)));
  const shown = relative ? path.relative(base, file) : path.resolve(file);
  return sqlString(shown.split(path.sep).join('/'));
}

/** Whether `target` is `folder` or inside it. */
function within(folder: string, target: string): boolean {
  const rel = path.relative(folder, target);
  return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/** The statement a dropped file becomes: a query of a data file, an ATTACH of a database. */
export function fileStatement(kind: FileKind, literal: string): string {
  return kind === 'database' ? `ATTACH ${literal};` : `SELECT * FROM ${literal};`;
}
