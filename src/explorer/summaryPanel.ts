import * as vscode from 'vscode';
import { KernelClient } from '../kernel/kernelProcess';
import { SummaryAction, SummaryMessage, SummaryRelation, TableResult } from '../kernel/protocol';
import { answerGridRequest, gridWebviewHtml, InsertFilteredCell, isGridRequest } from '../notebook/gridRequests';
import { runInNotebook } from '../notebook/insert';

/**
 * The summary shown when a table or view is clicked in the Databases view: one editor panel beside
 * the notebook, reused for each relation, with the results grid opened on its Column Explorer. The
 * kernel loads the relation (or a sample of a large one) as a stored result, so sorting, filtering
 * and "New cell" work as they do under a notebook cell.
 */
export class TableSummaryPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private relation: SummaryRelation | undefined;
  /** The last message for the webview; sent again when it (re)loads. */
  private latest: SummaryMessage | undefined;
  private ready = false;
  private loads = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly kernel: KernelClient,
  ) {}

  /** What the panel shows, for tests. */
  get current(): SummaryMessage | undefined {
    return this.latest;
  }

  async show(relation: SummaryRelation): Promise<void> {
    this.relation = relation;
    if (this.panel) {
      this.panel.reveal(undefined, true);
    } else {
      this.panel = this.createPanel();
    }
    this.panel.title = `Summary: ${relation.name}`;
    await this.load();
  }

  /** After a kernel restart (once databases are attached again): the old rows are gone. */
  reload(): void {
    if (this.panel && this.relation) void this.load();
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private createPanel(): vscode.WebviewPanel {
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel(
      'duckexplorer.summary',
      'Summary',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist] },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'duck.svg');
    this.ready = false;
    panel.webview.html = gridWebviewHtml(panel.webview, vscode.Uri.joinPath(dist, 'summary.js'), 'Summary');
    panel.webview.onDidReceiveMessage((message) => this.onMessage(message));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.latest = undefined;
    });
    return panel;
  }

  private async load(): Promise<void> {
    const relation = this.relation!;
    const load = ++this.loads;
    this.post({ type: 'loading', relation });
    try {
      const { database, schema, name } = relation;
      const table = await this.kernel.request<TableResult>('summarize', { database, schema, name });
      if (load === this.loads) this.post({ type: 'summary', relation, table });
    } catch (err) {
      if (load === this.loads) this.post({ type: 'error', relation, message: (err as Error).message });
    }
  }

  private post(message: SummaryMessage): void {
    this.latest = message;
    if (this.ready) void this.panel?.webview.postMessage(message);
  }

  private async onMessage(message: SummaryAction | unknown): Promise<void> {
    if (isGridRequest(message)) {
      const response = await answerGridRequest(this.kernel, message, (request) => this.insertFilteredCell(request));
      await this.panel?.webview.postMessage(response);
      return;
    }
    const relation = this.relation;
    switch ((message as SummaryAction | undefined)?.type) {
      case 'ready':
        this.ready = true;
        if (this.latest) void this.panel?.webview.postMessage(this.latest);
        break;
      case 'preview':
        if (relation) await runInNotebook(`SELECT * FROM ${relation.qualified} LIMIT 100;`);
        break;
      case 'refresh':
        if (relation) await this.load();
        break;
    }
  }

  /** "New cell" in the panel's filter bar: the whole relation, filtered and sorted, in a notebook. */
  private async insertFilteredCell({ resultId, filter, sort }: InsertFilteredCell): Promise<{}> {
    const shown = this.latest?.type === 'summary' ? this.latest : undefined;
    if (shown?.table.id !== resultId) {
      throw new Error('the summary has changed since.');
    }
    const { code } = await this.kernel.request<{ code: string }>('filteredQuery', {
      resultId,
      code: `SELECT * FROM ${shown.relation.qualified}`,
      filter,
      sort,
    });
    await runInNotebook(code);
    return {};
  }
}
