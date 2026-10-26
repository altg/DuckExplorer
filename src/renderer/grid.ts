import type { Cell, FilterCondition, FilterSpec, SortSpec, TableResult } from '../kernel/protocol';
import type { HostClient } from './client';
import { ColumnExplorer } from './columns';
import { describeCondition, FilterBar, withCondition, withoutColumn, withWhere } from './filters';
import { ContextMenu, type MenuEntry } from './menu';
import { el, shortType } from './util';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 30;
const MAX_VIEWPORT_HEIGHT = 420;
const OVERSCAN_ROWS = 8;
const ROWNUM_MIN_WIDTH = 44;
// Browsers cap element heights (~33M px in Chromium); taller results scroll proportionally.
const MAX_SCROLL_HEIGHT = 8_000_000;
// Anchored at both ends: INTEGER[] is a list, not a number.
const NUMERIC_TYPE = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL|(DECIMAL|NUMERIC)(\(\d+,\s*\d+\))?)$/i;
// Types whose values can be filtered with ≥ and ≤ besides numbers.
const TEMPORAL_TYPE = /^(DATE|TIME|TIMESTAMP(_S|_MS|_NS)?|TIMESTAMP WITH TIME ZONE|TIME WITH TIME ZONE|INTERVAL)$/i;

/**
 * Virtualized results grid: renders only the visible rows and columns and fetches further
 * pages from the kernel as the user scrolls. The kernel sorts (click a header) and filters (the
 * filter bar, cell and header menus, Column Explorer bars) the stored result; the grid pages
 * through that view. The footer switches between the rows and the Column Explorer.
 */
export class ResultGrid {
  private readonly pages = new Map<number, Cell[][]>();
  private readonly inflight = new Set<number>();
  private readonly numeric: boolean[];
  private readonly ordered: boolean[];
  private readonly widths: number[];
  private offsets: number[] = [];
  private rownumWidth: number;
  private expired: boolean;
  private selected: { row: number; col: number } | undefined;
  /** The view shown: a sort and a filter applied in the kernel, and how many rows it has. */
  private sort: SortSpec | undefined;
  private filter: FilterSpec | undefined;
  private total: number;
  /** 'Sorting…' or 'Filtering…' while the kernel prepares the next view. */
  private pendingView: string | undefined;
  /** Why the last sort (or a page of the view) failed. */
  private viewError: string | undefined;
  private viewRequest = 0;
  /** Bumped whenever the loaded pages are discarded, so late responses for them are dropped. */
  private generation = 0;
  private tab: 'rows' | 'columns' = 'rows';
  private suppressClick = false;
  private frame = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private renderPending = false;

  private readonly viewport: HTMLDivElement;
  private readonly sizer: HTMLDivElement;
  private readonly header: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly footer: HTMLDivElement;
  private readonly menu: ContextMenu;
  private readonly filterBar: FilterBar | undefined;
  private readonly explorer: ColumnExplorer | undefined;

  constructor(
    element: HTMLElement,
    private readonly result: TableResult,
    private readonly client: HostClient,
    private readonly signal: AbortSignal,
  ) {
    this.pages.set(0, result.rows);
    this.total = result.rowCount;
    this.expired = !client.available && result.rowCount > result.rows.length;
    this.numeric = result.columns.map((c) => NUMERIC_TYPE.test(c.type));
    this.ordered = result.columns.map((c, i) => this.numeric[i] || TEMPORAL_TYPE.test(c.type));
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
    this.menu = new ContextMenu(root, signal);

    if (result.columns.length === 0) {
      this.viewport.remove();
    } else if (client.available) {
      if (result.rowCount > 0) {
        this.filterBar = new FilterBar(result.columns, {
          change: (filter) => void this.applyView(this.sort, filter, 'filter'),
          toggled: () => this.renderFooter(),
          editAsSql: () => void this.editAsSql(),
          // Only SQL cells bind their result to Python names; their query can be rerun filtered.
          newCell: result.boundTo ? () => void this.newCell() : undefined,
        });
        root.prepend(this.filterBar.element);
      }
      this.explorer = new ColumnExplorer(
        result,
        client,
        signal,
        (col) => this.showColumn(col),
        this.filterBar ? (condition) => this.addCondition(condition) : undefined,
      );
      this.explorer.element.hidden = true;
      this.viewport.after(this.explorer.element);
    }

    this.viewport.addEventListener(
      'scroll',
      () => {
        this.menu.close();
        this.schedule();
      },
      { passive: true },
    );
    this.viewport.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.viewport.addEventListener('click', (e) => this.onClick(e));
    this.viewport.addEventListener('contextmenu', (e) => this.onContextMenu(e));
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
      return this.total;
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
    const { rows, virtualHeight } = this.scrollModel();
    const contentHeight = HEADER_HEIGHT + Math.max(virtualHeight, rows === 0 ? ROW_HEIGHT : 0);
    this.sizer.style.width = `${this.totalWidth}px`;
    this.sizer.style.height = `${contentHeight}px`;
    // Leave room for a horizontal scrollbar so short results don't get a vertical one too.
    this.viewport.style.height = `${Math.min(contentHeight + 14, MAX_VIEWPORT_HEIGHT)}px`;
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
    const sortable = this.canSort;
    const filtered = new Map<number, string[]>();
    for (const condition of this.filter?.conditions ?? []) {
      const list = filtered.get(condition.column) ?? [];
      list.push(describeCondition(condition, this.result.columns, true));
      filtered.set(condition.column, list);
    }
    for (let col = first; col < last; col++) {
      const column = this.result.columns[col];
      const head = el('div', sortable ? 'dx-cell dx-head sortable' : 'dx-cell dx-head');
      head.dataset.col = String(col);
      head.style.width = `${this.widths[col]}px`;
      const lines = [column.name, column.type];
      const conditions = filtered.get(col);
      if (conditions) {
        head.classList.add('dx-filtered');
        lines.push(`Filtered: ${conditions.join(', ')}`);
      }
      if (sortable) lines.push('Click to sort, right-click for more');
      head.title = lines.join('\n');
      head.append(el('span', 'dx-name', column.name));
      if (conditions) head.append(funnel());
      if (this.sort?.column === col) {
        head.append(el('span', 'dx-sort', this.sort.descending ? '▼' : '▲'));
      }
      head.append(el('span', 'dx-type', shortType(column.type)));
      const handle = el('div', 'dx-resize');
      handle.dataset.col = String(col);
      head.append(handle);
      cells.push(head);
    }
    this.header.replaceChildren(...cells);
    this.header.style.width = `${this.totalWidth}px`;
  }

  private renderRows(): void {
    if (this.signal.aborted || this.result.columns.length === 0) {
      return;
    }
    this.renderHeader();
    const { rows, bodyHeight, ratio } = this.scrollModel();
    if (rows === 0) {
      this.body.replaceChildren(el('div', 'dx-empty', this.filter ? 'No rows match the filter' : 'No rows'));
      return;
    }
    const scrollTop = this.viewport.scrollTop;
    const offset = scrollTop * ratio; // scroll position in row pixels
    const shift = scrollTop - offset; // added to a row's pixel position to place it in the sizer
    const firstRow = Math.max(0, Math.floor(offset / ROW_HEIGHT) - OVERSCAN_ROWS);
    const lastRow = Math.min(rows, Math.ceil((offset + bodyHeight) / ROW_HEIGHT) + OVERSCAN_ROWS);
    const [firstCol, lastCol] = this.visibleColumns();

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
    const rows = this.filter
      ? `${this.total.toLocaleString()} of ${rowCount.toLocaleString()} rows`
      : `${rowCount.toLocaleString()} ${rowCount === 1 ? 'row' : 'rows'}`;
    const parts = [rows, `${columns.length} ${columns.length === 1 ? 'column' : 'columns'}`];
    if (elapsedMs !== undefined) parts.push(formatDuration(elapsedMs));
    const children: HTMLElement[] = [];
    if (this.explorer) {
      const tabs = el('div', 'dx-tabs');
      tabs.setAttribute('role', 'tablist');
      for (const [tab, label] of [
        ['rows', 'Rows'],
        ['columns', 'Columns'],
      ] as const) {
        const button = el('button', tab === this.tab ? 'dx-tab active' : 'dx-tab', label);
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(tab === this.tab));
        button.title = tab === 'rows' ? 'Show the rows' : 'Column Explorer: distribution, NULLs and distinct values per column';
        button.addEventListener('click', () => this.setTab(tab));
        tabs.append(button);
      }
      children.push(tabs);
    }
    if (this.filterBar && this.canFilter) {
      const group = el('div', 'dx-tabs');
      const count = (this.filter?.conditions.length ?? 0) + (this.filter?.where ? 1 : 0);
      const open = this.filterBar.visible;
      const button = el('button', open ? 'dx-tab active' : 'dx-tab', count ? `Filter · ${count}` : 'Filter');
      button.setAttribute('aria-pressed', String(open));
      button.title = 'Filter the rows: right-click a cell or header, click a bar in the Columns view, or write a WHERE condition';
      button.addEventListener('click', () => {
        this.filterBar!.toggle();
        this.renderFooter();
      });
      group.append(button);
      children.push(group);
    }
    children.push(el('span', '', parts.join(' · ')));
    if (this.pendingView) {
      children.push(el('span', 'dx-pending', this.pendingView));
    }
    if (this.sort) {
      const column = this.result.columns[this.sort.column];
      const sorted = el('span', 'dx-sorted', `Sorted by ${column.name} ${this.sort.descending ? '▼' : '▲'}`);
      const clear = el('button', 'dx-link', 'Clear');
      clear.title = 'Back to the query order';
      clear.addEventListener('click', () => this.requestSort(undefined));
      sorted.append(clear);
      children.push(sorted);
    }
    if (boundTo?.length) {
      const bound = el('span', 'dx-bound', `Python: ${boundTo.join(', ')}`);
      bound.title = 'Available as pandas DataFrames in Python cells of this notebook (all rows, unsorted and unfiltered)';
      children.push(bound);
    }
    if (this.viewError) {
      children.push(el('span', 'dx-banner', this.viewError));
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
    const generation = this.generation;
    this.inflight.add(page);
    const size = this.result.pageSize;
    const response = await this.client.fetchPage(this.result.id, page * size, size, this.sort, this.filter);
    if (this.signal.aborted || generation !== this.generation) return;
    this.inflight.delete(page);
    if (response.result) {
      this.pages.set(page, response.result.rows);
      this.schedule();
    } else if (response.error === 'expired' || (!this.sort && !this.filter)) {
      this.markExpired();
    } else {
      // The kernel served this view's first page, so this is unexpected: fall back to the query's rows.
      const message = `Could not load the rows: ${response.error}`;
      void this.applyView(undefined, undefined, 'sort').then(() => {
        this.viewError = message;
        this.renderFooter();
      });
    }
  }

  /**
   * Switches to another sort and filter once the kernel has sent the new view's first page, so the
   * current rows stay up while it works. If the kernel rejects the view, the current one stays.
   */
  private async applyView(sort: SortSpec | undefined, filter: FilterSpec | undefined, change: 'sort' | 'filter'): Promise<void> {
    const request = ++this.viewRequest;
    this.viewError = undefined;
    this.filterBar?.setMessage(undefined);
    if (!sort && !filter) {
      this.pendingView = undefined;
      this.commitView(sort, filter, this.result.rowCount, this.result.rows);
      return;
    }
    this.pendingView = change === 'sort' ? 'Sorting…' : 'Filtering…';
    this.renderFooter();
    const response = await this.client.fetchPage(this.result.id, 0, this.result.pageSize, sort, filter);
    if (this.signal.aborted || request !== this.viewRequest) return;
    this.pendingView = undefined;
    if (response.result) {
      this.commitView(sort, filter, response.result.rowCount, response.result.rows);
    } else if (response.error === 'expired') {
      this.markExpired();
    } else {
      if (change === 'sort') this.viewError = `Could not sort: ${response.error}`;
      else this.filterBar?.setMessage(response.error);
      this.renderFooter();
    }
  }

  /** Replaces the chips with the same filter written as SQL in the WHERE box. */
  private async editAsSql(): Promise<void> {
    const filter = this.filter;
    if (!filter?.conditions.length) return;
    const response = await this.client.filterSql(this.result.id, filter);
    if (this.signal.aborted || filter !== this.filter) return;
    if (!response.result) {
      if (response.error === 'expired') this.markExpired();
      else this.filterBar?.setMessage(response.error);
      return;
    }
    const { where } = response.result;
    const before = this.total;
    this.filterBar?.setDraft(where);
    await this.applyView(this.sort, withWhere(undefined, where), 'filter');
    if (this.filter?.where === where && !this.filter.conditions.length && this.total !== before) {
      this.filterBar?.setMessage(
        `This SQL keeps ${this.total.toLocaleString()} rows where the chips kept ${before.toLocaleString()}: ` +
          "values on the edge of a histogram bar can fall on the other side in SQL's comparisons.",
        'warning',
      );
    }
  }

  /** Asks the extension for a SQL cell below this result's cell that reruns its query, filtered and sorted. */
  private async newCell(): Promise<void> {
    const response = await this.client.insertFilteredCell(this.result.id, this.filter, this.sort);
    if (this.signal.aborted || response.result) return;
    if (response.error === 'expired') this.markExpired();
    else this.filterBar?.setMessage(`Could not add the cell: ${response.error}`);
  }

  private commitView(sort: SortSpec | undefined, filter: FilterSpec | undefined, total: number, firstPage: Cell[][]): void {
    const filterChanged = filter !== this.filter;
    this.sort = sort;
    this.filter = filter;
    this.total = total;
    this.resetPages(firstPage);
    if (this.selected) {
      this.selected = total > 0 ? { row: Math.min(this.selected.row, total - 1), col: this.selected.col } : undefined;
    }
    if (filterChanged) {
      this.viewport.scrollTop = 0;
      this.filterBar?.update(filter);
      this.explorer?.setFilter(filter);
    }
    this.layout();
    this.renderFooter();
  }

  /** The kernel no longer holds the result: only its first page, in query order, can be shown. */
  private markExpired(): void {
    if (this.expired) return;
    this.expired = true;
    this.pendingView = undefined;
    this.menu.close();
    this.filterBar?.close();
    if (this.sort || this.filter) {
      this.sort = undefined;
      this.filter = undefined;
      this.total = this.result.rowCount;
      this.resetPages(this.result.rows);
      this.viewport.scrollTop = 0;
      this.explorer?.setFilter(undefined);
    }
    this.layout();
    this.renderFooter();
  }

  private resetPages(firstPage: Cell[][]): void {
    this.generation++;
    this.pages.clear();
    this.inflight.clear();
    this.pages.set(0, firstPage);
  }

  // -- sorting, filtering and views ---------------------------------------------

  private get canSort(): boolean {
    return this.client.available && !this.expired && this.result.rowCount > 1;
  }

  private get canFilter(): boolean {
    return this.filterBar !== undefined && !this.expired;
  }

  /** Cycles a column through ascending, descending and the query's own order. */
  private toggleSort(col: number): void {
    const current = this.sort?.column === col ? this.sort : undefined;
    this.requestSort(!current ? { column: col, descending: false } : !current.descending ? { column: col, descending: true } : undefined);
  }

  private requestSort(sort: SortSpec | undefined): void {
    void this.applyView(sort, this.filter, 'sort');
  }

  private addCondition(condition: FilterCondition): void {
    void this.applyView(this.sort, withCondition(this.filter, condition), 'filter');
  }

  private setTab(tab: 'rows' | 'columns'): void {
    if (!this.explorer || tab === this.tab) return;
    this.tab = tab;
    this.menu.close();
    this.viewport.hidden = tab !== 'rows';
    this.explorer.element.hidden = tab !== 'columns';
    if (tab === 'columns') {
      this.explorer.show();
      this.explorer.element.focus({ preventScroll: true });
    } else {
      this.viewport.focus({ preventScroll: true });
      this.schedule();
    }
    this.renderFooter();
  }

  /** From the Column Explorer: back to the rows, with that column selected and in view. */
  private showColumn(col: number): void {
    this.setTab('rows');
    if (this.rowCount === 0) return;
    const row = this.selected?.row ?? this.firstVisibleRow();
    this.selected = { row, col };
    this.scrollIntoView(row, col);
    this.renderRows();
  }

  private firstVisibleRow(): number {
    const { ratio } = this.scrollModel();
    return Math.min(Math.max(0, this.rowCount - 1), Math.ceil((this.viewport.scrollTop * ratio) / ROW_HEIGHT));
  }

  // -- menus --------------------------------------------------------------------

  private cellMenu(row: number, col: number): MenuEntry[] {
    const values = this.rowValues(row);
    if (values === undefined) return []; // still loading
    const value = values[col];
    const entries: MenuEntry[] = [];
    if (this.canFilter) {
      const conditions: FilterCondition[] =
        value === null
          ? [
              { column: col, op: 'null' },
              { column: col, op: 'notNull' },
            ]
          : [
              { column: col, op: 'eq', value },
              { column: col, op: 'ne', value },
              ...(this.ordered[col]
                ? ([
                    { column: col, op: 'ge', value },
                    { column: col, op: 'le', value },
                  ] as const)
                : []),
            ];
      for (const condition of conditions) {
        entries.push({ label: `Filter: ${describeCondition(condition, this.result.columns)}`, run: () => this.addCondition(condition) });
      }
      entries.push('separator');
    }
    entries.push({ label: 'Copy value', run: () => void copyText(value ?? '') });
    return entries;
  }

  private headerMenu(col: number): MenuEntry[] {
    const columns = this.result.columns;
    const entries: MenuEntry[] = [];
    if (this.canSort) {
      entries.push(
        { label: 'Sort ascending', run: () => this.requestSort({ column: col, descending: false }) },
        { label: 'Sort descending', run: () => this.requestSort({ column: col, descending: true }) },
      );
      if (this.sort?.column === col) entries.push({ label: 'Clear sort', run: () => this.requestSort(undefined) });
      entries.push('separator');
    }
    if (this.canFilter) {
      for (const condition of [
        { column: col, op: 'notNull' },
        { column: col, op: 'null' },
      ] as const) {
        entries.push({ label: `Filter: ${describeCondition(condition, columns)}`, run: () => this.addCondition(condition) });
      }
      if (this.filter?.conditions.some((c) => c.column === col)) {
        entries.push({
          label: `Remove the filters on ${columns[col].name}`,
          run: () => void this.applyView(this.sort, withoutColumn(this.filter, col), 'filter'),
        });
      }
      entries.push('separator');
    }
    entries.push({ label: 'Copy column name', run: () => void copyText(columns[col].name) });
    return entries;
  }

  private onContextMenu(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const head = target.closest<HTMLElement>('.dx-head[data-col]');
    const cell = target.closest<HTMLElement>('.dx-cell[data-row]');
    let entries: MenuEntry[] = [];
    if (head) {
      entries = this.headerMenu(Number(head.dataset.col));
    } else if (cell) {
      const row = Number(cell.dataset.row);
      const col = Number(cell.dataset.col);
      this.selected = { row, col };
      this.renderRows();
      entries = this.cellMenu(row, col);
    }
    if (entries.length === 0) return; // VS Code's own menu
    event.preventDefault();
    this.menu.show(event.clientX, event.clientY, entries, this.viewport);
  }

  /** Shift+F10 or the context menu key: the menu of the selected cell. */
  private openMenuAtSelection(): void {
    if (!this.selected) return;
    const { row, col } = this.selected;
    this.scrollIntoView(row, col);
    this.renderRows();
    const cell = this.body.querySelector<HTMLElement>(`.dx-cell[data-row="${row}"][data-col="${col}"]`);
    const entries = this.cellMenu(row, col);
    if (!cell || entries.length === 0) return;
    const box = cell.getBoundingClientRect();
    this.menu.show(box.left + 8, box.bottom, entries, this.viewport);
  }

  // -- interaction --------------------------------------------------------------

  private onClick(event: MouseEvent): void {
    if (this.suppressClick) return; // the end of a column resize
    const head = (event.target as HTMLElement).closest<HTMLElement>('.dx-head[data-col]');
    if (head && this.canSort) {
      this.toggleSort(Number(head.dataset.col));
    }
  }

  private onMouseDown(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (target.classList.contains('dx-resize')) {
      this.startResize(event, Number(target.dataset.col));
      return;
    }
    const cell = target.closest<HTMLElement>('.dx-cell[data-row]');
    if (cell && event.button === 0) {
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
      // The click that follows this mouseup must not sort the column.
      this.suppressClick = true;
      setTimeout(() => (this.suppressClick = false));
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
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      this.openMenuAtSelection();
      return;
    }
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const move = moves[event.key];
    if (!move || this.rowCount === 0) return;
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

/** The mark on a filtered column's header. */
function funnel(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'dx-filter-mark');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M1.5 2h13l-5 6v5.5l-3-1.5V8z');
  svg.append(path);
  return svg;
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
