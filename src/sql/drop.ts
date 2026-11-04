import * as vscode from 'vscode';
import { droppedFiles } from '../explorer/dropFiles';
import { baseDirectory, notebookOf, sqlFilesEnabled } from './documents';
import { fileKind, fileStatement, pathForSql } from './files';

const QUERY = vscode.DocumentDropOrPasteEditKind.Empty.append('duckexplorer', 'query');
const PATH = vscode.DocumentDropOrPasteEditKind.Empty.append('duckexplorer', 'path');

/**
 * Data and database files dropped into a SQL cell or a .sql file (with Shift held, as VS Code asks
 * for every drop into an editor): a query of each data file and an ATTACH of each database on an
 * empty line, else their paths as SQL strings; the drop's menu offers the other. Paths are relative
 * to the folder the SQL runs in, like the paths DuckExplorer completes.
 */
export class SqlDropProvider implements vscode.DocumentDropEditProvider {
  static readonly metadata: vscode.DocumentDropEditProviderMetadata = {
    dropMimeTypes: ['text/uri-list', 'files'],
    providedDropEditKinds: [QUERY, PATH],
  };

  async provideDocumentDropEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken,
  ): Promise<vscode.DocumentDropEdit[] | undefined> {
    if (!notebookOf(document) && !sqlFilesEnabled()) {
      return undefined;
    }
    const files = (await droppedFiles(dataTransfer)).flatMap((uri) => {
      const kind = fileKind(uri.fsPath);
      return kind ? [{ uri, kind }] : [];
    });
    if (!files.length || token.isCancellationRequested) {
      return undefined; // VS Code's own drop: the file's path
    }
    const base = baseDirectory(document);
    const literals = files.map(({ uri }) => pathForSql(uri.fsPath, base, vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath));
    const one = files.length === 1;
    const query = new vscode.DocumentDropEdit(
      files.map(({ kind }, i) => fileStatement(kind, literals[i])).join('\n'),
      one ? (files[0].kind === 'database' ? 'Insert ATTACH statement' : 'Insert query') : 'Insert statements',
      QUERY,
    );
    const paths = new vscode.DocumentDropEdit(literals.join(', '), one ? 'Insert path as SQL string' : 'Insert paths as SQL strings', PATH);
    return document.lineAt(position.line).isEmptyOrWhitespace ? [query, paths] : [paths, query];
  }
}
