import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { KernelClient, KernelRequestError } from '../kernel/kernelProcess';
import { ExportFormat } from '../kernel/protocol';

interface FormatItem extends vscode.QuickPickItem {
  format: ExportFormat;
  extension: string;
}

const FORMATS: FormatItem[] = [
  {
    label: 'CSV',
    description: '.csv',
    detail: 'Text with a header row, for spreadsheets and almost any tool',
    format: 'csv',
    extension: 'csv',
  },
  {
    label: 'Parquet',
    description: '.parquet',
    detail: 'Compressed and typed, for DuckDB, pandas, Spark and other data tools',
    format: 'parquet',
    extension: 'parquet',
  },
  {
    label: 'Excel',
    description: '.xlsx',
    detail: "A sheet with a header row, up to 1,048,575 rows (DuckDB's excel extension is installed the first time)",
    format: 'xlsx',
    extension: 'xlsx',
  },
];

/** What an export writes, and where its save dialog opens. */
export interface ExportSource {
  /** The format picker's title, e.g. "Export the filtered rows". */
  title: string;
  /** The file's suggested name, without its extension. */
  name: string;
  /** The folder the save dialog opens in (default: the first workspace folder). */
  folder?: string;
  /** The kernel method that writes the file, and its params besides `path` and `format`. */
  method: 'exportResult' | 'exportRelation';
  params: Record<string, unknown>;
  /** A stored result's: how to make it again once the kernel no longer holds it ("Run the cell again"). */
  rerun?: string;
}

/** A format and file chosen beforehand (by tests) instead of asking. */
export interface ExportChoice {
  format: ExportFormat;
  uri: vscode.Uri;
}

export interface Exported {
  uri: vscode.Uri;
  rowCount: number;
}

/**
 * Export in a results grid or the Databases view: asks for a format and a file, has the kernel write the
 * rows there, and says how it went (with Reveal and Open). Undefined when the user cancels or the export
 * fails. When the kernel no longer holds a result, says so before asking anything and throws the
 * 'expired' error, so that the grid shows it too.
 */
export async function exportRows(kernel: KernelClient, source: ExportSource, choice?: ExportChoice): Promise<Exported | undefined> {
  if (source.method === 'exportResult' && !(await holdsResult(kernel, String(source.params.resultId)))) {
    throw expired(source);
  }
  const chosen = choice ?? (await ask(source));
  if (!chosen) {
    return undefined;
  }
  const { format, uri } = chosen;
  const file = path.basename(uri.fsPath);
  let rowCount: number;
  try {
    ({ rowCount } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting to ${file}…` },
      () => kernel.request<{ rowCount: number }>(source.method, { ...source.params, path: uri.fsPath, format }),
    ));
  } catch (err) {
    if (err instanceof KernelRequestError && err.code === 'expired') {
      throw expired(source);
    }
    void vscode.window.showErrorMessage(`DuckExplorer: could not export to ${file}: ${(err as Error).message}`);
    return undefined;
  }
  const rows = `${rowCount.toLocaleString()} ${rowCount === 1 ? 'row' : 'rows'}`;
  void vscode.window.showInformationMessage(`DuckExplorer: exported ${rows} to ${file}.`, 'Reveal', 'Open').then((action) => {
    if (action === 'Reveal') {
      void vscode.commands.executeCommand('revealFileInOS', uri);
    } else if (action === 'Open') {
      // CSV opens as text; Parquet and Excel files in the app the system has for them.
      void (format === 'csv' ? vscode.commands.executeCommand('vscode.open', uri) : vscode.env.openExternal(uri));
    }
  });
  return { uri, rowCount };
}

async function ask(source: ExportSource): Promise<ExportChoice | undefined> {
  const item = await vscode.window.showQuickPick(FORMATS, { title: source.title, placeHolder: 'File format' });
  if (!item) {
    return undefined;
  }
  const folder = source.folder ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  const name = source.name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_') || 'export';
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(folder, `${name}.${item.extension}`)),
    filters: { [item.label]: [item.extension] },
    saveLabel: 'Export',
    title: `${source.title} to ${item.label}`,
  });
  return uri && { format: item.format, uri };
}

/** The kernel keeps only its latest results, and none from before a restart: check before asking for a file. */
async function holdsResult(kernel: KernelClient, resultId: string): Promise<boolean> {
  if (!kernel.isRunning) {
    return false; // don't start a kernel just to say so
  }
  try {
    await kernel.request('fetchPage', { resultId, offset: 0, limit: 0 });
    return true;
  } catch (err) {
    return !(err instanceof KernelRequestError && err.code === 'expired');
  }
}

function expired(source: ExportSource): KernelRequestError {
  void vscode.window.showWarningMessage(
    'DuckExplorer: the kernel no longer holds these rows (it keeps only the latest results, and none from before a restart). ' +
      `${source.rerun ?? 'Run the query again'} to export them.`,
  );
  return new KernelRequestError('Result is no longer available', 'expired');
}
