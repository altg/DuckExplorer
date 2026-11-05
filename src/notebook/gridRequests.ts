import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { KernelClient, KernelRequestError } from '../kernel/kernelProcess';
import { RendererRequest, RendererResponse } from '../kernel/protocol';

/** Kernel methods a results grid may call (all served on the kernel's side thread). */
const KERNEL_METHODS = new Set<string>(['fetchPage', 'profileResult', 'filterSql', 'chartSpec'] satisfies RendererRequest['type'][]);
const HOST_METHODS = new Set<string>(['insertFilteredCell', 'insertChartCell', 'exportResult'] satisfies RendererRequest['type'][]);

export type InsertFilteredCell = Extract<RendererRequest, { type: 'insertFilteredCell' }>;
export type InsertChartCell = Extract<RendererRequest, { type: 'insertChartCell' }>;
export type ExportResult = Extract<RendererRequest, { type: 'exportResult' }>;

/** The requests of a grid that its host answers: it knows where a query goes, and where files are. */
export interface GridHost {
  insertFilteredCell(request: InsertFilteredCell): Promise<{}>;
  /** The chart as a Python cell of a notebook, run (see chartCell). */
  insertChartCell(request: InsertChartCell): Promise<{}>;
  /** Asks for a file and exports to it (see exportRows); says itself how it went. */
  exportResult(request: ExportResult): Promise<unknown>;
}

export function isGridRequest(message: unknown): message is RendererRequest {
  const type = (message as RendererRequest | undefined)?.type;
  return type !== undefined && (KERNEL_METHODS.has(type) || HOST_METHODS.has(type));
}

/**
 * The Python of a Chart view's chart (Altair, else Plotly), over `code`: the SQL that made the result.
 * The kernel rewrites it to the chart's data, filtered like the grid.
 */
export async function chartCell(kernel: KernelClient, { resultId, chart, filter }: InsertChartCell, code: string): Promise<string> {
  const reply = await kernel.request<{ code: string }>('chartCode', { resultId, code, chart, filter });
  return reply.code;
}

/**
 * Answers a results grid, in a notebook output, the summary panel or the results view: kernel methods go
 * to the kernel, and `insertFilteredCell`, `insertChartCell` and `exportResult` to the grid's host.
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
    } else if (message.type === 'insertChartCell') {
      result = await host.insertChartCell(message);
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

/** The page of a webview that shows a results grid: `script` (a module in dist/) builds it. */
export function gridWebviewHtml(webview: vscode.Webview, script: vscode.Uri, title: string): string {
  const nonce = randomBytes(16).toString('base64');
  // Styles are injected by the script (the grid's stylesheet) and set on elements, so they are inline.
  // The module imports chunks from dist/ (charts load when first drawn).
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
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
<script type="module" nonce="${nonce}" src="${webview.asWebviewUri(script)}"></script>
</body>
</html>`;
}
