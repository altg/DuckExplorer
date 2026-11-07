// Messages exchanged with the Python kernel (python/duckexplorer_kernel/server.py) and with
// the notebook renderer. Shared by the extension host and the renderer bundle.

export const NOTEBOOK_TYPE = 'duckexplorer-notebook';
export const RENDERER_ID = 'duckexplorer-renderer';
export const TABLE_MIME = 'application/vnd.duckexplorer.table+json';
export const PLOTLY_MIME = 'application/vnd.duckexplorer.plotly+json';
/** A Vega-Lite spec (Altair charts). */
export const VEGALITE_MIME = 'application/vnd.duckexplorer.vegalite+json';

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
  /** Table summaries of large relations: the result is a random sample of this many rows. */
  sampledFrom?: number;
  /** Live previews: the result is the query's first rows, and it has more. */
  truncated?: boolean;
}

export type KernelOutput =
  | { type: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { type: 'text'; text: string }
  | { type: 'html'; html: string }
  | { type: 'table'; table: TableResult }
  | { type: 'png'; data: string }
  | { type: 'plotly'; json: string }
  | { type: 'vegalite'; json: string };

export interface KernelError {
  ename: string;
  evalue: string;
  traceback: string;
}

export interface ExecuteResult {
  /** Left out when the outputs were streamed (OutputUpdate notifications) while the cell ran. */
  outputs?: KernelOutput[];
  /** How many outputs were streamed. */
  streamed?: number;
  error: KernelError | null;
}

/**
 * The `output` notification of a cell that runs with a `stream` token (python/duckexplorer_kernel/pyexec.py,
 * Capture): its output number `index` is new, or that stream output has more text.
 */
export type OutputUpdate = { stream: number; index: number } & ({ output: KernelOutput } | { text: string });

/** The statements of a .sql file, run in order until one fails (python/duckexplorer_kernel/script.py). */
export interface StatementsResult {
  /** How many statements ran without error. */
  completed: number;
  elapsedMs: number;
  /** The last statement's rows. */
  table?: TableResult;
  /** What the last statement did, when it returns no rows ("3 rows inserted"); '' when there is nothing to say. */
  message?: string;
  error?: StatementError;
}

export interface StatementError {
  ename: string;
  /** DuckDB's message, with its excerpt of the line in error. */
  evalue: string;
  /** The message without the excerpt. */
  message: string;
  /** Index of the statement that failed. */
  statement: number;
  /** Where in that statement, as an offset in its text. */
  position?: number;
}

export interface KernelInfo {
  python: string;
  executable: string;
  duckdb: string;
  pyarrow: string;
  pandas: string | null;
  matplotlib: string | null;
  plotly: string | null;
  altair: string | null;
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
  /** The current database's default schema (USE db.schema); unqualified names resolve there, then in main. */
  currentSchema: string;
  databases: DatabaseNode[];
}

// SQL completions (python/duckexplorer_kernel/catalog.py).

export interface FunctionParam {
  /** Empty for unnamed parameters. */
  name: string;
  type?: string;
}

export interface FunctionSignature {
  params: FunctionParam[];
  /** Table functions: their `name := value` parameters. */
  named?: FunctionParam[];
  returns?: string;
  /** The type of any further arguments. */
  varargs?: string;
}

export interface FunctionInfo {
  name: string;
  kind: 'scalar' | 'aggregate' | 'macro' | 'table';
  signatures: FunctionSignature[];
  description?: string;
  example?: string;
  /** A user's macro: where it was created. */
  database?: string;
  schema?: string;
}

export interface FunctionCatalog {
  /** Changes when an extension is loaded or a macro created or dropped. */
  version: string;
  functions: FunctionInfo[];
  types: string[];
}

/** A Python variable that SQL cells can scan by name: a DataFrame, Arrow table or relation. */
export interface FrameInfo {
  name: string;
  columns: ColumnInfo[];
}

export interface SqlCatalogResult {
  /** Includes the `temp` database. */
  schema: SchemaTree;
  frames: FrameInfo[];
  /** Left out when the caller's functionsVersion is current. */
  functions?: FunctionCatalog;
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
  high: number;
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

/** The files an export writes (python/duckexplorer_kernel/export.py). */
export type ExportFormat = 'csv' | 'parquet' | 'xlsx';

/** A chart of a result's columns, in its Chart view (python/duckexplorer_kernel/chart.py). */
export interface ChartConfig {
  mark: 'bar' | 'line' | 'area' | 'point';
  /** Column indexes. */
  x: number;
  /** A numeric column, or null to count rows. */
  y: number | null;
  aggregate: 'sum' | 'mean' | 'median' | 'min' | 'max' | 'none';
  color: number | null;
  /** What temporal x values are truncated to; 'auto' lets the kernel choose. */
  timeUnit: 'auto' | 'none' | 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour' | 'minute';
}

/** What a column can be in a chart. */
export type ChartKind = 'numeric' | 'temporal' | 'text' | 'boolean' | 'other';

export interface ChartResult {
  /** The chart drawn: the request with the parts it left out (and 'auto') chosen. */
  chart: ChartConfig;
  kinds: ChartKind[];
  /** A Vega-Lite spec with its data. */
  spec: Record<string, unknown>;
  /** How many values the chart has. */
  rows: number;
  /** When it doesn't show every value ("5,000 rows sampled from 20,000"), or has none. */
  note?: string;
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
  | { type: 'profileResult'; requestId: number; resultId: string; filter?: FilterSpec }
  | { type: 'filterSql'; requestId: number; resultId: string; filter?: FilterSpec }
  | { type: 'chartSpec'; requestId: number; resultId: string; chart?: Partial<ChartConfig>; filter?: FilterSpec }
  /** Answered by the extension: a Python cell that draws the chart (the kernel's chartCode), run in a notebook. */
  | { type: 'insertChartCell'; requestId: number; resultId: string; chart: ChartConfig; filter?: FilterSpec }
  /** Answered by the extension: a SQL cell below the result's own, rerunning its query filtered and sorted. */
  | { type: 'insertFilteredCell'; requestId: number; resultId: string; filter?: FilterSpec; sort?: SortSpec }
  /**
   * Answered by the extension: asks for a format and a file, then has the kernel write the rows there,
   * filtered and sorted like the grid (the kernel method also takes `path` and `format`).
   */
  | { type: 'exportResult'; requestId: number; resultId: string; filter?: FilterSpec; sort?: SortSpec };

export interface RendererResults {
  /** `rowCount` is the number of rows in the sorted/filtered view. */
  fetchPage: { rows: Cell[][]; rowCount: number };
  profileResult: ResultProfile;
  /** The filter as one SQL condition over the result's column names. */
  filterSql: { where: string };
  chartSpec: ChartResult;
  insertFilteredCell: Record<string, never>;
  insertChartCell: Record<string, never>;
  /** The extension says how the export went. */
  exportResult: Record<string, never>;
}

// Summary panel (src/explorer/summaryPanel.ts <-> src/renderer/summary.ts). The panel's grid also
// sends RendererRequests and receives RendererResponses.

/** The table or view a summary shows. */
export interface SummaryRelation {
  database: string;
  schema: string;
  name: string;
  kind: 'table' | 'view';
  comment: string | null;
  /** The shortest name that resolves to it, for SQL written into notebooks. */
  qualified: string;
}

export type SummaryMessage =
  | { type: 'loading'; relation: SummaryRelation }
  | { type: 'summary'; relation: SummaryRelation; table: TableResult }
  | { type: 'error'; relation: SummaryRelation; message: string };

export type SummaryAction = { type: 'ready' } | { type: 'preview' } | { type: 'refresh' };

// The results view of .sql files (src/sql/resultsView.ts <-> src/renderer/results.ts). Its grid
// also sends RendererRequests and receives RendererResponses.

/** What a run of a .sql file ran. */
export interface RunSource {
  /** The file's name and the line of the first statement, e.g. "orders.sql:12". */
  label: string;
  /** The statements, for the header (shortened there). */
  sql: string;
  statements: number;
}

export type ResultsMessage =
  | { type: 'running'; source: RunSource }
  | { type: 'result'; source: RunSource; result: StatementsResult }
  /** The kernel couldn't run the statements (it failed to start, or stopped). */
  | { type: 'failed'; source: RunSource; message: string }
  | PreviewMessage;

/**
 * The live preview of the query at the cursor (src/sql/livePreview.ts): its first rows; or why it has
 * none, where the last rows stay, dimmed (an error as the query is written); or a note where nothing ran.
 */
export interface PreviewMessage {
  type: 'preview';
  source: PreviewSource;
  table?: TableResult;
  error?: string;
  note?: string;
}

export interface PreviewSource {
  /** Where the query is, e.g. "orders.sql:12" or "demo.duckbook, cell 3". */
  label: string;
  /** The statement at the cursor. */
  sql: string;
  /** Its CTEs, by name, and the one previewed (undefined for the statement's own rows). */
  ctes: string[];
  cte?: string;
}

/** What previewSql returns (python/duckexplorer_kernel/kernel.py, preview_sql). */
export interface PreviewReply {
  table?: TableResult;
  error?: { ename: string; evalue: string };
  /** Not run: "not a query", "side effects", or "busy" (a cell runs), "superseded" (by newer work), "interrupted". */
  skipped?: string;
}

export type ResultsAction =
  | { type: 'ready' }
  | { type: 'cancel' }
  | { type: 'reveal' }
  /** A CTE chip of the preview's header: the CTE to preview (undefined: the statement's own rows). */
  | { type: 'previewPart'; cte?: string };

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
