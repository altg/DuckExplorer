import * as path from 'path';
import * as vscode from 'vscode';
import { KernelClient } from '../kernel/kernelProcess';
import { ColumnNode, DatabaseNode, RelationNode, SchemaNode, SchemaTree } from '../kernel/protocol';
import { quoteIdentifier } from '../sql/identifiers';

export type TreeNode =
  | { kind: 'database'; db: DatabaseNode; current: boolean }
  | { kind: 'schema'; db: DatabaseNode; schema: SchemaNode; current: boolean }
  | { kind: 'relation'; db: DatabaseNode; schema: SchemaNode; relation: RelationNode; current: boolean }
  | { kind: 'column'; db: DatabaseNode; schema: SchemaNode; relation: RelationNode; column: ColumnNode }
  | { kind: 'message'; text: string; icon: string };

export interface AttachedDatabase {
  path: string;
  readOnly: boolean;
}

/** Database files the user attached from the explorer, re-attached whenever the kernel starts. */
export class AttachedDatabases {
  private static readonly key = 'duckexplorer.attached';

  constructor(private readonly state: vscode.Memento) {}

  list(): AttachedDatabase[] {
    return this.state.get<AttachedDatabase[]>(AttachedDatabases.key, []);
  }

  async add(entry: AttachedDatabase): Promise<void> {
    const others = this.list().filter((db) => !samePath(db.path, entry.path));
    await this.state.update(AttachedDatabases.key, [...others, entry]);
  }

  async remove(dbPath: string): Promise<void> {
    await this.state.update(
      AttachedDatabases.key,
      this.list().filter((db) => !samePath(db.path, dbPath)),
    );
  }
}

/** The in-memory database that holds a view of each data file opened in the Databases view. */
export const FILES_DATABASE = 'files';

export interface OpenedFile {
  path: string;
  /** Its view in the `files` database. */
  name: string;
}

/** Data files the user opened in the Databases view, opened again (as the same views) whenever the kernel starts. */
export class OpenedFiles {
  private static readonly key = 'duckexplorer.files';

  constructor(private readonly state: vscode.Memento) {}

  list(): OpenedFile[] {
    return this.state.get<OpenedFile[]>(OpenedFiles.key, []);
  }

  async add(entry: OpenedFile): Promise<void> {
    const others = this.list().filter((file) => !samePath(file.path, entry.path));
    await this.state.update(OpenedFiles.key, [...others, entry]);
  }

  async remove(filePath: string): Promise<void> {
    await this.state.update(
      OpenedFiles.key,
      this.list().filter((file) => !samePath(file.path, filePath)),
    );
  }
}

/** Whether a node is in the `files` database (rather than one attached under that name). */
export function inFilesDatabase(node: { db: DatabaseNode }): boolean {
  return node.db.name === FILES_DATABASE && !node.db.path;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

export class SchemaTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private refreshTimer: NodeJS.Timeout | undefined;
  private latest: SchemaTree | undefined;

  constructor(
    private readonly kernel: KernelClient,
    private readonly attached: AttachedDatabases,
    private readonly opened: OpenedFiles,
  ) {}

  /** The last schema loaded, for completions and lookups. */
  get schema(): SchemaTree | undefined {
    return this.latest;
  }

  refresh(): void {
    clearTimeout(this.refreshTimer);
    this.emitter.fire(undefined);
  }

  /** Coalesces the refreshes triggered by cells that run back to back. */
  scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.emitter.fire(undefined), 400);
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      if (!this.kernel.isRunning && this.attached.list().length === 0 && this.opened.list().length === 0) {
        return []; // shows the welcome view
      }
      try {
        const tree = await this.kernel.request<SchemaTree>('schema');
        this.latest = tree;
        return tree.databases.map((db) => ({ kind: 'database', db, current: db.name === tree.current }));
      } catch (err) {
        return [{ kind: 'message', text: `Could not load databases: ${(err as Error).message}`, icon: 'error' }];
      }
    }
    switch (node.kind) {
      case 'database':
        return node.db.schemas.length
          ? node.db.schemas.map((schema) => ({ kind: 'schema', db: node.db, schema, current: node.current }))
          : [{ kind: 'message', text: 'No schemas', icon: 'info' }];
      case 'schema':
        return node.schema.relations.length
          ? node.schema.relations.map((relation) => ({
              kind: 'relation',
              db: node.db,
              schema: node.schema,
              relation,
              current: node.current,
            }))
          : [{ kind: 'message', text: 'No tables', icon: 'info' }];
      case 'relation':
        return node.relation.columns.map((column) => ({
          kind: 'column',
          db: node.db,
          schema: node.schema,
          relation: node.relation,
          column,
        }));
      default:
        return [];
    }
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const None = vscode.TreeItemCollapsibleState.None;
    const Collapsed = vscode.TreeItemCollapsibleState.Collapsed;
    const Expanded = vscode.TreeItemCollapsibleState.Expanded;
    switch (node.kind) {
      case 'database': {
        const { db, current } = node;
        const files = inFilesDatabase(node);
        const item = new vscode.TreeItem(db.name, current || files ? Expanded : Collapsed);
        item.id = `db:${db.name}`;
        const parts = [db.path ? path.basename(db.path) : files ? 'opened files' : 'in-memory'];
        if (db.readOnly) parts.push('read-only');
        if (current) parts.push('default');
        item.description = parts.join(' · ');
        const where = db.path
          ? `\`${db.path}\``
          : files
            ? `A view of each data file dropped here or opened from the Explorer: \`SELECT * FROM ${FILES_DATABASE}.name\``
            : 'In-memory database';
        item.tooltip = new vscode.MarkdownString(`**${db.name}**${current ? ' (default database)' : ''}\n\n${where}`);
        item.iconPath = new vscode.ThemeIcon(files ? 'files' : 'database', current ? new vscode.ThemeColor('charts.yellow') : undefined);
        item.contextValue = db.path ? 'database.attached' : 'database';
        return item;
      }
      case 'schema': {
        const item = new vscode.TreeItem(
          node.schema.name,
          (node.current || inFilesDatabase(node)) && node.schema.name === 'main' ? Expanded : Collapsed,
        );
        item.id = `db:${node.db.name}/s:${node.schema.name}`;
        item.description = `${node.schema.relations.length}`;
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.contextValue = 'schema';
        return item;
      }
      case 'relation': {
        const { relation } = node;
        // A view of an opened data file: its comment is the file's path.
        const file = inFilesDatabase(node) && relation.kind === 'view' && relation.comment ? relation.comment : undefined;
        const item = new vscode.TreeItem(relation.name, Collapsed);
        item.id = `db:${node.db.name}/s:${node.schema.name}/r:${relation.name}`;
        item.description = file
          ? path.basename(file)
          : relation.kind === 'view'
            ? 'view'
            : relation.rowEstimate != null
              ? `${relation.rowEstimate.toLocaleString()} rows`
              : undefined;
        const tooltip = new vscode.MarkdownString(
          `**${qualifiedName(node)}** — ${file ? 'view of a file' : relation.kind}, ${relation.columns.length} columns`,
        );
        if (file) {
          tooltip.appendMarkdown('\n\n');
          tooltip.appendText(file);
        } else if (relation.comment) {
          tooltip.appendMarkdown(`\n\n${relation.comment}`);
        }
        item.tooltip = tooltip;
        item.iconPath = new vscode.ThemeIcon(file ? 'file' : relation.kind === 'view' ? 'eye' : 'table');
        item.contextValue = file ? 'view.file' : relation.kind;
        // A click shows the summary; the twistie still lists the columns.
        item.command = { command: 'duckexplorer.showSummary', title: 'Show Summary', arguments: [node] };
        return item;
      }
      case 'column': {
        const { column } = node;
        const item = new vscode.TreeItem(column.name, None);
        item.id = `db:${node.db.name}/s:${node.schema.name}/r:${node.relation.name}/c:${column.name}`;
        item.description = column.type;
        item.tooltip = `${column.name} ${column.type}${column.nullable ? '' : ' NOT NULL'}`;
        item.iconPath = new vscode.ThemeIcon(columnIcon(column.type));
        item.contextValue = 'column';
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text, None);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.contextValue = 'message';
        return item;
      }
    }
  }
}

function columnIcon(type: string): string {
  const t = type.toUpperCase();
  if (/\[\]$|^LIST|^ARRAY/.test(t)) return 'symbol-array';
  if (/^(STRUCT|MAP|UNION)/.test(t)) return 'symbol-structure';
  if (/INT|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL/.test(t)) return 'symbol-number';
  if (/^(VARCHAR|TEXT|STRING|CHAR|UUID|ENUM)/.test(t)) return 'symbol-string';
  if (/^BOOL/.test(t)) return 'symbol-boolean';
  if (/DATE|TIME|INTERVAL/.test(t)) return 'calendar';
  return 'symbol-field';
}

/** Shortest name that resolves to the relation: drops the default database and the main schema. */
export function qualifiedName(node: {
  db: Pick<DatabaseNode, 'name'>;
  schema: Pick<SchemaNode, 'name'>;
  relation: Pick<RelationNode, 'name'>;
  current: boolean;
}): string {
  const parts: string[] = [];
  if (!node.current) parts.push(node.db.name);
  if (node.schema.name !== 'main' || !node.current) parts.push(node.schema.name);
  parts.push(node.relation.name);
  return parts.map(quoteIdentifier).join('.');
}
