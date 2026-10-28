import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { KernelClient, KernelRequestError } from '../kernel/kernelProcess';
import { RendererRequest, RendererResponse } from '../kernel/protocol';

/** Kernel methods a results grid may call (all served on the kernel's side thread). */
const KERNEL_METHODS = new Set<string>(['fetchPage', 'profileResult', 'filterSql'] satisfies RendererRequest['type'][]);

export type InsertFilteredCell = Extract<RendererRequest, { type: 'insertFilteredCell' }>;

export function isGridRequest(message: unknown): message is RendererRequest {
  const type = (message as RendererRequest | undefined)?.type;
  return type !== undefined && (KERNEL_METHODS.has(type) || type === 'insertFilteredCell');
}

/**
 * Answers a results grid, in a notebook output or the summary panel: kernel methods go to the kernel,
 * and `insertFilteredCell` to the caller, which knows where the new cell belongs.
 */
export async function answerGridRequest(
  kernel: KernelClient,
  message: RendererRequest,
  insertFilteredCell: (request: InsertFilteredCell) => Promise<{}>,
): Promise<RendererResponse> {
  const { type, requestId, ...params } = message;
  if (!kernel.isRunning) {
    // Outputs from a previous session (or a reopened file): don't start a kernel just to say so.
    return { type: 'response', requestId, error: 'expired' };
  }
  try {
    const result = message.type === 'insertFilteredCell' ? await insertFilteredCell(message) : await kernel.request(type, params);
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
