import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ColumnInfo,
  DatabaseNode,
  FrameInfo,
  FunctionInfo,
  FunctionSignature,
  RelationNode,
  SchemaNode,
  SchemaTree,
} from '../kernel/protocol';
import { CatalogSnapshot, SqlCatalog } from './catalog';
import { analyze, Cte, QueryShape, RelationRef, SqlContext } from './context';
import { baseDirectory, notebookOf, sqlFilesEnabled } from './documents';
import { quoteIdentifier, sameName } from './identifiers';

export const TRIGGER_CHARACTERS = ['.', ' ', '"', "'", '/', ':'];

const Kind = vscode.CompletionItemKind;

const STATEMENT_KEYWORDS = [
  'SELECT', 'FROM', 'WITH', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'CREATE TABLE', 'CREATE OR REPLACE TABLE',
  'CREATE VIEW', 'CREATE OR REPLACE VIEW', 'CREATE MACRO', 'CREATE SCHEMA', 'DROP TABLE', 'DROP VIEW',
  'ALTER TABLE', 'ATTACH', 'DETACH', 'USE', 'DESCRIBE', 'SUMMARIZE', 'SHOW TABLES', 'SHOW ALL TABLES', 'PIVOT',
  'UNPIVOT', 'COPY', 'EXPORT DATABASE', 'IMPORT DATABASE', 'INSTALL', 'LOAD', 'SET', 'RESET', 'PRAGMA', 'EXPLAIN',
  'EXPLAIN ANALYZE', 'VALUES', 'CHECKPOINT', 'BEGIN TRANSACTION', 'COMMIT', 'ROLLBACK', 'CALL',
];
const AFTER_RELATION_KEYWORDS = [
  'AS', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'ASOF JOIN', 'POSITIONAL JOIN',
  'SEMI JOIN', 'ANTI JOIN', 'NATURAL JOIN', 'ON', 'USING', 'WHERE', 'GROUP BY', 'GROUP BY ALL', 'ORDER BY',
  'ORDER BY ALL', 'HAVING', 'QUALIFY', 'LIMIT', 'UNION', 'UNION ALL', 'UNION BY NAME', 'EXCEPT', 'INTERSECT',
  'USING SAMPLE', 'SELECT', 'WINDOW', 'SET', 'VALUES', 'RETURNING',
];
const EXPRESSION_KEYWORDS = [
  'AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL', 'LIKE', 'ILIKE', 'GLOB', 'BETWEEN', 'CASE', 'WHEN', 'THEN',
  'ELSE', 'END', 'AS', 'DISTINCT', 'NULL', 'TRUE', 'FALSE', 'CAST', 'TRY_CAST', 'INTERVAL', 'EXISTS', 'OVER',
  'PARTITION BY', 'FILTER', 'FROM', 'WHERE', 'GROUP BY', 'GROUP BY ALL', 'ORDER BY', 'ORDER BY ALL', 'HAVING',
  'QUALIFY', 'LIMIT', 'OFFSET', 'ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST', 'UNION', 'UNION ALL', 'EXCEPT',
  'INTERSECT', 'EXCLUDE', 'REPLACE', 'COLUMNS', 'SELECT', 'ON', 'USING', 'WINDOW', 'COLLATE', 'ANY', 'ALL',
];
/** Callable like functions, but not in duckdb_functions(). */
const SPECIAL_FUNCTIONS: FunctionInfo[] = [
  {
    name: 'coalesce',
    kind: 'scalar',
    signatures: [{ params: [{ name: 'value', type: 'ANY' }], varargs: 'ANY' }],
    description: 'Returns the first argument that is not NULL.',
    example: "coalesce(NULL, NULL, 'default_string')",
  },
  {
    name: 'unnest',
    kind: 'scalar',
    signatures: [{ params: [{ name: 'list', type: 'ANY[]' }] }],
    description: 'Expands a list into rows, or a struct into columns.',
    example: 'unnest([1, 2, 3])',
  },
  {
    name: 'columns',
    kind: 'scalar',
    signatures: [{ params: [{ name: 'selector', type: 'VARCHAR' }] }],
    description: 'Expands to every column whose name matches a regular expression, is in a list, or passes a lambda.',
    example: "min(COLUMNS('price_.*'))",
  },
];
/** Table functions that take a file name or glob first: their snippet opens a string and lists files. */
const FILE_FUNCTION = /^(read_\w+|parquet_\w+|sniff_csv|glob|iceberg_\w+|delta_scan)$/i;
const DATA_FILE = /\.(csv|tsv|txt|parquet|json|jsonl|ndjson|xlsx|duckdb|ddb|db|arrow|feather|avro|orc|gz|zst)$/i;
const MAX_FILES = 1000;

/** SQL completions and parameter hints in DuckDB notebook cells and .sql files. */
export class SqlLanguageFeatures implements vscode.CompletionItemProvider, vscode.SignatureHelpProvider {
  constructor(private readonly catalog: SqlCatalog) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    completion: vscode.CompletionContext,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const notebook = notebookOf(document);
    if (!notebook && !sqlFilesEnabled()) {
      return undefined;
    }
    const offset = document.offsetAt(position);
    const ctx = analyze(document.getText(), offset);
    if (!wanted(ctx, completion)) {
      return undefined;
    }
    const range = {
      inserting: new vscode.Range(document.positionAt(ctx.start), position),
      replacing: new vscode.Range(document.positionAt(ctx.start), document.positionAt(ctx.end)),
    };
    if (ctx.position.kind === 'path') {
      return fileItems(baseDirectory(document), ctx.position.typed, ctx.prefix, range);
    }
    const snapshot = await this.catalog.snapshot(notebook?.uri.toString(), notebook !== undefined);
    if (token.isCancellationRequested) {
      return undefined;
    }
    const nextChar = document.getText(new vscode.Range(range.replacing.end, range.replacing.end.translate(0, 1)));
    return new Completions(ctx, snapshot, range, nextChar).build();
  }

  resolveCompletionItem(item: vscode.CompletionItem): vscode.CompletionItem {
    if (item instanceof FunctionItem && !item.documentation) {
      item.documentation = functionDocs(item.fn);
    }
    return item;
  }

  async provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.SignatureHelp | undefined> {
    const notebook = notebookOf(document);
    if (!notebook && !sqlFilesEnabled()) {
      return undefined;
    }
    const { call } = analyze(document.getText(), document.offsetAt(position));
    if (!call) {
      return undefined;
    }
    const snapshot = await this.catalog.snapshot(notebook?.uri.toString(), notebook !== undefined);
    const functions = lookupFunctions(snapshot, call.name);
    if (!functions.length) {
      return undefined;
    }
    const help = new vscode.SignatureHelp();
    help.activeSignature = -1;
    for (const fn of functions) {
      for (const sig of fn.signatures) {
        const { label, params } = formatSignature(fn, sig);
        const info = new vscode.SignatureInformation(label, signatureDocs(fn, sig));
        info.parameters = params.map((span) => new vscode.ParameterInformation(span));
        info.activeParameter = sig.varargs ? Math.min(call.argument, sig.params.length) : call.argument;
        if (help.activeSignature < 0 && (sig.varargs || call.argument < sig.params.length)) {
          help.activeSignature = help.signatures.length;
        }
        help.signatures.push(info);
      }
    }
    help.activeSignature = Math.max(help.activeSignature, 0);
    help.activeParameter = help.signatures[help.activeSignature].activeParameter ?? 0;
    return help;
  }
}

/** Trigger characters open the list only where they start a name of their own. */
function wanted(ctx: SqlContext, completion: vscode.CompletionContext): boolean {
  if (ctx.position.kind === 'none') {
    return false;
  }
  if (completion.triggerKind !== vscode.CompletionTriggerKind.TriggerCharacter) {
    return true;
  }
  switch (completion.triggerCharacter) {
    case '.':
      return ctx.qualifier.length > 0;
    case ' ':
      return (ctx.position.kind === 'relation' || ctx.position.kind === 'database') && !ctx.prefix && !ctx.qualifier.length;
    case '"':
      return ctx.quoted;
    case "'":
    case '/':
      return ctx.position.kind === 'path';
    case ':':
      return ctx.position.kind === 'type';
    default:
      return true;
  }
}

class FunctionItem extends vscode.CompletionItem {
  constructor(
    label: vscode.CompletionItemLabel,
    readonly fn: FunctionInfo,
  ) {
    super(label, Kind.Function);
  }
}

interface Column extends Partial<ColumnInfo> {
  name: string;
}

interface Located {
  db: DatabaseNode;
  schema: SchemaNode;
  relation: RelationNode;
}

/** The completion list for one request. */
class Completions {
  private readonly items: vscode.CompletionItem[] = [];
  private readonly tree: SchemaTree | undefined;
  private columnCount = 0;

  constructor(
    private readonly ctx: SqlContext,
    private readonly snapshot: CatalogSnapshot | undefined,
    private readonly range: { inserting: vscode.Range; replacing: vscode.Range },
    private readonly nextChar: string,
  ) {
    this.tree = snapshot?.schema;
  }

  build(): vscode.CompletionItem[] {
    const { position, qualifier } = this.ctx;
    switch (position.kind) {
      case 'statement':
        this.keywords(STATEMENT_KEYWORDS, '0');
        break;
      case 'relation':
        if (qualifier.length) {
          this.qualifiedRelations(qualifier);
        } else {
          this.relations();
        }
        break;
      case 'afterRelation':
        this.keywords(AFTER_RELATION_KEYWORDS, '0');
        break;
      case 'expression':
        if (qualifier.length) {
          this.qualifiedColumns(qualifier);
        } else {
          this.expression(position.afterValue);
        }
        break;
      case 'type':
        for (const type of this.snapshot?.types.length ? this.snapshot.types : ['BIGINT', 'BOOLEAN', 'DATE', 'DECIMAL', 'DOUBLE', 'INTEGER', 'TIMESTAMP', 'VARCHAR']) {
          this.add(type, Kind.TypeParameter, '0', this.ctx.upperKeywords ? type : type.toLowerCase());
        }
        break;
      case 'database':
        for (const db of this.tree?.databases ?? []) {
          if (db.name !== 'temp') {
            this.add({ label: db.name, description: db.path ? path.basename(db.path) : 'in-memory' }, Kind.Module, '0', this.name(db.name));
          }
        }
        break;
    }
    return this.items;
  }

  // -- tables ------------------------------------------------------------------------

  private relations(): void {
    const tree = this.tree;
    for (const cte of this.ctx.ctes) {
      this.add({ label: cte.name, description: 'WITH' }, Kind.Reference, '0', this.name(cte.name), { detail: 'WITH query' });
    }
    for (const frame of this.snapshot?.frames ?? []) {
      this.frameItem(frame);
    }
    if (tree) {
      // What an unqualified name reaches; the first schema on the search path wins.
      const visible = new Set<RelationNode>();
      const visibleNames = new Set<string>();
      for (const found of searchPath(tree)) {
        for (const relation of found.schema.relations) {
          if (!visibleNames.has(relation.name.toLowerCase())) {
            visible.add(relation);
            visibleNames.add(relation.name.toLowerCase());
            this.relationItem({ ...found, relation }, this.name(relation.name), '1');
          }
        }
      }
      const current = tree.databases.find((db) => db.name === tree.current);
      for (const schema of current?.schemas ?? []) {
        if (schema.name !== 'main' && schema.name !== tree.currentSchema) {
          this.namespaceItem(schema.name, 'schema', Kind.Folder);
        }
      }
      for (const db of tree.databases) {
        if (db.name !== tree.current && db.name !== 'temp') {
          this.namespaceItem(db.name, db.path ? `database · ${path.basename(db.path)}` : 'database', Kind.Module);
        }
        // Tables elsewhere, by their own name: typing `lead` finds other.sales.leads.
        for (const schema of db.schemas) {
          for (const relation of schema.relations) {
            if (!visible.has(relation)) {
              const parts = db.name === tree.current ? [schema.name] : schema.name === 'main' ? [db.name] : [db.name, schema.name];
              this.relationItem({ db, schema, relation }, [...parts, relation.name].map((p) => this.name(p)).join('.'), '3', parts.join('.'));
            }
          }
        }
      }
    }
    for (const fn of this.snapshot?.functions ?? []) {
      if (fn.kind === 'table') {
        this.functionItem(fn, '4');
      }
    }
  }

  private qualifiedRelations(qualifier: string[]): void {
    const tree = this.tree;
    if (!tree || qualifier.length > 2) {
      return;
    }
    const [first, second] = qualifier;
    const db = tree.databases.find((d) => sameName(d.name, first));
    const places: { db: DatabaseNode; schema: SchemaNode | undefined }[] = [];
    if (qualifier.length === 1) {
      // A schema of the current database, or a database: its schemas, and the tables of its main
      // schema (DuckDB reads db.table as db.main.table).
      const current = currentDatabase(tree);
      if (current) places.push({ db: current, schema: current.schemas.find((s) => sameName(s.name, first)) });
      if (db) places.push({ db, schema: db.schemas.find((s) => s.name === 'main') });
      for (const schema of db?.schemas ?? []) {
        this.namespaceItem(schema.name, 'schema', Kind.Folder, '1');
      }
    } else if (db) {
      places.push({ db, schema: db.schemas.find((s) => sameName(s.name, second)) });
    }
    for (const { db: database, schema } of places) {
      for (const relation of schema?.relations ?? []) {
        this.relationItem({ db: database, schema: schema!, relation }, this.name(relation.name), '0');
      }
    }
  }

  private relationItem({ db, schema, relation }: Located, insert: string, rank: string, where?: string): void {
    const rows = relation.rowEstimate != null ? `${relation.rowEstimate.toLocaleString()} rows` : undefined;
    const docs = new vscode.MarkdownString();
    docs.appendMarkdown(`**${db.name}.${schema.name}.${relation.name}** — ${relation.kind}`);
    if (relation.comment) docs.appendMarkdown(`\n\n${relation.comment}`);
    docs.appendCodeblock(relation.columns.slice(0, 40).map((c) => `${c.name} ${c.type}`).join('\n') + (relation.columns.length > 40 ? '\n…' : ''), 'sql');
    this.add({ label: relation.name, description: where ?? relation.kind }, relation.kind === 'view' ? Kind.Interface : Kind.Struct, rank, insert, {
      detail: [relation.kind, rows].filter(Boolean).join(' · '),
      documentation: docs,
    });
  }

  private frameItem(frame: FrameInfo): void {
    const docs = new vscode.MarkdownString('Python variable in this notebook');
    docs.appendCodeblock(frame.columns.slice(0, 40).map((c) => `${c.name} ${c.type}`).join('\n'), 'sql');
    this.add({ label: frame.name, description: 'DataFrame' }, Kind.Variable, '0', this.name(frame.name), {
      detail: `${frame.columns.length} columns`,
      documentation: docs,
    });
  }

  /** A database or schema: inserts `name.` and lists what's in it. */
  private namespaceItem(name: string, description: string, kind: vscode.CompletionItemKind, rank = '2'): void {
    this.add({ label: name, description }, kind, rank, `${this.name(name)}.`, {
      command: { command: 'editor.action.triggerSuggest', title: 'List its tables' },
    });
  }

  // -- columns, functions, keywords --------------------------------------------------

  private expression(afterValue: boolean): void {
    const { call, scope } = this.ctx;
    if (call?.atArgumentStart && call.argument > 0) {
      // read_csv('x.csv', header := true)
      for (const fn of lookupFunctions(this.snapshot, call.name).filter((f) => f.kind === 'table')) {
        const named = new Map(fn.signatures.flatMap((sig) => sig.named ?? []).map((p) => [p.name, p]));
        for (const param of named.values()) {
          this.add({ label: param.name, description: param.type }, Kind.Property, '0', `${param.name} := `, { detail: `named parameter of ${fn.name}` });
        }
      }
    }
    const resolver = new Resolver(this.snapshot, this.ctx.ctes);
    const columns = new Map<string, { column: Column; sources: string[]; outer: boolean }>();
    for (const ref of scope) {
      for (const column of resolver.columns(ref) ?? []) {
        const key = column.name.toLowerCase();
        const entry = columns.get(key);
        if (entry) {
          entry.sources.push(refLabel(ref));
          entry.outer &&= !!ref.outer;
        } else {
          columns.set(key, { column, sources: [refLabel(ref)], outer: !!ref.outer });
        }
      }
    }
    for (const { column, sources, outer } of columns.values()) {
      this.columnItem(column, sources.join(', '), outer ? '2' : '1');
    }
    for (const alias of this.ctx.selectAliases) {
      if (!columns.has(alias.toLowerCase())) {
        this.add({ label: alias, description: 'alias' }, Kind.Value, '1', this.name(alias), { detail: 'select list alias' });
      }
    }
    for (const ref of scope) {
      const name = ref.alias ?? (ref.file === undefined ? ref.parts[ref.parts.length - 1] : undefined);
      if (name && !ref.outer) {
        this.add({ label: name, description: refLabel(ref) === name ? undefined : refLabel(ref) }, Kind.Reference, '2', this.name(name));
      }
    }
    const seen = new Set<string>();
    for (const fn of [...(this.snapshot?.functions ?? []), ...SPECIAL_FUNCTIONS]) {
      if (fn.kind !== 'table' && !seen.has(fn.name)) {
        seen.add(fn.name);
        this.functionItem(fn, '3');
      }
    }
    this.keywords(EXPRESSION_KEYWORDS, afterValue ? '0' : '4');
  }

  private qualifiedColumns(qualifier: string[]): void {
    const resolver = new Resolver(this.snapshot, this.ctx.ctes);
    const refs = this.ctx.scope.filter((ref) => refMatches(ref, qualifier));
    for (const ref of refs) {
      for (const column of resolver.columns(ref) ?? []) {
        this.columnItem(column, refLabel(ref), '0');
      }
    }
    if (refs.length) {
      return;
    }
    // A struct's fields: s.field, o.s.field
    const struct = qualifier[qualifier.length - 1];
    const owners = qualifier.length > 1 ? this.ctx.scope.filter((ref) => refMatches(ref, qualifier.slice(0, -1))) : this.ctx.scope;
    for (const ref of owners) {
      const column = resolver.columns(ref)?.find((c) => sameName(c.name, struct));
      for (const field of structFields(column?.type)) {
        this.columnItem(field, `${column!.name} field`, '0');
      }
    }
  }

  /** Columns keep their table's order, as DESCRIBE lists them. */
  private columnItem(column: Column, source: string, rank: string): void {
    this.add({ label: column.name, description: column.type }, Kind.Field, rank, this.name(column.name), {
      detail: [column.type, source].filter(Boolean).join(' · '),
      sortText: rank + String(this.columnCount++).padStart(5, '0'),
    });
  }

  private functionItem(fn: FunctionInfo, rank: string): void {
    const tree = this.tree;
    const elsewhere = fn.database && tree && ![tree.current, 'temp', 'system'].includes(fn.database);
    const name = elsewhere ? `${this.name(fn.database!)}.${this.name(fn.schema!)}.${fn.name}` : fn.name;
    const first = fn.signatures[0];
    const params = first ? `(${first.params.map((p) => p.name || p.type).join(', ')}${first.varargs ? ', …' : ''})` : '()';
    const item = new FunctionItem({ label: fn.name, detail: params, description: kindLabel(fn) }, fn);
    item.sortText = rank + fn.name;
    item.range = this.range;
    if (this.nextChar === '(') {
      item.insertText = name;
    } else if (fn.kind === 'table' && FILE_FUNCTION.test(fn.name)) {
      item.insertText = new vscode.SnippetString(`${name}('$1')$0`);
      item.command = { command: 'editor.action.triggerSuggest', title: 'List files' };
    } else {
      item.insertText = new vscode.SnippetString(`${name}($0)`);
      item.command = { command: 'editor.action.triggerParameterHints', title: 'Show parameters' };
    }
    if (this.ctx.quoted) {
      item.filterText = `"${fn.name}"`;
    }
    this.items.push(item);
  }

  private keywords(words: string[], rank: string): void {
    if (this.ctx.quoted) {
      return;
    }
    for (const word of words) {
      const text = this.ctx.upperKeywords ? word : word.toLowerCase();
      this.add(text, Kind.Keyword, rank, text);
    }
  }

  // -- helpers -----------------------------------------------------------------------

  /** A name as inserted: quoted when it must be, or when the user started a quote. */
  private name(name: string): string {
    return this.ctx.quoted ? `"${name.replace(/"/g, '""')}"` : quoteIdentifier(name);
  }

  private add(
    label: string | vscode.CompletionItemLabel,
    kind: vscode.CompletionItemKind,
    rank: string,
    insert: string,
    options: { detail?: string; documentation?: vscode.MarkdownString; command?: vscode.Command; sortText?: string } = {},
  ): void {
    const item = new vscode.CompletionItem(label, kind);
    const text = typeof label === 'string' ? label : label.label;
    item.sortText = rank + text;
    item.insertText = insert;
    item.range = this.range;
    // The text typed so far (with its quote) has to match for the item to stay in the list.
    item.filterText = this.ctx.quoted ? `"${text}"` : text;
    Object.assign(item, options);
    this.items.push(item);
  }
}

/** Columns of the relations a query names, worked out from the schema, DataFrames and query text. */
class Resolver {
  constructor(
    private readonly snapshot: CatalogSnapshot | undefined,
    private readonly ctes: Cte[],
  ) {}

  columns(ref: RelationRef, ctes = this.ctes, depth = 0): Column[] | undefined {
    if (depth > 8) {
      return undefined;
    }
    let columns: Column[] | undefined;
    if (ref.query) {
      columns = this.shapeColumns(ref.query, [...ref.query.ctes, ...ctes], depth + 1);
    } else if (ref.parts.length && !ref.call) {
      const [name] = ref.parts;
      const cte = ref.parts.length === 1 ? ctes.find((c) => sameName(c.name, name)) : undefined;
      if (cte) {
        columns = this.shapeColumns(cte.query, [...cte.query.ctes, ...ctes.filter((c) => c !== cte)], depth + 1);
        if (cte.columns) columns = renamed(columns, cte.columns);
      } else {
        const frames = this.snapshot?.frames ?? [];
        const frame = ref.parts.length === 1 ? (frames.find((f) => f.name === name) ?? frames.find((f) => sameName(f.name, name))) : undefined;
        columns = frame?.columns ?? (this.snapshot && findRelation(this.snapshot.schema, ref.parts)?.relation.columns);
      }
    }
    if (ref.columnAliases) {
      columns = renamed(columns ?? [], ref.columnAliases);
    }
    return columns;
  }

  private shapeColumns(shape: QueryShape, ctes: Cte[], depth: number): Column[] {
    const columns: Column[] = [];
    for (const item of shape.items) {
      if ('star' in item) {
        const refs = item.star ? shape.from.filter((ref) => refMatches(ref, [item.star!])) : shape.from;
        for (const ref of refs) {
          columns.push(...(this.columns(ref, ctes, depth) ?? []).filter((c) => !item.exclude.some((e) => sameName(e, c.name))));
        }
      } else {
        const source = item.ref ? this.lookup(shape.from, item.ref, ctes, depth) : undefined;
        columns.push({ name: item.name, type: source?.type });
      }
    }
    return columns;
  }

  private lookup(refs: RelationRef[], parts: string[], ctes: Cte[], depth: number): Column | undefined {
    const name = parts[parts.length - 1];
    const qualifier = parts.slice(0, -1);
    for (const ref of qualifier.length ? refs.filter((r) => refMatches(r, qualifier)) : refs) {
      const column = this.columns(ref, ctes, depth)?.find((c) => sameName(c.name, name));
      if (column) {
        return column;
      }
    }
    return undefined;
  }
}

/** The first names replaced by `names`, the rest kept: `t(a, b)`, `WITH m(a, b) AS …`. */
function renamed(columns: Column[], names: string[]): Column[] {
  const result = names.map((name, i) => ({ ...columns[i], name }));
  return [...result, ...columns.slice(names.length)];
}

/** Does `alias.` or `schema.table.` name this relation? An alias hides the table's own name, as in DuckDB. */
function refMatches(ref: RelationRef, qualifier: string[]): boolean {
  if (ref.alias) {
    return qualifier.length === 1 && sameName(ref.alias, qualifier[0]);
  }
  const parts = ref.file !== undefined ? [fileStem(ref.file)] : ref.parts;
  return qualifier.length <= parts.length && qualifier.every((q, i) => sameName(q, parts[parts.length - qualifier.length + i]));
}

function refLabel(ref: RelationRef): string {
  if (ref.alias) return ref.alias;
  if (ref.file !== undefined) return fileStem(ref.file);
  return ref.parts.length ? ref.parts[ref.parts.length - 1] : 'subquery';
}

/** DuckDB names a scanned file after its base name, up to the first dot. */
function fileStem(file: string): string {
  return path.basename(file).split('.')[0];
}

function currentDatabase(tree: SchemaTree): DatabaseNode | undefined {
  return tree.databases.find((db) => db.name === tree.current);
}

/** Where DuckDB looks for an unqualified name: the current schema, the current database's main, temp. */
function searchPath(tree: SchemaTree): { db: DatabaseNode; schema: SchemaNode }[] {
  const places: [string, string][] = [
    [tree.current, tree.currentSchema],
    [tree.current, 'main'],
    ['temp', 'main'],
  ];
  return places.flatMap(([dbName, schemaName]) => {
    const db = tree.databases.find((d) => d.name === dbName);
    const schema = db?.schemas.find((s) => s.name === schemaName);
    return db && schema ? [{ db, schema }] : [];
  });
}

function findRelation(tree: SchemaTree, parts: string[]): Located | undefined {
  const find = (dbName: string, schemaName: string, name: string): Located | undefined => {
    const db = tree.databases.find((d) => sameName(d.name, dbName));
    const schema = db?.schemas.find((s) => sameName(s.name, schemaName));
    const relation = schema?.relations.find((r) => sameName(r.name, name));
    return db && schema && relation ? { db, schema, relation } : undefined;
  };
  switch (parts.length) {
    case 1:
      return searchPath(tree)
        .map(({ db, schema }) => find(db.name, schema.name, parts[0]))
        .find(Boolean);
    case 2:
      return find(tree.current, parts[0], parts[1]) ?? find(parts[0], 'main', parts[1]);
    case 3:
      return find(parts[0], parts[1], parts[2]);
    default:
      return undefined;
  }
}

/** Fields of a STRUCT(a INTEGER, "b c" VARCHAR) type. */
function structFields(type: string | undefined): Column[] {
  const match = /^STRUCT\((.*)\)$/is.exec(type ?? '');
  if (!match) {
    return [];
  }
  const fields: Column[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  const body = match[1];
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '(') depth++;
    else if (!quoted && c === ')') depth--;
    else if (i === body.length || (!quoted && depth === 0 && c === ',')) {
      const field = /^\s*("(?:[^"]|"")*"|[^\s]+)\s+(.*?)\s*$/s.exec(body.slice(start, i));
      if (field) {
        const name = field[1].startsWith('"') ? field[1].slice(1, -1).replace(/""/g, '"') : field[1];
        fields.push({ name, type: field[2] });
      }
      start = i + 1;
    }
  }
  return fields;
}

function lookupFunctions(snapshot: CatalogSnapshot | undefined, name: string): FunctionInfo[] {
  const found = snapshot?.functionsByName.get(name.toLowerCase()) ?? [];
  return found.length ? found : SPECIAL_FUNCTIONS.filter((fn) => sameName(fn.name, name));
}

function kindLabel(fn: FunctionInfo): string {
  return { scalar: 'function', aggregate: 'aggregate', macro: 'macro', table: 'table function' }[fn.kind];
}

/** `name(param TYPE, …) → TYPE`, and where each parameter is in it. */
function formatSignature(fn: FunctionInfo, sig: FunctionSignature): { label: string; params: [number, number][] } {
  let label = `${fn.name}(`;
  const params: [number, number][] = [];
  const parts = sig.params.map((p) => (p.name && p.type ? `${p.name} ${p.type}` : p.name || p.type || '?'));
  if (sig.varargs) parts.push(`${sig.varargs}…`);
  parts.forEach((part, i) => {
    if (i) label += ', ';
    params.push([label.length, label.length + part.length]);
    label += part;
  });
  label += ')';
  if (sig.returns) label += ` → ${sig.returns}`;
  return { label, params };
}

function signatureDocs(fn: FunctionInfo, sig: FunctionSignature): vscode.MarkdownString {
  const docs = new vscode.MarkdownString(fn.description ?? '');
  if (sig.named?.length) {
    docs.appendMarkdown(`\n\nNamed parameters: ${sig.named.map((p) => `\`${p.name}\``).join(', ')}`);
  }
  return docs;
}

function functionDocs(fn: FunctionInfo): vscode.MarkdownString {
  const docs = new vscode.MarkdownString();
  docs.appendCodeblock(fn.signatures.slice(0, 4).map((sig) => formatSignature(fn, sig).label).join('\n') + (fn.signatures.length > 4 ? '\n…' : ''), 'sql');
  if (fn.description) docs.appendMarkdown(fn.description);
  if (fn.example) {
    docs.appendMarkdown('\n\n');
    docs.appendCodeblock(fn.example, 'sql');
  }
  const named = fn.signatures[0]?.named;
  if (named?.length) {
    docs.appendMarkdown(`\n\nNamed parameters: ${named.map((p) => `\`${p.name}\``).join(', ')}`);
  }
  return docs;
}

/** Files and folders for a file name typed in a string, relative to the notebook's folder. */
async function fileItems(
  base: string | undefined,
  typed: string,
  name: string,
  range: { inserting: vscode.Range; replacing: vscode.Range },
): Promise<vscode.CompletionItem[] | undefined> {
  const folderPart = typed.slice(0, typed.length - name.length);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) || /[*?[{]/.test(folderPart)) {
    return undefined; // s3://, https://, globs
  }
  const expanded = folderPart.startsWith('~') ? os.homedir() + folderPart.slice(1) : folderPart;
  if (!base && !path.isAbsolute(expanded)) {
    return undefined;
  }
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path.resolve(base ?? '', expanded || '.')));
  } catch {
    return undefined;
  }
  const items: vscode.CompletionItem[] = [];
  for (const [entry, type] of entries.slice(0, MAX_FILES)) {
    if (entry.startsWith('.') && !name.startsWith('.')) {
      continue;
    }
    const folder = (type & vscode.FileType.Directory) !== 0;
    const item = new vscode.CompletionItem(folder ? `${entry}/` : entry, folder ? Kind.Folder : Kind.File);
    item.insertText = (folder ? `${entry}/` : entry).replace(/'/g, "''");
    item.sortText = (DATA_FILE.test(entry) ? '0' : folder ? '1' : '2') + entry;
    item.range = range;
    if (folder) {
      item.command = { command: 'editor.action.triggerSuggest', title: 'List files' };
    }
    items.push(item);
  }
  return items;
}
