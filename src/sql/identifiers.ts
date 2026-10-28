// SQL identifiers as DuckDB reads them. No vscode imports: shared with the unit tests.

const SIMPLE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** DuckDB's reserved and type/function keywords: as a column or table name they need quotes. */
export const RESERVED = new Set([
  'all', 'analyse', 'analyze', 'and', 'anti', 'any', 'array', 'as', 'asc', 'asof', 'asymmetric', 'at',
  'authorization', 'binary', 'both', 'by', 'case', 'cast', 'check', 'collate', 'collation', 'column', 'columns',
  'concurrently', 'constraint', 'create', 'cross', 'default', 'deferrable', 'desc', 'describe', 'distinct', 'do',
  'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign', 'freeze', 'from', 'full', 'generated', 'glob',
  'group', 'having', 'ilike', 'in', 'initially', 'inner', 'intersect', 'into', 'is', 'isnull', 'join', 'lambda',
  'lateral', 'leading', 'left', 'like', 'limit', 'map', 'natural', 'not', 'notnull', 'null', 'offset', 'on',
  'only', 'or', 'order', 'outer', 'overlaps', 'pivot', 'pivot_longer', 'pivot_wider', 'placing', 'positional',
  'primary', 'qualify', 'references', 'returning', 'right', 'select', 'semi', 'show', 'similar', 'some',
  'struct', 'summarize', 'symmetric', 'table', 'tablesample', 'then', 'to', 'trailing', 'true', 'try_cast',
  'union', 'unique', 'unpack', 'unpivot', 'using', 'variadic', 'verbose', 'when', 'where', 'window', 'with',
]);

export function quoteIdentifier(name: string): string {
  return SIMPLE_IDENTIFIER.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** DuckDB matches identifiers case-insensitively, quoted or not. */
export function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
