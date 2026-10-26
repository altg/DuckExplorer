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

export interface FilterBarHandlers {
  /** Apply this filter (undefined: none). */
  change(filter: FilterSpec | undefined): void;
  /** The bar was shown or hidden by itself (Escape, a message). */
  toggled(): void;
  /** "Edit as SQL": fold the chips into the WHERE box. */
  editAsSql(): void;
  /** "New cell": rerun the cell's query filtered, in a new cell. Absent for results of Python cells. */
  newCell?(): void;
}

/**
 * The filter above a result: a chip per condition (added from the cell and header menus or the
 * Column Explorer) and a WHERE box for any SQL condition on the result's columns. Changes go to
 * `handlers.change`; the grid applies them in the kernel and calls update() once the new rows are in.
 */
export class FilterBar {
  readonly element = el('div', 'dx-filterbar');
  private readonly chips = el('div', 'dx-chips');
  private readonly where = el('label', 'dx-where');
  /** Grows with its text, so a long condition (e.g. from "Edit as SQL") stays readable. */
  private readonly input = el('textarea', 'dx-where-input');
  private readonly editAsSql = el('button', 'dx-link', 'Edit as SQL');
  private readonly newCell = el('button', 'dx-link', 'New cell');
  private readonly clear = el('button', 'dx-link', 'Clear all');
  private readonly message = el('div', 'dx-filter-error');
  private filter: FilterSpec | undefined;
  private open = false;

  constructor(
    private readonly columns: ColumnInfo[],
    private readonly handlers: FilterBarHandlers,
  ) {
    this.input.rows = 1;
    this.input.spellcheck = false;
    this.input.placeholder = 'SQL condition on the columns, e.g. amount > 100 — Enter to apply, Shift+Enter for a new line';
    this.input.setAttribute('aria-label', 'Filter the rows with a SQL condition');
    this.input.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.input.addEventListener('input', () => {
      this.open = true; // a draft keeps the bar up even when the last filter is removed
      this.syncInput();
    });
    this.where.append(el('span', 'dx-where-label', 'WHERE'), this.input);
    this.editAsSql.title = 'Replace the filter chips with the same condition in the WHERE box, to edit it as SQL';
    this.editAsSql.addEventListener('click', () => this.handlers.editAsSql());
    this.newCell.title = "Add a SQL cell below that reruns this cell's query with the filter (and sort), and run it";
    this.newCell.addEventListener('click', () => this.handlers.newCell?.());
    this.clear.title = 'Remove every filter';
    this.clear.addEventListener('click', () => this.handlers.change(undefined));
    this.message.setAttribute('role', 'alert');
    this.element.append(this.chips, this.where, this.editAsSql, this.newCell, this.clear, this.message);
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
    this.setMessage(undefined);
    this.render();
  }

  /** An error (the kernel rejected the filter) or a warning under the bar; undefined clears it. */
  setMessage(message: string | undefined, kind: 'error' | 'warning' = 'error'): void {
    this.message.hidden = !message;
    this.message.textContent = message ?? '';
    this.message.classList.toggle('warning', kind === 'warning');
    this.where.classList.toggle('invalid', !!message && kind === 'error');
    if (message && !this.visible) {
      this.open = true;
      this.render();
      this.handlers.toggled();
    }
  }

  /** Puts text in the WHERE box as if typed (for "Edit as SQL"); update() then shows it as applied. */
  setDraft(text: string): void {
    this.input.value = text;
    this.open = true;
    this.syncInput();
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
    this.setMessage(undefined);
    this.render();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.handlers.change(withWhere(this.filter, this.input.value));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (this.isDirty()) {
        this.input.value = this.filter?.where ?? '';
        this.setMessage(undefined);
        this.syncInput();
      } else if (!this.filter) {
        this.close();
        this.handlers.toggled();
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
        remove.addEventListener('click', () => this.handlers.change(withoutCondition(this.filter, index)));
        chip.append(el('span', 'dx-chip-text', text), remove);
        return chip;
      }),
    );
    this.chips.hidden = conditions.length === 0;
    this.editAsSql.hidden = conditions.length === 0;
    this.newCell.hidden = !this.filter || !this.handlers.newCell;
    this.clear.hidden = !this.filter;
    this.syncInput();
  }

  private isDirty(): boolean {
    return this.input.value.trim() !== (this.filter?.where ?? '');
  }

  /** After the text changes: marks an unapplied draft and fits the box to the text. */
  private syncInput(): void {
    this.where.classList.toggle('dirty', this.isDirty());
    this.input.style.height = 'auto';
    if (this.input.scrollHeight) this.input.style.height = `${this.input.scrollHeight}px`;
  }
}
