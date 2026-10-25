import * as vscode from 'vscode';
import { TextDecoder, TextEncoder } from 'util';

/**
 * `.duckbook` file format: JSON with cells and their outputs. Table outputs only ever hold the
 * first page of rows, so files stay small; scrolling further needs the cell to be re-run.
 */
interface DuckbookFile {
  version: 1;
  cells: DuckbookCell[];
}

interface DuckbookCell {
  kind: 'code' | 'markdown';
  language: string;
  source: string;
  outputs?: DuckbookOutput[];
  metadata?: Record<string, unknown>;
}

interface DuckbookOutput {
  items: { mime: string; text?: string; base64?: string }[];
  metadata?: Record<string, unknown>;
}

const TEXTUAL_MIME = /^(text\/|application\/(json|.*\+json|vnd\.code\.notebook\.(stdout|stderr|error)|javascript)$)/;

export class DuckbookSerializer implements vscode.NotebookSerializer {
  static readonly options: vscode.NotebookDocumentContentOptions = { transientOutputs: false };

  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const text = new TextDecoder().decode(content).trim();
    if (!text) {
      return new vscode.NotebookData([]);
    }
    let file: DuckbookFile;
    try {
      file = JSON.parse(text);
    } catch (err) {
      throw new Error(`Not a valid .duckbook file: ${(err as Error).message}`);
    }
    const cells = (file.cells ?? []).map((cell) => {
      const kind = cell.kind === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;
      const data = new vscode.NotebookCellData(kind, cell.source ?? '', cell.language ?? (kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'sql'));
      data.outputs = (cell.outputs ?? []).map(
        (output) =>
          new vscode.NotebookCellOutput(
            output.items.map(
              (item) =>
                new vscode.NotebookCellOutputItem(
                  item.base64 !== undefined ? Buffer.from(item.base64, 'base64') : new TextEncoder().encode(item.text ?? ''),
                  item.mime,
                ),
            ),
            output.metadata,
          ),
      );
      data.metadata = cell.metadata;
      return data;
    });
    return new vscode.NotebookData(cells);
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const file: DuckbookFile = {
      version: 1,
      cells: data.cells.map((cell) => {
        const out: DuckbookCell = {
          kind: cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code',
          language: cell.languageId,
          source: cell.value,
        };
        if (cell.outputs?.length) {
          out.outputs = cell.outputs.map((output) => ({
            items: output.items.map((item) =>
              TEXTUAL_MIME.test(item.mime)
                ? { mime: item.mime, text: new TextDecoder().decode(item.data) }
                : { mime: item.mime, base64: Buffer.from(item.data).toString('base64') },
            ),
            ...(output.metadata && Object.keys(output.metadata).length ? { metadata: output.metadata } : {}),
          }));
        }
        if (cell.metadata && Object.keys(cell.metadata).length) {
          out.metadata = cell.metadata;
        }
        return out;
      }),
    };
    return new TextEncoder().encode(JSON.stringify(file, null, 1) + '\n');
  }
}
