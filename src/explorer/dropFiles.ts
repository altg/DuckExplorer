import * as vscode from 'vscode';
import type { TreeNode } from './schemaTree';

/**
 * The files in a drop: from the Explorer and other views (`text/uri-list`), or from the operating
 * system (`files`). Local files only, each once.
 */
export async function droppedFiles(dataTransfer: vscode.DataTransfer): Promise<vscode.Uri[]> {
  const files = new Map<string, vscode.Uri>();
  const add = (uri: vscode.Uri | undefined) => {
    if (uri?.scheme !== 'file') return;
    const key = process.platform === 'win32' ? uri.fsPath.toLowerCase() : uri.fsPath;
    if (!files.has(key)) files.set(key, uri);
  };
  const list = await dataTransfer.get('text/uri-list')?.asString();
  for (const line of list?.split(/\r?\n/) ?? []) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue; // comments are allowed in uri lists
    try {
      add(vscode.Uri.parse(text, true));
    } catch {
      // not a URI
    }
  }
  dataTransfer.forEach((item) => add(item.asFile()?.uri));
  return [...files.values()];
}

/** Files dropped on the Databases view: databases are attached, data files summarized. */
export class DatabasesDropController implements vscode.TreeDragAndDropController<TreeNode> {
  readonly dropMimeTypes = ['text/uri-list', 'files'];
  readonly dragMimeTypes: readonly string[] = [];

  constructor(private readonly open: (files: vscode.Uri[]) => Promise<void>) {}

  async handleDrop(_target: TreeNode | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    const files = await droppedFiles(dataTransfer);
    if (files.length && !token.isCancellationRequested) {
      await this.open(files);
    }
  }
}
