// Messages exchanged with the Python kernel (python/duckexplorer_kernel/server.py) and with
// the notebook renderer. Shared by the extension host and the renderer bundle.

export const NOTEBOOK_TYPE = 'duckexplorer-notebook';
export const RENDERER_ID = 'duckexplorer-renderer';
export const TABLE_MIME = 'application/vnd.duckexplorer.table+json';
export const PLOTLY_MIME = 'application/vnd.duckexplorer.plotly+json';

export interface ColumnInfo {
  name: string;
  type: string;
}

export type Cell = string | null;

/** A query result as sent to the renderer: metadata plus the first page of rows. */
export interface TableResult {
  id: string;
  columns: ColumnInfo[];
  rowCount: number;
  rows: Cell[][];
  pageSize: number;
  elapsedMs?: number;
  /** Python variables the result was bound to (SQL cells only). */
  boundTo?: string[];
}

export type KernelOutput =
  | { type: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { type: 'text'; text: string }
  | { type: 'html'; html: string }
  | { type: 'table'; table: TableResult }
  | { type: 'png'; data: string }
  | { type: 'plotly'; json: string };

export interface KernelError {
  ename: string;
  evalue: string;
  traceback: string;
}

export interface ExecuteResult {
  outputs: KernelOutput[];
  error: KernelError | null;
}

export interface KernelInfo {
  python: string;
  executable: string;
  duckdb: string;
  pyarrow: string;
  pandas: string | null;
  matplotlib: string | null;
  plotly: string | null;
}

export interface ColumnNode {
  name: string;
  type: string;
  nullable: boolean;
}

export interface RelationNode {
  name: string;
  kind: 'table' | 'view';
  rowEstimate: number | null;
  comment: string | null;
  columns: ColumnNode[];
}

export interface SchemaNode {
  name: string;
  relations: RelationNode[];
}

export interface DatabaseNode {
  name: string;
  path: string | null;
  readOnly: boolean;
  type: string;
  schemas: SchemaNode[];
}

export interface SchemaTree {
  current: string;
  databases: DatabaseNode[];
}

export interface SortSpec {
  /** Column index in the result. */
  column: number;
  descending: boolean;
}

/**
 * A condition on one column of a result (python/duckexplorer_kernel/filters.py). Values are compared
 * as the grid shows them: `eq`/`ne` match the displayed text, `ge`/`le` compare typed values.
 */
export type FilterCondition =
  | { column: number; op: 'eq' | 'ne' | 'ge' | 'le'; value: string }
  | { column: number; op: 'null' | 'notNull' }
  /** The rows of one Column Explorer histogram bar; `label` is its range, for display. */
  | { column: number; op: 'bin'; bins: HistogramBins; index: number; label: string };

/** The rows of a result to show: every condition holds, and so does `where` (SQL over the column names). */
export interface FilterSpec {
  conditions: FilterCondition[];
  where?: string;
}

export interface HistogramBar {
  start: string;
  /** Inclusive for integer and DATE columns; equal to start when a bar holds a single value. */
  end: string;
  count: number;
}

/** How a histogram's bars were cut, so a `bin` filter selects exactly the rows a bar counts. */
export interface HistogramBins {
  low: number;
  width: number;
  count: number;
}

/** Column Explorer statistics for one column of a result (python/duckexplorer_kernel/profile.py). */
export interface ColumnProfile {
  name: string;
  type: string;
  kind: 'numeric' | 'temporal' | 'boolean' | 'text' | 'other';
  nulls: number;
  distinct: number;
  distinctApprox?: boolean;
  min?: string | null;
  max?: string | null;
  mean?: string;
  /** Numeric and temporal columns. */
  histogram?: HistogramBar[];
  bins?: HistogramBins;
  /** Other columns: the most frequent non-NULL values. */
  top?: { value: string; count: number }[];
  otherCount?: number;
  /** Every non-NULL value is distinct, so top values are omitted. */
  unique?: boolean;
}

export interface ResultProfile {
  rowCount: number;
  columns: ColumnProfile[];
}

// Renderer <-> extension messages (notebook renderer messaging). Each request type is also the
// kernel method that answers it; the remaining fields are its params.

export type RendererRequest =
  | {
      type: 'fetchPage';
      requestId: number;
      resultId: string;
      offset: number;
      limit: number;
      sort?: SortSpec;
      filter?: FilterSpec;
    }
  | { type: 'profileResult'; requestId: number; resultId: string; filter?: FilterSpec };

export interface RendererResults {
  /** `rowCount` is the number of rows in the sorted/filtered view. */
  fetchPage: { rows: Cell[][]; rowCount: number };
  profileResult: ResultProfile;
}

export interface RendererResponse {
  type: 'response';
  requestId: number;
  result?: unknown;
  /**
   * 'expired' when the kernel no longer holds the result (restarted, evicted, reopened file);
   * otherwise a message, such as DuckDB's error for an invalid filter.
   */
  error?: 'expired' | string;
}
