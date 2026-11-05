import type { RendererContext } from 'vscode-notebook-renderer';
import type { ChartConfig, FilterSpec, RendererRequest, RendererResponse, RendererResults, SortSpec } from '../kernel/protocol';

type Reply<T> = { result: T; error?: undefined } | { result?: undefined; error: 'expired' | string };

/** Requests to the kernel through the extension host (renderer messaging), shared by every output. */
export class HostClient {
  private nextId = 1;
  private readonly waiting = new Map<number, (response: RendererResponse) => void>();

  constructor(private readonly context: RendererContext<unknown>) {
    context.onDidReceiveMessage?.((message: RendererResponse) => {
      if (message?.type === 'response') {
        this.waiting.get(message.requestId)?.(message);
        this.waiting.delete(message.requestId);
      }
    });
  }

  get available(): boolean {
    return typeof this.context.postMessage === 'function';
  }

  fetchPage(
    resultId: string,
    offset: number,
    limit: number,
    sort?: SortSpec,
    filter?: FilterSpec,
  ): Promise<Reply<RendererResults['fetchPage']>> {
    return this.request({ type: 'fetchPage', requestId: 0, resultId, offset, limit, sort, filter });
  }

  profile(resultId: string, filter?: FilterSpec): Promise<Reply<RendererResults['profileResult']>> {
    return this.request({ type: 'profileResult', requestId: 0, resultId, filter });
  }

  filterSql(resultId: string, filter: FilterSpec): Promise<Reply<RendererResults['filterSql']>> {
    return this.request({ type: 'filterSql', requestId: 0, resultId, filter });
  }

  insertFilteredCell(resultId: string, filter?: FilterSpec, sort?: SortSpec): Promise<Reply<RendererResults['insertFilteredCell']>> {
    return this.request({ type: 'insertFilteredCell', requestId: 0, resultId, filter, sort });
  }

  exportResult(resultId: string, filter?: FilterSpec, sort?: SortSpec): Promise<Reply<RendererResults['exportResult']>> {
    return this.request({ type: 'exportResult', requestId: 0, resultId, filter, sort });
  }

  chartSpec(resultId: string, chart?: Partial<ChartConfig>, filter?: FilterSpec): Promise<Reply<RendererResults['chartSpec']>> {
    return this.request({ type: 'chartSpec', requestId: 0, resultId, chart, filter });
  }

  insertChartCell(resultId: string, chart: ChartConfig, filter?: FilterSpec): Promise<Reply<RendererResults['insertChartCell']>> {
    return this.request({ type: 'insertChartCell', requestId: 0, resultId, chart, filter });
  }

  private request<T>(request: RendererRequest): Promise<Reply<T>> {
    request.requestId = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(request.requestId, (response) =>
        resolve(response.error !== undefined ? { error: response.error } : { result: response.result as T }),
      );
      this.context.postMessage!(request);
    });
  }
}
