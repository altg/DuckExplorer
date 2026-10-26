import type { ColumnProfile, FilterCondition, FilterSpec, HistogramBar, ResultProfile, TableResult } from '../kernel/protocol';
import type { HostClient } from './client';
import { el, shortType } from './util';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_WIDTH = 240;
const CHART_HEIGHT = 40;
const TOP_SHOWN = 5;

/**
 * Column Explorer: one line per column of a result with its distribution (a histogram for numbers
 * and dates, the most frequent values otherwise), NULL share and distinct count, for the rows the
 * grid's filter keeps. Statistics are computed by the kernel when the view is opened. Clicking a
 * bar or a value filters to it (`onFilter`); clicking elsewhere on a line shows that column's rows.
 */
export class ColumnExplorer {
  readonly element = el('div', 'dx-columns');
  private state: 'idle' | 'loading' | 'loaded' = 'idle';
  private profile: ResultProfile | undefined;
  private filter: FilterSpec | undefined;
  /** Bumped when the filter changes, so statistics of the previous rows are dropped. */
  private generation = 0;

  constructor(
    private readonly result: TableResult,
    private readonly client: HostClient,
    private readonly signal: AbortSignal,
    private readonly onPick: (column: number) => void,
    private readonly onFilter: ((condition: FilterCondition) => void) | undefined,
  ) {
    this.element.tabIndex = 0;
    this.element.classList.toggle('filterable', onFilter !== undefined);
    this.element.addEventListener('click', (event) => this.onClick(event));
  }

  show(): void {
    if (this.state !== 'idle') return;
    this.state = 'loading';
    if (this.profile) {
      this.element.classList.add('dx-stale'); // keep the previous statistics up while new ones load
    } else {
      this.element.replaceChildren(el('div', 'dx-columns-status', 'Computing column statistics…'));
    }
    void this.load();
  }

  /** The grid's filter changed: statistics are recomputed for its rows (now, if the view is open). */
  setFilter(filter: FilterSpec | undefined): void {
    this.filter = filter;
    this.generation++;
    if (this.state === 'idle') return;
    this.state = 'idle';
    if (!this.element.hidden) this.show();
  }

  private onClick(event: MouseEvent): void {
    const target = event.target as Element;
    const line = target.closest<HTMLElement>('.dx-col[data-col]');
    if (!line) return;
    const index = Number(line.dataset.col);
    const column = this.state === 'loaded' ? this.profile?.columns[index] : undefined;
    const bar = target.closest<SVGGElement>('g[data-bar]');
    const value = target.closest<HTMLElement>('.dx-top-row[data-value]');
    if (this.onFilter && column?.histogram && column.bins && bar) {
      const { start, end } = column.histogram[Number(bar.dataset.bar)];
      this.onFilter({
        column: index,
        op: 'bin',
        bins: column.bins,
        index: Number(bar.dataset.bar),
        label: start === end ? start : `${start} – ${end}`,
      });
    } else if (this.onFilter && column && value) {
      this.onFilter({ column: index, op: 'eq', value: value.dataset.value! });
    } else {
      this.onPick(index);
    }
  }

  private async load(): Promise<void> {
    const generation = this.generation;
    const response = await this.client.profile(this.result.id, this.filter);
    if (this.signal.aborted || generation !== this.generation) return;
    this.element.classList.remove('dx-stale');
    if (!response.result) {
      this.profile = undefined;
      this.state = 'idle'; // try again the next time the view is opened
      const message =
        response.error === 'expired'
          ? 'Column statistics need the query result, which the kernel no longer holds. Run the cell again.'
          : `Could not compute column statistics: ${response.error}`;
      this.element.replaceChildren(el('div', 'dx-columns-status dx-error', message));
      return;
    }
    this.state = 'loaded';
    this.profile = response.result;
    this.render(response.result);
  }

  private render(profile: ResultProfile): void {
    const lines = profile.columns.map((column, i) => this.renderColumn(column, i, profile.rowCount));
    this.element.replaceChildren(...lines);
  }

  private renderColumn(column: ColumnProfile, index: number, rowCount: number): HTMLElement {
    const line = el('div', 'dx-col');
    line.dataset.col = String(index);
    line.title = 'Show this column in the rows view';

    const head = el('div', 'dx-col-head');
    const name = el('span', 'dx-col-name', column.name);
    name.title = column.name;
    const type = el('span', 'dx-col-type', shortType(column.type));
    type.title = column.type;
    head.append(name, type);

    const nonNull = rowCount - column.nulls;
    let chart: HTMLElement;
    if (rowCount === 0) {
      chart = el('div', 'dx-col-note', 'No rows');
    } else if (nonNull === 0) {
      chart = el('div', 'dx-col-note', 'All values are NULL');
    } else if (column.histogram) {
      chart = histogram(column.histogram, nonNull, this.onFilter !== undefined && column.bins !== undefined);
    } else if (column.top) {
      chart = topValues(column, nonNull, this.onFilter !== undefined);
    } else if (column.unique) {
      chart = el('div', 'dx-col-note', 'Every value is distinct');
    } else {
      chart = el('div', 'dx-col-note', 'No finite values');
    }
    chart.classList.add('dx-col-chart');

    const stats = el('div', 'dx-col-stats');
    stats.append(
      stat('NULL', percent(column.nulls, rowCount), `${column.nulls.toLocaleString()} of ${rowCount.toLocaleString()} rows`),
      stat('distinct', `${column.distinctApprox ? '≈' : ''}${column.distinct.toLocaleString()}`),
    );
    if (column.min != null) stats.append(stat('min', column.min));
    if (column.max != null) stats.append(stat('max', column.max));
    if (column.mean != null) stats.append(stat('mean', column.mean));

    line.append(head, chart, stats);
    return line;
  }
}

function histogram(bars: HistogramBar[], total: number, filterable: boolean): HTMLElement {
  const container = el('div', 'dx-hist');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`);
  svg.setAttribute('width', String(CHART_WIDTH));
  svg.setAttribute('height', String(CHART_HEIGHT));
  svg.setAttribute('preserveAspectRatio', 'none');
  const tallest = Math.max(1, ...bars.map((b) => b.count));
  const slot = CHART_WIDTH / bars.length;
  const gap = slot > 4 ? 1 : 0;
  bars.forEach((bar, i) => {
    // Full-height hit area so short bars still get a tooltip.
    const group = document.createElementNS(SVG_NS, 'g');
    group.dataset.bar = String(i);
    const hit = document.createElementNS(SVG_NS, 'rect');
    hit.setAttribute('class', 'dx-hit');
    hit.setAttribute('x', String(i * slot));
    hit.setAttribute('width', String(slot));
    hit.setAttribute('height', String(CHART_HEIGHT));
    const height = bar.count === 0 ? 0 : Math.max(1, (bar.count / tallest) * (CHART_HEIGHT - 2));
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', 'dx-bar');
    rect.setAttribute('x', String(i * slot + gap / 2));
    rect.setAttribute('y', String(CHART_HEIGHT - height));
    rect.setAttribute('width', String(Math.max(0.5, slot - gap)));
    rect.setAttribute('height', String(height));
    const title = document.createElementNS(SVG_NS, 'title');
    const range = bar.start === bar.end ? bar.start : `${bar.start} – ${bar.end}`;
    title.textContent =
      `${range}\n${bar.count.toLocaleString()} rows (${percent(bar.count, total)})` +
      (filterable ? '\nClick to filter to these rows' : '');
    group.append(title, hit, rect);
    svg.append(group);
  });
  const axis = el('div', 'dx-axis');
  axis.append(el('span', '', bars[0].start), el('span', '', bars[bars.length - 1].end));
  container.append(svg, axis);
  return container;
}

function topValues(column: ColumnProfile, total: number, filterable: boolean): HTMLElement {
  const container = el('div', 'dx-top');
  const shown = column.top!.slice(0, TOP_SHOWN);
  // Scaled to the most frequent value, like histogram bars; the label gives the share of rows.
  const largest = Math.max(1, ...shown.map((t) => t.count));
  for (const { value, count } of shown) {
    const row = el('div', 'dx-top-row');
    row.dataset.value = value;
    row.title =
      `${value}\n${count.toLocaleString()} rows (${percent(count, total)})` + (filterable ? '\nClick to filter to this value' : '');
    const fill = el('div', 'dx-top-fill');
    fill.style.width = `${(count / largest) * 100}%`;
    row.append(fill, el('span', 'dx-top-value', value === '' ? '(empty)' : value), el('span', 'dx-top-count', percent(count, total)));
    container.append(row);
  }
  const hidden = column.distinct - shown.length;
  if (hidden > 0) {
    const rows = total - shown.reduce((sum, t) => sum + t.count, 0);
    container.append(
      el('div', 'dx-top-more', `${hidden.toLocaleString()} more ${hidden === 1 ? 'value' : 'values'} · ${percent(rows, total)}`),
    );
  }
  return container;
}

function stat(label: string, value: string, title?: string): HTMLElement {
  const node = el('span', 'dx-stat');
  node.append(el('span', 'dx-stat-label', label), el('span', 'dx-stat-value', value));
  node.title = title ?? `${label}: ${value}`;
  return node;
}

function percent(part: number, whole: number): string {
  if (whole === 0 || part === 0) return '0%';
  const value = (part / whole) * 100;
  if (value < 0.1) return '<0.1%';
  if (value > 99.9 && part < whole) return '>99.9%';
  return `${Number(value.toFixed(1))}%`;
}
