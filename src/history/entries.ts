// The entries of the query history, how they are shown, and which queries it leaves out. No vscode
// imports: shared with the unit tests.
import { splitStatements } from '../sql/statements';
import { tokenize } from '../sql/tokens';

/** What came of running a query. */
export type HistoryOutcome =
  | { kind: 'rows'; rows: number }
  /** A statement without rows; `message` says what it did ("3 rows inserted") when DuckDB says. */
  | { kind: 'done'; message?: string }
  /** DuckDB's message (without its excerpt of the line); `statement`: which one of a run failed. */
  | { kind: 'error'; message: string; statement?: number }
  | { kind: 'interrupted' };

/** Where a query ran: a notebook cell, or statements of a .sql file. */
export interface HistorySource {
  kind: 'notebook' | 'file';
  /** The notebook or file, as a URI string. */
  uri: string;
  /** "orders.sql:12", "analysis.duckbook, cell 3". */
  label: string;
  /** Where to look for the query first: its offset in the file, or its cell's index. */
  at: number;
}

export interface HistoryEntry {
  id: string;
  /** A notebook cell's SQL, or a .sql file's statements from the first to the last (with what is between them). */
  sql: string;
  /** When it started, in ms since the epoch. */
  time: number;
  elapsedMs: number;
  /** How many statements a run of a .sql file had. */
  statements?: number;
  outcome: HistoryOutcome;
  source: HistorySource;
  /** The folder it ran in: relative paths in it resolve against this folder when it runs again. */
  cwd?: string;
}

/** The query on one line, without comments or the last `;`: its label. */
export function condense(sql: string, max = 500): string {
  let text = '';
  let at = 0;
  for (const token of tokenize(sql)) {
    if (token.kind === 'comment') {
      text += `${sql.slice(at, token.start)} `;
      at = token.end;
    }
  }
  text = (text + sql.slice(at)).replace(/\s+/g, ' ').replace(/[\s;]+$/, '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** How it went, in a few words: "1,204 rows", "3 rows inserted", "Binder Error", "interrupted"; '' for a statement that only ran. */
export function outcomeText(outcome: HistoryOutcome): string {
  switch (outcome.kind) {
    case 'rows':
      return outcome.rows === 1 ? '1 row' : `${outcome.rows.toLocaleString('en-US')} rows`;
    case 'done':
      return outcome.message ?? '';
    case 'error':
      return errorKind(outcome.message);
    case 'interrupted':
      return 'interrupted';
  }
}

/** DuckDB's kind of error ("Binder Error: …" → "Binder Error"), else "failed". */
export function errorKind(message: string): string {
  return /^([A-Z][A-Za-z ]*Error):/.exec(message)?.[1] ?? 'failed';
}

/** DuckDB's message without the `LINE n: …` excerpt and caret it ends with (as the kernel strips it from .sql file errors). */
export function withoutExcerpt(message: string): string {
  return message.replace(/\n+LINE \d+: [^\r\n]*\n *\^[ \t]*$/, '');
}

const SECRET_MODIFIERS = new Set(['OR', 'REPLACE', 'PERSISTENT', 'TEMPORARY', 'TEMP']);
/** The words between `SET` and the setting's (or variable's) name. */
const SET_MODIFIERS = new Set(['GLOBAL', 'SESSION', 'LOCAL', 'VARIABLE']);
/** Settings and variables that hold credentials (`s3_secret_access_key`, `s3_session_token`, `azure_storage_connection_string`…). */
const CREDENTIAL_SETTING = /secret|token|password|access_key|connection_string/i;
/**
 * Credentials in a connection string or URL: `'md:?motherduck_token=…'`, `'host=… password=…'`,
 * `'postgresql://user:password@host/db'`, an Azure SAS URL's `…&sig=…`.
 */
const CREDENTIAL_PARAMETER = /(?:password|token)\s*=|[?&]sig=|:\/\/[^/@\s]*:[^/@\s]*@/i;

/** `CREATE SECRET`, a `SET` of a credential, or a connection string or URL with one: the history doesn't keep these. */
export function hasCredentials(sql: string): boolean {
  return splitStatements(sql).some(({ text }) => {
    const tokens = tokenize(text).filter((token) => token.kind !== 'comment');
    const first = tokens[0]?.text.toUpperCase();
    if (first === 'CREATE') {
      let i = 1;
      while (tokens[i]?.kind === 'word' && SECRET_MODIFIERS.has(tokens[i].text.toUpperCase())) i++;
      if (tokens[i]?.kind === 'word' && tokens[i].text.toUpperCase() === 'SECRET') return true;
    }
    if (first === 'SET') {
      const name = tokens.slice(1).find((token) => !SET_MODIFIERS.has(token.text.toUpperCase()));
      if (name && CREDENTIAL_SETTING.test(name.text)) return true;
    }
    return tokens.some((token) => token.kind === 'string' && CREDENTIAL_PARAMETER.test(token.text));
  });
}

/** The local day of `time`, for grouping: "2026-10-28". */
export function dayKey(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "Today", "Yesterday", else the date: "Monday, October 26". */
export function dayLabel(time: number, now = Date.now()): string {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const key = dayKey(time);
  if (key === dayKey(now)) return 'Today';
  if (key === dayKey(yesterday.getTime())) return 'Yesterday';
  const date = new Date(time);
  const year = date.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year });
}

/** The time of day: "14:32", or "14:32:05" with seconds. */
export function clock(time: number, seconds = false): string {
  const date = new Date(time);
  const parts = [date.getHours(), date.getMinutes(), ...(seconds ? [date.getSeconds()] : [])];
  return parts.map(pad).join(':');
}

/** As the results grid shows durations. */
export function formatDuration(ms: number): string {
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
