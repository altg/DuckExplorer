import type { RendererContext } from 'vscode-notebook-renderer';
import type { Cell, FetchPageRequest, PageResponse, TableResult } from '../kernel/protocol';

const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 30;
const MAX_VIEWPORT_HEIGHT = 420;
const OVERSCAN_ROWS = 8;
const ROWNUM_MIN_WIDTH = 44;
// Browsers cap element heights (~33M px in Chromium); taller results scroll proportionally.
const MAX_SCROLL_HEIGHT = 8_000_000;
const NUMERIC_TYPE = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC)\b/i;

/** Page requests to the extension host over renderer messaging, shared by every grid. */
export class PageClient {
  private nextId = 1;
  private readonly waiting = new Map<number, (response: PageResponse) => void>();

  constructor(private readonly context: RendererContext<unknown>) {
    context.onDidReceiveMessage?.((message: PageResponse) => {
      if (message?.type === 'page') {
        this.waiting.get(message.requestId)?.(message);
        this.waiting.delete(message.requestId);
      }
    });
  }

  get available(): boolean {
    return typeof this.context.postMessage === 'function';
  }

  fetch(resultId: string, offset: number, limit: number): Promise<PageResponse> {
    const requestId = this.nextId++;
    const request: FetchPageRequest = { type: 'fetchPage', requestId, resultId, offset, limit };
    return new Promise((resolve) => {
      this.waiting.set(requestId, resolve);
      this.context.postMessage!(request);
    });
  }
}

/**
 * Virtualized results grid: renders only the visible rows and columns and fetches further
 * pages from the kernel as the user scrolls.
 */
export class ResultGrid {
  private readonly pages = new Map<number, Cell[][]>();
  private readonly inflight = new Set<number>();
  private readonly numeric: boolean[];
  private readonly widths: number[];
  private offsets: number[] = [];
  private rownumWidth: number;
  private expired: boolean;
  private selected: { row: number; col: number } | undefined;
  private frame = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private renderPending = false;

  private readonly viewport: HTMLDivElement;
  private readonly sizer: HTMLDivElement;
  private readonly header: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly footer: HTMLDivElement;

  constructor(
    element: HTMLElement,
    private readonly result: TableResult,
    private readonly client: PageClient,
    private readonly signal: AbortSignal,
  ) {
    this.pages.set(0, result.rows);
    this.expired = !client.available && result.rowCount > result.rows.length;
    this.numeric = result.columns.map((c) => NUMERIC_TYPE.test(c.type));
    this.widths = result.columns.map((c, i) => estimateWidth(c.name, c.type, result.rows, i));
    this.rownumWidth = Math.max(ROWNUM_MIN_WIDTH, String(result.rowCount).length * 8 + 16);
    this.computeOffsets();

    const root = el('div', 'dx-result');
    this.viewport = el('div', 'dx-viewport');
    this.viewport.tabIndex = 0;
    this.sizer = el('div', 'dx-sizer');
    this.header = el('div', 'dx-header');
    this.body = el('div', 'dx-body');
    this.footer = el('div', 'dx-footer');
    this.sizer.append(this.header, this.body);
    this.viewport.append(this.sizer);
    root.append(this.viewport, this.footer);
    element.append(root);

    if (result.columns.length === 0) {
      this.viewport.remove();
    } else if (result.rowCount === 0) {
      this.body.append(el('div', 'dx-empty', 'No rows'));
    }

    const onScroll = () => this.schedule();
    this.viewport.addEventListener('scroll', onScroll, { passive: true });
    this.viewport.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.viewport.addEventListener('keydown', (e) => this.onKeyDown(e));
    const resizeObserver = new ResizeObserver(() => this.schedule());
    resizeObserver.observe(this.viewport);
    signal.addEventListener('abort', () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(this.frame);
      clearTimeout(this.timer);
    });

    this.layout();
    this.renderFooter();
  }

  // -- layout -------------------------------------------------------------------

  private get rowCount(): number {
    if (!this.expired) {
      return this.result.rowCount;
    }
    // Only the contiguous pages already loaded can be shown.
    let rows = 0;
    for (let page = 0; this.pages.has(page); page++) {
      rows += this.pages.get(page)!.length;
    }
    return rows;
  }

  private computeOffsets(): void {
    this.offsets = [];
    let x = this.rownumWidth;
    for (const width of this.widths) {
      this.offsets.push(x);
      x += width;
    }
  }

  private get totalWidth(): number {
    return this.rownumWidth + this.widths.reduce((a, b) => a + b, 0);
  }

  /**
   * Maps the viewport's scrollTop onto row pixels. `ratio` is 1 unless the rows are taller than
   * MAX_SCROLL_HEIGHT, in which case the scrollbar covers them proportionally.
   */
  private scrollModel(): { rows: number; bodyHeight: number; virtualHeight: number; ratio: number } {
    const rows = this.rowCount;
    const bodyHeight = Math.max(ROW_HEIGHT, (this.viewport.clientHeight || MAX_VIEWPORT_HEIGHT) - HEADER_HEIGHT);
    const realHeight = rows * ROW_HEIGHT;
    const virtualHeight = Math.min(realHeight, MAX_SCROLL_HEIGHT);
    const ratio = virtualHeight > bodyHeight ? (realHeight - bodyHeight) / (virtualHeight - bodyHeight) : 1;
    return { rows, bodyHeight, virtualHeight, ratio };
  }

  private layout(): void {
    const { virtualHeight } = this.scrollModel();
    const contentHeight = HEADER_HEIGHT + Math.max(virtualHeight, this.result.rowCount === 0 ? ROW_HEIGHT : 0);
    this.sizer.style.width = `${this.totalWidth}px`;
    this.sizer.style.height = `${contentHeight}px`;
    // Leave room for a horizontal scrollbar so short results don't get a vertical one too.
    this.viewport.style.height = `${Math.min(contentHeight + 14, MAX_VIEWPORT_HEIGHT)}px`;
    this.renderHeader();
    this.renderRows();
  }

  private schedule(): void {
    if (this.signal.aborted || this.renderPending) return;
    this.renderPending = true;
    const run = () => {
      if (!this.renderPending) return;
      this.renderPending = false;
      cancelAnimationFrame(this.frame);
      clearTimeout(this.timer);
      this.renderRows();
    };
    this.frame = requestAnimationFrame(run);
    // Animation frames are paused in hidden or throttled webviews; don't leave the grid stale.
    this.timer = setTimeout(run, 50);
  }

  private visibleColumns(): [number, number] {
    const left = this.viewport.scrollLeft;
    const right = left + (this.viewport.clientWidth || 800);
    let first = 0;
    while (first < this.widths.length - 1 && this.offsets[first] + this.widths[first] < left + this.rownumWidth) {
      first++;
    }
    let last = first;
    while (last < this.widths.length && this.offsets[last] < right) {
      last++;
    }
    return [first, last];
  }

  // -- rendering ----------------------------------------------------------------

  private renderHeader(): void {
    const [first, last] = this.visibleColumns();
    const cells: HTMLElement[] = [el('div', 'dx-cell dx-rownum dx-head', '#')];
    cells[0].style.width = `${this.rownumWidth}px`;
    cells.push(spacer(this.offsets[first] - this.rownumWidth));
    for (let col = first; col < last; col++) {
      const column = this.result.columns[col];
      const head = el('div', 'dx-cell dx-head');
      head.style.width = `${this.widths[col]}px`;
      head.title = `${column.name}\n${column.type}`;
      head.append(el('span', 'dx-name', column.name), el('span', 'dx-type', shortType(column.type)));
      const handle = el('div', 'dx-resize');
      handle.dataset.col = String(col);
      head.append(handle);
      cells.push(head);
    }
    this.header.replaceChildren(...cells);
    this.header.style.width = `${this.totalWidth}px`;
  }

  private renderRows(): void {
    if (this.signal.aborted || this.result.columns.length === 0 || this.result.rowCount === 0) {
      return;
    }
    const { rows, bodyHeight, ratio } = this.scrollModel();
    const scrollTop = this.viewport.scrollTop;
    const offset = scrollTop * ratio; // scroll position in row pixels
    const shift = scrollTop - offset; // added to a row's pixel position to place it in the sizer
    const firstRow = Math.max(0, Math.floor(offset / ROW_HEIGHT) - OVERSCAN_ROWS);
    const lastRow = Math.min(rows, Math.ceil((offset + bodyHeight) / ROW_HEIGHT) + OVERSCAN_ROWS);
    const [firstCol, lastCol] = this.visibleColumns();
    this.renderHeader();

    const fragment = document.createDocumentFragment();
    for (let row = firstRow; row < lastRow; row++) {
      const values = this.rowValues(row);
      const line = el('div', row % 2 ? 'dx-row odd' : 'dx-row');
      line.style.top = `${HEADER_HEIGHT + row * ROW_HEIGHT + shift}px`;
      line.style.width = `${this.totalWidth}px`;
      const rownum = el('div', 'dx-cell dx-rownum', String(row + 1));
      rownum.style.width = `${this.rownumWidth}px`;
      line.append(rownum, spacer(this.offsets[firstCol] - this.rownumWidth));
      for (let col = firstCol; col < lastCol; col++) {
        const cell = el('div', 'dx-cell');
        cell.style.width = `${this.widths[col]}px`;
        cell.dataset.row = String(row);
        cell.dataset.col = String(col);
        if (this.numeric[col]) cell.classList.add('num');
        if (this.selected?.row === row && this.selected.col === col) cell.classList.add('selected');
        if (values === undefined) {
          cell.classList.add('loading');
        } else if (values[col] === null) {
          cell.classList.add('null');
          cell.textContent = 'NULL';
        } else {
          const text = values[col] as string;
          cell.textContent = text.length > 500 ? text.slice(0, 500) + '…' : text;
          if (text.length > 20) cell.title = text.length > 2000 ? text.slice(0, 2000) + '…' : text;
        }
        line.append(cell);
      }
      fragment.append(line);
    }
    this.body.replaceChildren(fragment);
    this.ensurePages(firstRow, lastRow);
  }

  private rowValues(row: number): Cell[] | undefined {
    const size = this.result.pageSize;
    return this.pages.get(Math.floor(row / size))?.[row % size];
  }

  private renderFooter(): void {
    const { rowCount, columns, elapsedMs, boundTo } = this.result;
    const parts = [
      `${rowCount.toLocaleString()} ${rowCount === 1 ? 'row' : 'rows'}`,
      `${columns.length} ${columns.length === 1 ? 'column' : 'columns'}`,
    ];
    if (elapsedMs !== undefined) parts.push(formatDuration(elapsedMs));
    const children: HTMLElement[] = [el('span', '', parts.join(' · '))];
    if (boundTo?.length) {
      const bound = el('span', 'dx-bound', `Python: ${boundTo.join(', ')}`);
      bound.title = 'Available as pandas DataFrames in Python cells of this notebook';
      children.push(bound);
    }
    if (this.expired) {
      const shown = this.rowCount;
      children.push(
        el(
          'span',
          'dx-banner',
          `Showing the first ${shown.toLocaleString()} rows. Run the cell again to scroll through all of them.`,
        ),
      );
    }
    this.footer.replaceChildren(...children);
  }

  // -- data ---------------------------------------------------------------------

  private ensurePages(firstRow: number, lastRow: number): void {
    if (this.expired || lastRow <= firstRow) return;
    const size = this.result.pageSize;
    for (let page = Math.floor(firstRow / size); page <= Math.floor((lastRow - 1) / size); page++) {
      if (!this.pages.has(page) && !this.inflight.has(page)) {
        void this.loadPage(page);
      }
    }
  }

  private async loadPage(page: number): Promise<void> {
    this.inflight.add(page);
    const size = this.result.pageSize;
    const response = await this.client.fetch(this.result.id, page * size, size);
    this.inflight.delete(page);
    if (this.signal.aborted) return;
    if (response.rows) {
      this.pages.set(page, response.rows);
    } else if (!this.expired) {
      this.expired = true;
      this.layout();
      this.renderFooter();
      return;
    }
    this.schedule();
  }

  // -- interaction --------------------------------------------------------------

  private onMouseDown(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (target.classList.contains('dx-resize')) {
      this.startResize(event, Number(target.dataset.col));
      return;
    }
    const cell = target.closest<HTMLElement>('.dx-cell[data-row]');
    if (cell) {
      this.selected = { row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
      this.viewport.focus({ preventScroll: true });
      this.renderRows();
    }
  }

  private startResize(event: MouseEvent, col: number): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.widths[col];
    const move = (e: MouseEvent) => {
      this.widths[col] = Math.max(40, startWidth + e.clientX - startX);
      this.computeOffsets();
      this.layout();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (!this.selected) return;
    const { row, col } = this.selected;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      const value = this.rowValues(row)?.[col];
      void copyText(value ?? '');
      event.preventDefault();
      return;
    }
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const next = {
      row: clamp(row + move[0], 0, this.rowCount - 1),
      col: clamp(col + move[1], 0, this.result.columns.length - 1),
    };
    this.selected = next;
    this.scrollIntoView(next.row, next.col);
    this.renderRows();
  }

  private scrollIntoView(row: number, col: number): void {
    const v = this.viewport;
    const { bodyHeight, ratio } = this.scrollModel();
    const rowTop = row * ROW_HEIGHT;
    const offset = v.scrollTop * ratio;
    if (rowTop < offset) v.scrollTop = rowTop / ratio;
    else if (rowTop + ROW_HEIGHT > offset + bodyHeight) v.scrollTop = (rowTop + ROW_HEIGHT - bodyHeight) / ratio;
    const left = this.offsets[col] - this.rownumWidth;
    const right = this.offsets[col] + this.widths[col];
    if (left < v.scrollLeft) v.scrollLeft = left;
    else if (right > v.scrollLeft + v.clientWidth) v.scrollLeft = right - v.clientWidth;
  }
}

// -- helpers --------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function spacer(width: number): HTMLElement {
  const node = el('div', 'dx-spacer');
  node.style.width = `${Math.max(0, width)}px`;
  return node;
}

function estimateWidth(name: string, type: string, rows: Cell[][], col: number): number {
  let chars = name.length + Math.min(shortType(type).length, 12) * 0.75 + 2;
  for (let i = 0; i < Math.min(rows.length, 100); i++) {
    const value = rows[i][col];
    chars = Math.max(chars, value === null ? 4 : Math.min(value.length, 60));
  }
  return Math.round(Math.min(360, Math.max(64, chars * 7.4 + 20)));
}

function shortType(type: string): string {
  const t = type.toUpperCase();
  if (t.startsWith('STRUCT')) return 'STRUCT';
  if (t.startsWith('MAP')) return 'MAP';
  if (t.startsWith('UNION')) return 'UNION';
  if (t.endsWith(']')) return 'LIST';
  if (t.startsWith('TIMESTAMP WITH TIME ZONE')) return 'TIMESTAMPTZ';
  return t.replace(/\(.*\)$/, '');
}

function formatDuration(ms: number): string {
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}
