// The results grid in a webview of its own (the summary panel, the results view of .sql files)
// rather than a notebook output: its requests reach the kernel through the webview's host, as they
// do from notebook outputs through renderer messaging.
import type { RendererContext } from 'vscode-notebook-renderer';
import { HostClient } from './client';
import css from './styles.css';

const vscode = acquireVsCodeApi();
const listeners = new Set<(message: unknown) => void>();
window.addEventListener('message', (event) => listeners.forEach((listener) => listener(event.data)));

const context = {
  postMessage: (message: unknown) => vscode.postMessage(message),
  onDidReceiveMessage: (listener: (message: unknown) => void) => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  },
} as unknown as RendererContext<unknown>;

/** For the grid's requests. */
export const client = new HostClient(context);

/** Messages from the host (the grid's responses come here too). */
export function onMessage(listener: (message: unknown) => void): void {
  listeners.add(listener);
}

export function send(message: unknown): void {
  vscode.postMessage(message);
}

/** The grid's stylesheet, followed by the page's own. */
export function addStyles(pageCss: string): void {
  const style = document.createElement('style');
  style.textContent = css + pageCss;
  document.head.append(style);
}
