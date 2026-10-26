import type { ColumnInfo, FilterCondition, FilterSpec } from '../kernel/protocol';
import { el } from './util';

const MAX_VALUE_CHARS = 40;

/**
 * The filter with one more condition. A condition that pins the column to one value (= or NULL)
 * replaces the column's other conditions, and a bound (≥, ≤, a histogram bar) replaces the same bound.
 */
export function withCondition(filter: FilterSpec | undefined, condition: FilterCondition): FilterSpec {
  const conditions = (filter?.conditions ?? []).filter((old) => !replaces(condition, old));
  return normalize([...conditions, condition], filter?.where)!;
}

export function withoutCondition(filter: FilterSpec | undefined, index: number): FilterSpec | undefined {
  return normalize((filter?.conditions ?? []).filter((_, i) => i !== index), filter?.where);
}

export function withoutColumn(filter: FilterSpec | undefined, column: number): FilterSpec | undefined {
  return normalize((filter?.conditions ?? []).filter((c) => c.column !== column), filter?.where);
}

export function withWhere(filter: FilterSpec | undefined, where: string): FilterSpec | undefined {
  return normalize(filter?.conditions ?? [], where);
}

function normalize(conditions: FilterCondition[], where: string | undefined): FilterSpec | undefined {
  const text = where?.trim() ?? '';
  if (!conditions.length && !text) return undefined;
  return text ? { conditions, where: text } : { conditions };
}

function replaces(next: FilterCondition, old: FilterCondition): boolean {
  if (old.column !== next.column) return false;
  if (next.op === 'eq' || next.op === 'null' || old.op === 'eq' || old.op === 'null') return true;
  if (next.op === 'ne') return old.op === 'ne' && old.value === next.value;
  return old.op === next.op;
}

/** `status = shipped`, `amount ≥ 100`, `day in 2024-01-01 – 2024-01-19`; `full` keeps long values whole. */
export function describeCondition(condition: FilterCondition, columns: ColumnInfo[], full = false): string {
  const name = columns[condition.column]?.name ?? `column ${condition.column + 1}`;
  const show = (value: string) => (value === '' ? "''" : full ? value : shorten(value));
  switch (condition.op) {
    case 'eq':
      return `${name} = ${show(condition.value)}`;
    case 'ne':
      return `${name} ≠ ${show(condition.value)}`;
    case 'ge':
      return `${name} ≥ ${show(condition.value)}`;
    case 'le':
      return `${name} ≤ ${show(condition.value)}`;
    case 'null':
      return `${name} is NULL`;
    case 'notNull':
      return `${name} is not NULL`;
    case 'bin':
      return condition.label.includes(' – ') ? `${name} in ${condition.label}` : `${name} = ${condition.label}`;
  }
}

function shorten(value: string): string {
  return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS - 1)}…` : value;
}

/**
 * The filter above a result: a chip per condition (added from the cell and header menus or the
 * Column Explorer) and a WHERE box for any SQL condition on the result's columns. Changes go to
 * `onChange`; the grid applies them in the kernel and calls update() once the new rows are in.
 */
export class FilterBar {
  readonly element = el('div', 'dx-filterbar');
  private readonly chips = el('div', 'dx-chips');
  private readonly where = el('label', 'dx-where');
  private readonly input = el('input', 'dx-where-input');
  private readonly clear = el('button', 'dx-link', 'Clear all');
  private readonly error = el('div', 'dx-filter-error');
  private filter: FilterSpec | undefined;
  private open = false;

  constructor(
    private readonly columns: ColumnInfo[],
    private readonly onChange: (filter: FilterSpec | undefined) => void,
    private readonly onToggle: () => void,
  ) {
    this.input.type = 'text';
    this.input.spellcheck = false;
    this.input.placeholder = 'SQL condition on the columns, e.g. amount > 100 — Enter to apply';
    this.input.setAttribute('aria-label', 'Filter the rows with a SQL condition');
    this.input.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.input.addEventListener('input', () => {
      this.open = true; // a draft keeps the bar up even when the last filter is removed
      this.markDirty();
    });
    this.where.append(el('span', 'dx-where-label', 'WHERE'), this.input);
    this.clear.title = 'Remove every filter';
    this.clear.addEventListener('click', () => this.onChange(undefined));
    this.error.setAttribute('role', 'alert');
    this.element.append(this.chips, this.where, this.clear, this.error);
    this.render();
  }

  get visible(): boolean {
    return this.open || this.filter !== undefined;
  }

  /** Shows the filter the grid now applies; WHERE text being edited is kept. */
  update(filter: FilterSpec | undefined): void {
    const editing = this.isDirty();
    this.filter = filter;
    if (!editing) this.input.value = filter?.where ?? '';
    this.setError(undefined);
    this.render();
  }

  setError(message: string | undefined): void {
    this.error.hidden = !message;
    this.error.textContent = message ?? '';
    this.where.classList.toggle('invalid', !!message);
    if (message && !this.visible) {
      this.open = true;
      this.render();
      this.onToggle();
    }
  }

  /** The footer's Filter button: opens the bar on the WHERE box, or closes it while nothing is filtered. */
  toggle(): void {
    if (this.visible && !this.filter) {
      this.close();
    } else {
      this.open = true;
      this.render();
      this.input.focus();
    }
  }

  close(): void {
    this.open = false;
    this.filter = undefined;
    this.input.value = '';
    this.setError(undefined);
    this.render();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.onChange(withWhere(this.filter, this.input.value));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (this.isDirty()) {
        this.input.value = this.filter?.where ?? '';
        this.setError(undefined);
        this.markDirty();
      } else if (!this.filter) {
        this.close();
        this.onToggle();
      }
    }
  }

  private render(): void {
    this.element.hidden = !this.visible;
    const conditions = this.filter?.conditions ?? [];
    this.chips.replaceChildren(
      ...conditions.map((condition, index) => {
        const text = describeCondition(condition, this.columns);
        const chip = el('span', 'dx-chip');
        chip.title = describeCondition(condition, this.columns, true);
        const remove = el('button', 'dx-chip-remove', '×');
        remove.title = 'Remove this filter';
        remove.setAttribute('aria-label', `Remove the filter ${text}`);
        remove.addEventListener('click', () => this.onChange(withoutCondition(this.filter, index)));
        chip.append(el('span', 'dx-chip-text', text), remove);
        return chip;
      }),
    );
    this.chips.hidden = conditions.length === 0;
    this.clear.hidden = !this.filter;
    this.markDirty();
  }

  private isDirty(): boolean {
    return this.input.value.trim() !== (this.filter?.where ?? '');
  }

  private markDirty(): void {
    this.where.classList.toggle('dirty', this.isDirty());
  }
}
