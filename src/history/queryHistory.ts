import * as vscode from 'vscode';
import { splitStatements } from '../sql/statements';
import { clock, dayKey, hasCredentials, HistoryEntry } from './entries';

/** A query that ran, as the notebook controller and the .sql file runner report it. */
export type QueryRun = Omit<HistoryEntry, 'id'>;

/** Read-only documents with the SQL of a history entry (src/history/historyView.ts). */
export const HISTORY_SCHEME = 'duckexplorer-history';

/** Longer queries (generated scripts, say) aren't kept. */
const MAX_SQL_CHARS = 50_000;
/** The oldest queries go when all of them together are longer: the workspace state is written on each run. */
const MAX_TOTAL_CHARS = 2_000_000;

/** The document that shows an entry's SQL; its name is when the query ran. */
export function historyUri(entry: HistoryEntry): vscode.Uri {
  const when = dayKey(entry.time) === dayKey(Date.now()) ? clock(entry.time, true) : `${dayKey(entry.time)} ${clock(entry.time, true)}`;
  return vscode.Uri.from({ scheme: HISTORY_SCHEME, path: `/${entry.id}/History ${when}.sql` });
}

export function entryIdOf(uri: vscode.Uri): string | undefined {
  return uri.scheme === HISTORY_SCHEME ? uri.path.split('/')[1] : undefined;
}

/**
 * The queries run in this workspace's notebooks and .sql files, newest first, kept in its workspace
 * state (up to `duckexplorer.historySize` of them). Queries that create secrets or set credentials
 * aren't kept.
 */
export class QueryHistory implements vscode.Disposable {
  private static readonly key = 'duckexplorer.queryHistory';
  private entries: HistoryEntry[];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly state: vscode.Memento) {
    this.entries = state.get<HistoryEntry[]>(QueryHistory.key, []);
  }

  dispose(): void {
    this.changed.dispose();
  }

  get all(): readonly HistoryEntry[] {
    return this.entries;
  }

  get(id: string | undefined): HistoryEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  /** Adds a query that ran. Run again from the history's document, it keeps the first run's source and folder. */
  record(run: QueryRun): HistoryEntry | undefined {
    const size = vscode.workspace.getConfiguration('duckexplorer').get<number>('historySize', 500);
    if (size <= 0 || run.sql.length > MAX_SQL_CHARS || !splitStatements(run.sql).length || hasCredentials(run.sql)) {
      return undefined;
    }
    const first = this.get(entryIdOf(vscode.Uri.parse(run.source.uri)));
    const entry: HistoryEntry = {
      id: `${run.time.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      ...run,
      ...(first && { source: first.source, cwd: first.cwd }),
    };
    let total = 0;
    this.entries = [entry, ...this.entries].slice(0, size).filter((kept) => (total += kept.sql.length) <= MAX_TOTAL_CHARS);
    void this.save();
    return entry;
  }

  async remove(ids: readonly string[]): Promise<void> {
    const removed = new Set(ids);
    this.entries = this.entries.filter((entry) => !removed.has(entry.id));
    await this.save();
  }

  async clear(): Promise<void> {
    this.entries = [];
    await this.save();
  }

  private async save(): Promise<void> {
    this.changed.fire();
    await this.state.update(QueryHistory.key, this.entries);
  }
}
