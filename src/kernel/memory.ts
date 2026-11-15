import type { MemoryInfo } from './protocol';

const MB = 1024 ** 2;

/** A size as the settings state sizes: MB of 1024², and GB from 1,024 MB on. */
export function formatBytes(bytes: number): string {
  if (bytes > 0 && bytes < MB) {
    return '<1 MB';
  }
  const mb = bytes / MB;
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${Math.round(mb).toLocaleString('en-US')} MB`;
}

/** The size the status bar shows: the kernel process's memory, or the kept results where that is unknown. */
export function memoryLabel(info: MemoryInfo): string {
  return formatBytes(info.processBytes ?? info.results.bytes);
}

/** The status bar tooltip's lines about memory (Markdown, one per line). */
export function memoryLines(info: MemoryInfo): string[] {
  const lines: string[] = [];
  if (info.processBytes !== null) {
    lines.push(`Memory: **${formatBytes(info.processBytes)}** (the kernel process)`);
  }
  const { bytes, count, largestBytes, limitBytes } = info.results;
  const kept = limitBytes > 0 ? `${formatBytes(bytes)} of ${formatBytes(limitBytes)}` : `${formatBytes(bytes)}, no limit`;
  const detail = count === 0 ? 'none kept' : count === 1 ? '1 result' : `${count} results, largest ${formatBytes(largestBytes)}`;
  lines.push(`Query results: ${kept} (${detail})`);
  if (info.duckdbBytes !== null) {
    const limit = info.duckdbLimit ? ` of ${info.duckdbLimit} (memory_limit)` : '';
    lines.push(`DuckDB buffers: ${formatBytes(info.duckdbBytes)}${limit}`);
  }
  return lines;
}
