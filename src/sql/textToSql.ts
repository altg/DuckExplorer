// Text-to-SQL: the prompt that asks a language model for DuckDB SQL, and the SQL in its answer.
// No vscode imports: shared with the unit tests.

import type { FrameInfo, RelationNode, SchemaTree } from '../kernel/protocol';
import { quoteIdentifier } from './identifiers';
import { splitStatements } from './statements';

/** A request written as `--` comments after a cell's or file's last statement, or in a cell of comments only. */
export interface Description {
  /** The comments' text, without the dashes. */
  request: string;
  /** Offsets of the comments: the first one's `--`, and the end of the last line. */
  start: number;
  end: number;
  /** There is no statement before them: the SQL would be all of the cell. */
  alone: boolean;
}

/**
 * The last block of `--` comment lines after the text's last statement (not one on that statement's
 * own line), as a request for Write SQL: `-- customers who bought books and toys` at the end of a cell.
 */
export function trailingDescription(text: string): Description | undefined {
  const statements = splitStatements(text);
  let from = 0;
  if (statements.length) {
    const through = statements[statements.length - 1].through;
    const newline = text.indexOf('\n', through);
    if (newline < 0) return undefined;
    from = newline + 1;
  }
  type Block = { start: number; end: number; lines: string[] };
  let last: Block | undefined;
  let current: Block | undefined;
  let offset = from;
  for (const raw of text.slice(from).split('\n')) {
    const line = raw.replace(/\r$/, '');
    const comment = /^(\s*)--\s?(.*)$/.exec(line);
    if (comment && comment[2].trim()) {
      current ??= { start: offset + comment[1].length, end: 0, lines: [] };
      current.lines.push(comment[2].trim());
      current.end = offset + line.length;
      last = current;
    } else {
      current = undefined; // a blank line (or an empty `--`) ends a block: a later one takes its place
    }
    offset += raw.length + 1;
  }
  return last && { request: last.lines.join(' '), start: last.start, end: last.end, alone: statements.length === 0 };
}

/** Characters of schema in a prompt: past this, columns and then tables are left out (and the prompt says so). */
const SCHEMA_BUDGET = 24_000;
/** Characters of the SQL around the cursor, before it and after it. */
const AROUND_BEFORE = 3_000;
const AROUND_AFTER = 1_000;

export interface SqlRequest {
  /** What the user asked for, in their words. */
  request: string;
  schema: SchemaTree;
  frames: FrameInfo[];
  duckdbVersion?: string;
  /** The SQL before and after the cursor (the cell or file), for context. */
  before: string;
  after: string;
  /** A notebook's SQL cell (else a .sql file). */
  notebook: boolean;
}

export function sqlPrompt(req: SqlRequest): string {
  const version = req.duckdbVersion ? ` ${req.duckdbVersion}` : '';
  const parts = [
    `Write one DuckDB${version} SQL statement for this request:`,
    '',
    req.request.trim(),
    '',
    'Answer with the SQL in a single ```sql code block, and nothing else: no explanation. Comments in the SQL are fine where they help.',
    'Use only the tables, views, columns and DataFrames listed below, with their names as written there (quoted where they need quoting).',
    "Write DuckDB's dialect: its functions and syntax (GROUP BY ALL, QUALIFY, FROM-first, list and struct functions, read_csv and read_parquet for files) where they make the query clearer.",
    'Unless the request says otherwise, write a query (a SELECT) rather than a statement that changes the database.',
    '',
    describeSchema(req.schema, req.frames),
  ];
  const before = req.before.slice(-AROUND_BEFORE);
  const after = req.after.slice(0, AROUND_AFTER);
  if (before.trim() || after.trim()) {
    const where = req.notebook ? 'SQL cell' : '.sql file';
    parts.push(
      '',
      `The statement goes at <cursor> in this ${where}, which may show the tables, names and style to use:`,
      '```sql',
      `${req.before.length > before.length ? '…' : ''}${before}<cursor>${after}${req.after.length > after.length ? '…' : ''}`,
      '```',
    );
  }
  return parts.join('\n');
}

/** The prompt that asks for the statement again, with DuckDB's error for the first try. */
export function repairPrompt(sql: string, error: string): string {
  return [
    'DuckDB rejects that statement:',
    '```sql',
    sql,
    '```',
    error.trim(),
    '',
    'Fix it. Answer with the corrected SQL in a single ```sql code block, and nothing else.',
  ].join('\n');
}

/** The SQL of an answer: its first ```sql block (else its first code block, else all of it), without a trailing semicolon. */
export function sqlOfAnswer(answer: string): string {
  const blocks = [...answer.matchAll(/```([\w-]*)[^\S\n]*\n([\s\S]*?)(?:```|$)/g)];
  const block = blocks.find((m) => /^(sql|duckdb)$/i.test(m[1])) ?? blocks[0];
  const sql = (block ? block[2] : answer).replace(/\r\n/g, '\n').trim();
  return sql.replace(/;\s*$/, '').trim();
}

/** The databases, schemas, tables, views and columns, as names to use in SQL; then the notebook's DataFrames. */
export function describeSchema(schema: SchemaTree, frames: FrameInfo[], budget = SCHEMA_BUDGET): string {
  type Entry = { name: string; relation: RelationNode; note: string };
  const sections: { title: string; entries: Entry[] }[] = [];
  const databases = [...schema.databases].sort((a, b) => Number(b.name === schema.current) - Number(a.name === schema.current));
  for (const db of databases) {
    const current = db.name === schema.current;
    const temp = db.name === 'temp';
    const where = db.path ? `the file ${db.path}` : temp ? 'temporary tables and views' : db.name === 'files' ? 'data files opened in DuckExplorer, as views' : 'in memory';
    const title = current
      ? `Database ${quoteIdentifier(db.name)} (${where}), the default: its tables are named without the database, and in schema ${quoteIdentifier(schema.currentSchema || 'main')} without the schema:`
      : `Database ${quoteIdentifier(db.name)} (${where}${db.readOnly ? ', read-only' : ''}):`;
    const entries: Entry[] = [];
    for (const s of db.schemas) {
      for (const relation of s.relations) {
        const parts = current ? (s.name === (schema.currentSchema || 'main') ? [] : [s.name]) : temp ? [] : [db.name, s.name];
        const name = [...parts, relation.name].map(quoteIdentifier).join('.');
        const rows = relation.rowEstimate != null ? `, about ${relation.rowEstimate.toLocaleString('en-US')} rows` : '';
        const comment = relation.comment ? ` (${db.name === 'files' && relation.kind === 'view' ? 'of the file ' : ''}${relation.comment.replace(/\s+/g, ' ')})` : '';
        entries.push({ name, relation, note: `${relation.kind}${rows}${comment}` });
      }
    }
    if (entries.length) sections.push({ title, entries });
  }
  const frameEntries = frames.map<Entry>((frame) => ({
    name: quoteIdentifier(frame.name),
    relation: { name: frame.name, kind: 'table', rowEstimate: null, comment: null, columns: frame.columns.map((c) => ({ ...c, nullable: true })) },
    note: 'DataFrame',
  }));
  if (frameEntries.length) {
    sections.push({ title: "The notebook's Python DataFrames (and Arrow tables), which SQL reads by name:", entries: frameEntries });
  }
  if (!sections.length) {
    return 'There are no tables yet: no database is attached and no data file is open.';
  }

  const columns = (relation: RelationNode, limit = Infinity) => {
    const shown = relation.columns.slice(0, limit).map((c) => `${quoteIdentifier(c.name)} ${c.type}`);
    if (relation.columns.length > limit) shown.push(`… (${relation.columns.length - limit} more columns)`);
    return shown.join(', ');
  };
  const render = (columnLimit: number, relationLimit: number) => {
    let left = relationLimit;
    let omitted = 0;
    const lines: string[] = [];
    for (const section of sections) {
      lines.push(section.title);
      for (const entry of section.entries) {
        if (left-- <= 0) {
          omitted++;
          continue;
        }
        lines.push(`  ${entry.name} (${entry.note}): ${columns(entry.relation, columnLimit)}`);
      }
    }
    if (omitted) lines.push(`(${omitted} more tables and views are not listed here.)`);
    return lines.join('\n');
  };
  const total = sections.reduce((n, s) => n + s.entries.length, 0);
  for (const columnLimit of [Infinity, 30, 10]) {
    const text = render(columnLimit, total);
    if (text.length <= budget) return text;
  }
  // Still too long: as many tables (in order: the default database first) as fit.
  let low = 1;
  let high = total;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (render(10, mid).length <= budget) low = mid;
    else high = mid - 1;
  }
  return render(10, low);
}
