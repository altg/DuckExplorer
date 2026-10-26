import { el } from './util';

export type MenuEntry = { label: string; run: () => void } | 'separator';

/**
 * A context menu inside an output. VS Code shows its own webview menu unless the contextmenu
 * event is cancelled, so callers call preventDefault() on it before show().
 */
export class ContextMenu {
  private element: HTMLElement | undefined;
  private restoreFocus: HTMLElement | undefined;
  private readonly onOutsidePointer = (event: Event) => {
    if (!this.element?.contains(event.target as Node)) this.close();
  };
  private readonly onBlur = () => this.close();

  constructor(
    private readonly root: HTMLElement,
    signal: AbortSignal,
  ) {
    signal.addEventListener('abort', () => this.close());
  }

  /** Opens at viewport coordinates (clientX/clientY); focus returns to `restoreFocus` after a choice. */
  show(x: number, y: number, entries: MenuEntry[], restoreFocus: HTMLElement): void {
    this.close();
    const menu = el('div', 'dx-menu');
    menu.setAttribute('role', 'menu');
    for (const entry of entries) {
      if (entry === 'separator') {
        if (menu.lastElementChild?.classList.contains('dx-menu-item')) menu.append(el('div', 'dx-menu-sep'));
        continue;
      }
      const item = el('button', 'dx-menu-item', entry.label);
      item.setAttribute('role', 'menuitem');
      item.tabIndex = -1;
      item.title = entry.label;
      item.addEventListener('click', () => {
        this.close(true);
        entry.run();
      });
      menu.append(item);
    }
    if (menu.lastElementChild?.classList.contains('dx-menu-sep')) menu.lastElementChild.remove();
    menu.addEventListener('keydown', (event) => this.onKeyDown(event));
    menu.addEventListener('contextmenu', (event) => event.preventDefault());

    this.element = menu;
    this.restoreFocus = restoreFocus;
    this.root.append(menu);
    this.place(menu, x, y);
    document.addEventListener('mousedown', this.onOutsidePointer, true);
    window.addEventListener('blur', this.onBlur);
    this.items()[0]?.focus({ preventScroll: true });
  }

  close(restoreFocus = false): void {
    if (!this.element) return;
    this.element.remove();
    this.element = undefined;
    this.root.style.minHeight = '';
    document.removeEventListener('mousedown', this.onOutsidePointer, true);
    window.removeEventListener('blur', this.onBlur);
    if (restoreFocus) this.restoreFocus?.focus({ preventScroll: true });
  }

  private items(): HTMLButtonElement[] {
    return Array.from(this.element?.querySelectorAll<HTMLButtonElement>('.dx-menu-item') ?? []);
  }

  /** Keeps the menu inside the output: flips it above the pointer, or grows the output to fit it. */
  private place(menu: HTMLElement, x: number, y: number): void {
    const box = this.root.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.max(0, Math.min(x - box.left, this.root.clientWidth - width - 2));
    let top = y - box.top;
    if (top + height > this.root.clientHeight) {
      if (top - height >= 0) {
        top -= height;
      } else {
        // Outputs are sized to their content, so a menu hanging out of a short result would be cut off.
        this.root.style.minHeight = `${top + height + 4}px`;
      }
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  private onKeyDown(event: KeyboardEvent): void {
    const items = this.items();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (index: number) => items[(index + items.length) % items.length]?.focus({ preventScroll: true });
    switch (event.key) {
      case 'ArrowDown':
        focus(current + 1);
        break;
      case 'ArrowUp':
        focus(current < 0 ? -1 : current - 1);
        break;
      case 'Home':
        focus(0);
        break;
      case 'End':
        focus(-1);
        break;
      case 'Escape':
      case 'Tab':
        this.close(true);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }
}
