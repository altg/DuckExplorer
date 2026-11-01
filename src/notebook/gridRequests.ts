import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { KernelClient, KernelRequestError } from '../kernel/kernelProcess';
import { RendererRequest, RendererResponse } from '../kernel/protocol';

/** Kernel methods a results grid may call (all served on the kernel's side thread). */
const KERNEL_METHODS = new Set<string>(['fetchPage', 'profileResult', 'filterSql'] satisfies RendererRequest['type'][]);

export type InsertFilteredCell = Extract<RendererRequest, { type: 'insertFilteredCell' }>;
export type ExportResult = Extract<RendererRequest, { type: 'exportResult' }>;

/** The requests of a grid that its host answers: it knows where a query goes, and where files are. */
export interface GridHost {
  insertFilteredCell(request: InsertFilteredCell): Promise<{}>;
  /** Asks for a file and exports to it (see exportRows); says itself how it went. */
  exportResult(request: ExportResult): Promise<unknown>;
}

export function isGridRequest(message: unknown): message is RendererRequest {
  const type = (message as RendererRequest | undefined)?.type;
  return type !== undefined && (KERNEL_METHODS.has(type) || type === 'insertFilteredCell' || type === 'exportResult');
}

/**
 * Answers a results grid, in a notebook output, the summary panel or the results view: kernel methods go
 * to the kernel, and `insertFilteredCell` and `exportResult` to the grid's host.
 */
export async function answerGridRequest(kernel: KernelClient, message: RendererRequest, host: GridHost): Promise<RendererResponse> {
  const { type, requestId, ...params } = message;
  // An export says itself that its rows are gone, rather than leaving it to the grid.
  if (!kernel.isRunning && type !== 'exportResult') {
    // Outputs from a previous session (or a reopened file): don't start a kernel just to say so.
    return { type: 'response', requestId, error: 'expired' };
  }
  try {
    let result: unknown;
    if (message.type === 'insertFilteredCell') {
      result = await host.insertFilteredCell(message);
    } else if (message.type === 'exportResult') {
      await host.exportResult(message);
      result = {};
    } else {
      result = await kernel.request(type, params);
    }
    return { type: 'response', requestId, result };
  } catch (err) {
    const expired = err instanceof KernelRequestError && err.code === 'expired';
    return { type: 'response', requestId, error: expired ? 'expired' : (err as Error).message };
  }
}

/** The page of a webview that shows a results grid: `script` (a bundle in dist/) builds it. */
export function gridWebviewHtml(webview: vscode.Webview, script: vscode.Uri, title: string): string {
  const nonce = randomBytes(16).toString('base64');
  // Styles are injected by the script (the grid's stylesheet) and set on elements, so they are inline.
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
</head>
<body>
<script nonce="${nonce}" src="${webview.asWebviewUri(script)}"></script>
</body>
</html>`;
}
