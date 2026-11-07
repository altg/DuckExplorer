import * as vscode from 'vscode';
import { KernelClient } from '../kernel/kernelProcess';
import { ResultsAction, ResultsMessage } from '../kernel/protocol';
import { answerGridRequest, GridHost, gridWebviewHtml, isGridRequest } from '../notebook/gridRequests';

/** The header's buttons, and the grid's "Insert query" (insertFilteredCell) and Export. */
export interface ResultsViewHandlers extends GridHost {
  cancel(): void;
  reveal(): void;
}

/**
 * The results of .sql files, in a view in the bottom panel: what ran last, and its rows in the
 * results grid. VS Code creates the view when it is first shown; until then, and while its page
 * loads, the latest message waits.
 */
export class SqlResultsView implements vscode.WebviewViewProvider {
  static readonly id = 'duckexplorer.results';
  private view: vscode.WebviewView | undefined;
  /** The last message for the page; sent again when it (re)loads. */
  private latest: ResultsMessage | undefined;
  private ready = false;
  private readonly previewParts = new vscode.EventEmitter<string | undefined>();
  /** A CTE chip of a live preview was clicked: the CTE to preview, undefined for the query's own rows. */
  readonly onDidPickPreviewPart = this.previewParts.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly kernel: KernelClient,
    private readonly handlers: ResultsViewHandlers,
  ) {}

  /** What the view shows, for tests. */
  get current(): ResultsMessage | undefined {
    return this.latest;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = gridWebviewHtml(view.webview, vscode.Uri.joinPath(dist, 'results.js'), 'DuckDB Results');
    view.webview.onDidReceiveMessage((message) => this.onMessage(view, message));
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  /** Shows `message`, revealing the view (unless `reveal` is false) without taking the focus from the editor. */
  async show(message: ResultsMessage, reveal = true): Promise<void> {
    this.latest = message;
    if (this.view && this.ready) void this.view.webview.postMessage(message);
    if (!reveal) {
      return;
    }
    if (this.view) {
      if (!this.view.visible) this.view.show(true);
    } else {
      // The first time, the view can only be opened by focusing it.
      await vscode.commands.executeCommand(`${SqlResultsView.id}.focus`);
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }
  }

  private async onMessage(view: vscode.WebviewView, message: ResultsAction | unknown): Promise<void> {
    if (isGridRequest(message)) {
      const response = await answerGridRequest(this.kernel, message, this.handlers);
      await view.webview.postMessage(response);
      return;
    }
    switch ((message as ResultsAction | undefined)?.type) {
      case 'ready':
        if (view !== this.view) break;
        this.ready = true;
        if (this.latest) void view.webview.postMessage(this.latest);
        break;
      case 'cancel':
        this.handlers.cancel();
        break;
      case 'reveal':
        this.handlers.reveal();
        break;
      case 'previewPart':
        this.previewParts.fire((message as Extract<ResultsAction, { type: 'previewPart' }>).cte);
        break;
    }
  }
}
