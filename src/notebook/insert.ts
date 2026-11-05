import * as vscode from 'vscode';
import { NOTEBOOK_TYPE } from '../kernel/protocol';

export async function openNotebookWith(source: string, language: 'sql' | 'python' = 'sql'): Promise<vscode.NotebookEditor> {
  const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, source, language);
  const document = await vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, new vscode.NotebookData([cell]));
  // The first column: the summary panel opens beside it, and must not be covered by the notebook.
  return vscode.window.showNotebookDocument(document, { viewColumn: vscode.ViewColumn.One });
}

/**
 * Adds a SQL (or Python) cell to a DuckDB notebook and runs it: the active notebook, else one that is
 * visible (beside the summary panel, say), else a new one.
 */
export async function runInNotebook(source: string, language: 'sql' | 'python' = 'sql'): Promise<void> {
  const isDuckbook = (editor: vscode.NotebookEditor | undefined) => editor?.notebook.notebookType === NOTEBOOK_TYPE;
  const active = vscode.window.activeNotebookEditor;
  let editor = isDuckbook(active) ? active : vscode.window.visibleNotebookEditors.find(isDuckbook);
  let index: number;
  if (editor) {
    index = editor.selection.isEmpty ? editor.notebook.cellCount : editor.selection.end;
    const edit = new vscode.WorkspaceEdit();
    edit.set(editor.notebook.uri, [
      vscode.NotebookEdit.insertCells(index, [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, source, language)]),
    ]);
    await vscode.workspace.applyEdit(edit);
    if (editor !== active) {
      editor = await vscode.window.showNotebookDocument(editor.notebook, { viewColumn: editor.viewColumn });
    }
  } else {
    editor = await openNotebookWith(source, language);
    index = 0;
  }
  const range = new vscode.NotebookRange(index, index + 1);
  editor.selection = range;
  editor.revealRange(range, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
  await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: index, end: index + 1 }], document: editor.notebook.uri });
}
