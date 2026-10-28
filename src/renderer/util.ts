export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** DuckDB type names short enough for a column header. */
export function shortType(type: string): string {
  const t = type.toUpperCase();
  if (t.startsWith('STRUCT')) return 'STRUCT';
  if (t.startsWith('MAP')) return 'MAP';
  if (t.startsWith('UNION')) return 'UNION';
  if (t.endsWith(']')) return 'LIST';
  if (t.startsWith('TIMESTAMP WITH TIME ZONE')) return 'TIMESTAMPTZ';
  return t.replace(/\(.*\)$/, '');
}

export function formatDuration(ms: number): string {
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}
