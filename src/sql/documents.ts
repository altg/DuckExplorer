import * as path from 'path';
import * as vscode from 'vscode';
import { NOTEBOOK_TYPE } from '../kernel/protocol';
import { notebookDirectory } from '../notebook/controller';

/** The DuckDB notebook a SQL cell belongs to; undefined for a .sql file. */
export function notebookOf(document: vscode.TextDocument): vscode.NotebookDocument | undefined {
  return vscode.workspace.notebookDocuments.find(
    (notebook) => notebook.notebookType === NOTEBOOK_TYPE && notebook.getCells().some((cell) => cell.document === document),
  );
}

/** Documents with SQL from the query history, and the folder it ran in, by URI. */
const directories = new Map<string, string>();

/** SQL from the query history runs where it ran before, rather than in the workspace folder; undefined forgets it. */
export function setBaseDirectory(uri: vscode.Uri, directory: string | undefined): void {
  if (directory) directories.set(uri.toString(), directory);
  else directories.delete(uri.toString());
}

/** Relative file names in SQL resolve against the notebook's or the .sql file's folder (the kernel runs there). */
export function baseDirectory(document: vscode.TextDocument): string | undefined {
  const known = directories.get(document.uri.toString());
  if (known) {
    return known;
  }
  const notebook = notebookOf(document);
  if (notebook) {
    return notebookDirectory(notebook.uri);
  }
  return document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** The `duckexplorer.sqlFiles` setting: Run buttons, Ctrl+Enter and completions in .sql files. */
export function sqlFilesEnabled(): boolean {
  return vscode.workspace.getConfiguration('duckexplorer').get<boolean>('sqlFiles', true);
}
