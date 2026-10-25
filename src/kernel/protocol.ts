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

// Renderer <-> extension messages (notebook renderer messaging).

export interface FetchPageRequest {
  type: 'fetchPage';
  requestId: number;
  resultId: string;
  offset: number;
  limit: number;
}

export interface PageResponse {
  type: 'page';
  requestId: number;
  rows?: Cell[][];
  /** 'expired' when the kernel no longer holds the result (restarted, evicted, reopened file). */
  error?: 'expired' | string;
}
