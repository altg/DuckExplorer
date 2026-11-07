import * as vscode from 'vscode';
import { KernelClient } from '../kernel/kernelProcess';
import { formatSql } from '../sql/format';
import { nameParts, qualifiedName, TreeNode } from './schemaTree';

export const VIEW_SQL_SCHEME = 'duckexplorer-view';

type RelationTreeNode = Extract<TreeNode, { kind: 'relation' }>;

interface ViewRef {
  database: string;
  schema: string;
  name: string;
  /** How the view is named where it's shown. */
  qualified: string;
}

/**
 * A view's SQL, from the Databases view, in a read-only editor (`<view>.sql`). DuckDB keeps a view's
 * definition normalized on one line, without the comments it was written with: it is laid out again
 * here, a clause per line.
 */
export class ViewSqlDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly registration: vscode.Disposable;

  constructor(private readonly kernel: KernelClient) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(VIEW_SQL_SCHEME, this);
  }

  dispose(): void {
    this.registration.dispose();
    this.emitter.dispose();
  }

  /** The view's document; read again from the database if it's open already, as the view may have changed. */
  async show(node: RelationTreeNode): Promise<vscode.TextEditor> {
    const uri = viewSqlUri(node);
    if (vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString())) {
      this.emitter.fire(uri);
    }
    const document = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(document, { preview: true });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const view = JSON.parse(uri.query) as ViewRef;
    try {
      const { sql } = await this.kernel.request<{ sql: string | null }>('viewSql', {
        database: view.database,
        schema: view.schema,
        name: view.name,
      });
      return sql === null
        ? `-- There is no view ${view.qualified} any more.\n`
        : `-- The view ${view.qualified} as DuckDB keeps it: normalized, without the comments it was written with.\n${formatSql(sql)}\n`;
    } catch (err) {
      return `-- Could not read the view ${view.qualified}: ${(err as Error).message.replace(/\s+/g, ' ')}\n`;
    }
  }
}

/** `duckexplorer-view:/<db>.<schema>.<view>.sql` (as short as the qualified name), with the view's identity in the query. */
export function viewSqlUri(node: RelationTreeNode): vscode.Uri {
  const view: ViewRef = { database: node.db.name, schema: node.schema.name, name: node.relation.name, qualified: qualifiedName(node) };
  const file = nameParts(node).join('.').replace(/[\\/]/g, '_');
  return vscode.Uri.from({ scheme: VIEW_SQL_SCHEME, path: `/${file}.sql`, query: JSON.stringify(view) });
}
