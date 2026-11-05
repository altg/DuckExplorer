import type { ChartConfig, ChartResult, FilterSpec, TableResult } from '../kernel/protocol';
import type { HostClient } from './client';
import { el } from './util';

type Mark = ChartConfig['mark'];
type Unit = ChartConfig['timeUnit'];

const MARKS: [Mark, string][] = [
  ['bar', 'Bar'],
  ['line', 'Line'],
  ['area', 'Area'],
  ['point', 'Scatter'],
];
const AGGREGATES: [ChartConfig['aggregate'], string][] = [
  ['sum', 'Sum'],
  ['mean', 'Average'],
  ['median', 'Median'],
  ['min', 'Min'],
  ['max', 'Max'],
  ['none', 'Each value'],
];
const TIME_UNITS: [Exclude<Unit, 'auto'>, string][] = [
  ['none', 'Exact time'],
  ['year', 'Year'],
  ['quarter', 'Quarter'],
  ['month', 'Month'],
  ['week', 'Week'],
  ['day', 'Day'],
  ['hour', 'Hour'],
  ['minute', 'Minute'],
];

/** "New cell" in the Chart view, and its tooltip. */
export interface ChartLink {
  label: string;
  title: string;
}

const NEW_CELL: ChartLink = { label: 'New cell', title: 'Add a Python cell that draws this chart from the query, and run it' };

/**
 * The Chart view of a result (the "Chart this" builder): bars, lines, areas or a scatter of its columns,
 * of the rows the grid's filter keeps. The kernel picks the first chart from the columns, aggregates the
 * data and writes the Vega-Lite spec; the controls change the chart. "New cell" keeps it as Python.
 */
export class ChartView {
  readonly element = el('div', 'dx-chart');
  private readonly controls = el('div', 'dx-chart-controls');
  private readonly status = el('div', 'dx-chart-status');
  private readonly plot = el('div', 'dx-chart-plot');
  private state: 'idle' | 'loading' | 'loaded' = 'idle';
  private filter: FilterSpec | undefined;
  /** The chart asked for; undefined while the kernel picks it. */
  private request: Partial<ChartConfig> | undefined;
  /** The time unit was chosen, rather than left to the kernel. */
  private unitChosen = false;
  private shown: ChartResult | undefined;
  /** Bumped by each request and filter change, so stale responses are dropped. */
  private generation = 0;
  private drawing: AbortController | undefined;

  constructor(
    private readonly result: TableResult,
    private readonly client: HostClient,
    private readonly signal: AbortSignal,
    /** Keeps the chart as a cell; resolves to an error message when it couldn't. */
    private readonly onNewCell: ((chart: ChartConfig) => Promise<string | undefined>) | undefined,
    private readonly link: ChartLink = NEW_CELL,
  ) {
    this.element.tabIndex = -1;
    this.status.setAttribute('role', 'status');
    this.element.append(this.controls, this.status, this.plot);
    signal.addEventListener('abort', () => this.drawing?.abort());
  }

  show(): void {
    if (this.state === 'idle') void this.load();
  }

  /** The grid's filter changed: the chart is drawn again for its rows (now, if the view is open). */
  setFilter(filter: FilterSpec | undefined): void {
    this.filter = filter;
    this.generation++;
    if (this.state === 'idle') return;
    this.state = 'idle';
    if (!this.element.hidden) this.show();
  }

  private change(part: Partial<ChartConfig>, unitChosen = this.unitChosen): void {
    // On top of a chart still being made, so quick changes add up.
    const base = this.state === 'loading' && this.request ? this.request : this.shown?.chart;
    if (!base) return;
    this.unitChosen = unitChosen;
    this.request = { ...base, timeUnit: unitChosen ? base.timeUnit : 'auto', ...part };
    void this.load();
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    const before = this.shown;
    this.state = 'loading';
    if (before) {
      this.element.classList.add('dx-stale'); // the last chart stays up while the next one is made
    } else {
      this.setStatus('Drawing the chart…');
    }
    const response = await this.client.chartSpec(this.result.id, this.request, this.filter);
    if (this.signal.aborted || generation !== this.generation) return;
    this.element.classList.remove('dx-stale');
    if (!response.result) {
      this.state = 'idle'; // try again the next time the view is opened
      if (response.error === 'expired') {
        this.shown = undefined;
        this.controls.replaceChildren();
        this.plot.replaceChildren();
        this.setStatus('The chart needs the query result, which the kernel no longer holds. Run the cell again.', true);
      } else {
        // The chart asked for can't be drawn: the controls go back to the last one, and say why.
        this.request = before?.chart;
        if (before) {
          this.state = 'loaded';
          this.renderControls(before);
        }
        this.setStatus(`Could not draw the chart: ${response.error}`, true);
      }
      return;
    }
    this.state = 'loaded';
    this.shown = response.result;
    this.renderControls(response.result);
    this.setStatus(response.result.note);
    this.draw(response.result.spec);
  }

  private draw(spec: Record<string, unknown>): void {
    this.drawing?.abort();
    const drawing = (this.drawing = new AbortController());
    // Drawn in place: a chart as wide as its container needs the container's width.
    const target = el('div', 'dx-vega');
    this.plot.replaceChildren(target);
    import('./vegalite')
      .then(({ renderVegaLite }) => (drawing.signal.aborted ? undefined : renderVegaLite(target, spec as never, drawing.signal)))
      .catch((err: unknown) => {
        if (!drawing.signal.aborted) this.setStatus(`Could not draw the chart: ${err instanceof Error ? err.message : String(err)}`, true);
      });
  }

  private renderControls({ chart, kinds }: ChartResult): void {
    const columns = this.result.columns.map((column, index) => ({ ...column, index, kind: kinds[index] }));
    const chartable = columns.filter((c) => c.kind !== 'other');
    const option = (c: { index: number; name: string }): [string, string] => [String(c.index), c.name];
    const focused = this.controls.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : undefined;
    const parts: HTMLElement[] = [];

    const marks = el('div', 'dx-tabs');
    marks.setAttribute('role', 'radiogroup');
    marks.setAttribute('aria-label', 'Chart type');
    for (const [mark, label] of MARKS) {
      const button = el('button', mark === chart.mark ? 'dx-tab active' : 'dx-tab', label);
      button.dataset.key = `mark-${mark}`;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(mark === chart.mark));
      button.addEventListener('click', () => {
        if (mark === chart.mark) return;
        // A scatter shows each row; from a scatter, the other charts sum.
        let aggregate = chart.aggregate;
        if (mark === 'point' && chart.y !== null) aggregate = 'none';
        else if (chart.mark === 'point' && aggregate === 'none') aggregate = 'sum';
        this.change({ mark, aggregate });
      });
      marks.append(button);
    }
    parts.push(marks);

    parts.push(
      field('X', select('x', 'X axis', chartable.map(option), String(chart.x), (value) => this.change({ x: Number(value) }, false))),
    );
    if (kinds[chart.x] === 'temporal') {
      const auto = TIME_UNITS.find(([unit]) => unit === chart.timeUnit)?.[1] ?? chart.timeUnit;
      const units = select(
        'timeUnit',
        'Time unit',
        [['auto', `Auto (${auto.toLowerCase()})`], ...TIME_UNITS],
        this.unitChosen ? chart.timeUnit : 'auto',
        (value) => this.change({ timeUnit: value as Unit }, value !== 'auto'),
      );
      if (chart.aggregate === 'none' && chart.y !== null) {
        units.disabled = true;
        units.title = 'Values that are not aggregated keep their times';
      }
      parts.push(field('by', units));
    }
    const numbers = columns.filter((c) => c.kind === 'numeric');
    const y = select('y', 'Y axis', [['', 'Count of rows'], ...numbers.map(option)], chart.y === null ? '' : String(chart.y), (value) => {
      // A scatter of a column shows each of its values.
      const each = value !== '' && chart.y === null && chart.mark === 'point';
      this.change({ y: value === '' ? null : Number(value), ...(each ? { aggregate: 'none' as const } : {}) });
    });
    parts.push(field('Y', y));
    if (chart.y !== null) {
      const aggregate = select('aggregate', 'Aggregate', AGGREGATES, chart.aggregate, (value) =>
        this.change({ aggregate: value as ChartConfig['aggregate'] }),
      );
      parts.push(field('', aggregate));
    }
    const colors = chartable.filter((c) => c.index !== chart.x);
    const color = select('color', 'Color', [['', 'None'], ...colors.map(option)], chart.color === null ? '' : String(chart.color), (value) =>
      this.change({ color: value === '' ? null : Number(value) }),
    );
    parts.push(field('Color', color));
    if (this.onNewCell) {
      const keep = el('button', 'dx-link dx-chart-keep', this.link.label);
      keep.dataset.key = 'keep';
      keep.title = this.link.title;
      keep.addEventListener('click', () => void this.keep(chart));
      parts.push(keep);
    }
    this.controls.replaceChildren(...parts);
    // Keyboard users stay on the control they changed.
    if (focused) this.controls.querySelector<HTMLElement>(`[data-key="${focused}"]`)?.focus();
  }

  private async keep(chart: ChartConfig): Promise<void> {
    this.setStatus(this.shown?.note); // not an earlier error
    const error = await this.onNewCell!(chart);
    if (error && !this.signal.aborted) this.setStatus(`Could not add the chart: ${error}`, true);
  }

  private setStatus(text: string | undefined, error = false): void {
    this.status.textContent = text ?? '';
    this.status.hidden = !text;
    this.status.classList.toggle('dx-error', error);
  }
}

function select(
  key: string,
  name: string,
  options: [string, string][],
  value: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const node = el('select', 'dx-select');
  node.dataset.key = key;
  node.setAttribute('aria-label', name);
  for (const [optionValue, text] of options) {
    const option = el('option', '', text);
    option.value = optionValue;
    node.append(option);
  }
  node.value = value;
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const node = el('label', 'dx-chart-field');
  if (label) node.append(el('span', 'dx-chart-label', label));
  node.append(control);
  return node;
}
