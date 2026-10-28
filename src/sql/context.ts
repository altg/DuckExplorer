// Where the cursor is in a SQL cell, for completions and signature help: what kind of name goes
// there, what has been typed of it, and which tables are in scope (FROM items, CTEs, subqueries).
// A heuristic reading of the tokens rather than a parser, so that half-typed SQL still works.
// No vscode imports: shared with the unit tests.

import { RESERVED } from './identifiers';
import { nameOf, stringValue, Token, tokenize } from './tokens';

/** A table reference: in a FROM clause, or after UPDATE, INSERT INTO, PIVOT, … */
export interface RelationRef {
  /** The name as written, unquoted: ['orders'], ['demo', 'main', 'orders']; a table function's name. */
  parts: string[];
  alias?: string;
  /** `t(a, b)`: names for the relation's columns, in order. */
  columnAliases?: string[];
  /** A table function call, such as read_csv('x.csv'). */
  call?: boolean;
  /** A file scanned by name: FROM 'data/*.parquet'. */
  file?: string;
  /** A subquery's output. */
  query?: QueryShape;
  /** In a query around the cursor's (a correlated subquery), not in the cursor's own. */
  outer?: boolean;
}

/** A select list item: a named column, or `*` / `t.*` minus its EXCLUDE list. */
export type SelectItem =
  | { name: string; /** A plain column reference (`o.status`): where the column's type comes from. */ ref?: string[] }
  | { star: string | undefined; exclude: string[] };

/** The output of a query, as far as its text tells. */
export interface QueryShape {
  items: SelectItem[];
  from: RelationRef[];
  ctes: Cte[];
}

export interface Cte {
  name: string;
  columns?: string[];
  query: QueryShape;
}

export type Position =
  /** Nothing to complete: a comment, a number, or where a new name goes. */
  | { kind: 'none' }
  /** The start of a statement or subquery: SELECT, FROM, WITH, … */
  | { kind: 'statement' }
  /** A table name: after FROM, JOIN, UPDATE, … */
  | { kind: 'relation' }
  /** After a table reference in FROM: an alias, or JOIN, WHERE, … */
  | { kind: 'afterRelation' }
  /** Columns, functions, keywords. afterValue: right after an operand, where AS, AND or FROM are likelier. */
  | { kind: 'expression'; afterValue: boolean }
  /** A type: after `::`, CAST(x AS, or a column name in CREATE TABLE. */
  | { kind: 'type' }
  /** A database: after USE or DETACH. */
  | { kind: 'database' }
  /** A file name in a string literal; `typed` is the string's text up to the cursor. */
  | { kind: 'path'; typed: string };

export interface CallContext {
  /** The function's name (the last part of a qualified one). */
  name: string;
  /** The argument the cursor is in, from 0. */
  argument: number;
  /** The cursor starts an argument: right after `(` or a comma. */
  atArgumentStart: boolean;
}

export interface SqlContext {
  position: Position;
  /** What has been typed of the name at the cursor, without an opening quote. */
  prefix: string;
  /** Completions replace [start, cursor) when inserting and [start, end) when replacing. */
  start: number;
  end: number;
  /** The name at the cursor starts with a double quote. */
  quoted: boolean;
  /** Names typed before a dot: ['o'] for `o.st`, ['demo', 'main'] for `demo.main.`. */
  qualifier: string[];
  /** Relations visible at the cursor: the cursor's query first, then the queries around it. */
  scope: RelationRef[];
  /** WITH queries visible at the cursor, innermost first. */
  ctes: Cte[];
  /** Output names given in the cursor's select list (`… AS revenue`), usable in ORDER BY, WHERE, … */
  selectAliases: string[];
  call?: CallContext;
  /** Write keywords in upper case, as the cell does. */
  upperKeywords: boolean;
}

interface Range {
  from: number;
  to: number;
}

const QUERY_START = ['select', 'from', 'with', 'values', 'pivot', 'unpivot', 'summarize', 'describe'];
/** Keywords that start a clause; the last one before the cursor says where it is. */
const CLAUSES = new Set([
  'select', 'from', 'join', 'on', 'using', 'where', 'group', 'order', 'having', 'qualify', 'limit', 'offset',
  'window', 'set', 'values', 'into', 'update', 'returning', 'with', 'describe', 'summarize', 'show', 'pivot',
  'unpivot', 'copy', 'to', 'table', 'view', 'union', 'except', 'intersect', 'create', 'drop', 'alter', 'insert',
  'delete',
]);
/** A table name follows these. */
const RELATION_AFTER = ['from', 'join', 'into', 'update', 'describe', 'summarize', 'show', 'pivot', 'unpivot', 'lateral', 'copy', 'truncate'];
/** Clauses whose table reference, once written, is followed by an alias or the next clause. */
const RELATION_CLAUSES = new Set(['from', 'join', 'update', 'into', 'pivot', 'unpivot', 'describe', 'summarize', 'copy', 'table']);
const FROM_END = ['where', 'group', 'having', 'qualify', 'order', 'limit', 'offset', 'window', 'select', 'union', 'except', 'intersect', 'returning', 'set'];
const SELECT_END = ['from', 'where', 'group', 'having', 'qualify', 'order', 'limit', 'offset', 'window', 'union', 'except', 'intersect', 'into'];
/** Not reserved, but not an alias either. */
const ALIAS_STOP = ['set', 'values', 'sample'];
/** Keywords followed by `(` that isn't a function call. */
const NOT_CALLS = new Set([
  'in', 'exists', 'over', 'as', 'on', 'using', 'values', 'filter', 'exclude', 'replace', 'rename', 'within',
  'lateral', 'table', 'into', 'from', 'join', 'select', 'where', 'and', 'or', 'not', 'any', 'all', 'some', 'by',
  'then', 'else', 'when', 'case', 'is', 'to', 'with', 'lambda', 'distinct', 'group', 'order', 'having', 'qualify',
  'window', 'union', 'except', 'intersect', 'returning', 'pivot', 'unpivot', 'partition', 'key', 'check', 'unique',
]);
/** Reserved keywords that end an operand (`… END`, `… NULL`, `ORDER BY x DESC`). */
const VALUE_KEYWORDS = new Set(['end', 'null', 'true', 'false', 'asc', 'desc']);
/** Unreserved keywords that expect an operand after them. */
const OPERAND_KEYWORDS = new Set(['set', 'values', 'partition', 'filter', 'within', 'interval', 'escape', 'over', 'exists', 'between', 'recursive', 'materialized']);
/** Keywords whose case tells how the cell writes keywords. */
const STYLE_WORDS = new Set(['select', 'from', 'where', 'join', 'with', 'and', 'or', 'as', 'on', 'group', 'order', 'by', 'limit', 'insert', 'update', 'create', 'having', 'case', 'when', 'then', 'else', 'end', 'attach', 'use']);
/** Table functions whose first argument is a file name or glob. */
const FILE_FUNCTION = /^(read_\w+|parquet_\w+|sniff_csv|glob|iceberg_\w+|delta_scan)$/i;

const isWord = (t: Token | undefined, ...words: string[]): boolean =>
  t?.kind === 'word' && words.includes(t.text.toLowerCase());
const isPunct = (t: Token | undefined, ...texts: string[]): boolean => t?.kind === 'punct' && texts.includes(t.text);
const isOpenBracket = (t: Token | undefined) => isPunct(t, '(', '[', '{');
const isCloseBracket = (t: Token | undefined) => isPunct(t, ')', ']', '}');
/** An identifier: a word DuckDB allows as a bare name, or a closed quoted name. */
const isName = (t: Token | undefined): t is Token =>
  (t?.kind === 'word' && !RESERVED.has(t.text.toLowerCase())) || (t?.kind === 'quoted' && !t.open);
/** A name part after a dot, where keywords are names too. */
const isPart = (t: Token | undefined): t is Token => t?.kind === 'word' || (t?.kind === 'quoted' && !t.open);

function expectsOperand(t: Token): boolean {
  const word = t.text.toLowerCase();
  return (RESERVED.has(word) && !VALUE_KEYWORDS.has(word)) || OPERAND_KEYWORDS.has(word);
}

/** The token at `i` completes an operand, so what follows is an operator, alias or clause. */
function endsOperand(tokens: Token[], i: number): boolean {
  const t = tokens[i];
  switch (t?.kind) {
    case 'quoted':
    case 'number':
    case 'string':
      return true;
    case 'word':
      return !expectsOperand(t);
    case 'punct':
      return isCloseBracket(t) || (t.text === '*' && (i === 0 || isWord(tokens[i - 1], 'select') || isPunct(tokens[i - 1], ',', '.')));
    default:
      return false;
  }
}

/** For each bracket token, the index of its partner; -1 when it has none. */
function matchBrackets(tokens: Token[]): number[] {
  const match = tokens.map(() => -1);
  const open: number[] = [];
  tokens.forEach((t, i) => {
    if (isOpenBracket(t)) {
      open.push(i);
    } else if (isCloseBracket(t) && open.length) {
      const j = open.pop()!;
      match[i] = j;
      match[j] = i;
    }
  });
  return match;
}

export function analyze(text: string, offset: number): SqlContext {
  const all = tokenize(text);
  const tokens = all.filter((t) => t.kind !== 'comment');
  const match = matchBrackets(tokens);
  const context: SqlContext = {
    position: { kind: 'none' },
    prefix: '',
    start: offset,
    end: offset,
    quoted: false,
    qualifier: [],
    scope: [],
    ctes: [],
    selectAliases: [],
    upperKeywords: true,
  };

  // The token the cursor is in or at the end of, and what of it has been typed.
  const at = all.find((t) => t.start < offset && offset <= t.end);
  const inside = at !== undefined && (offset < at.end || !!at.open);
  if (at?.kind === 'comment' && (inside || at.text.startsWith('--'))) {
    return context;
  }
  let typing: Token | undefined;
  if (at?.kind === 'word') {
    typing = at;
    context.prefix = text.slice(at.start, offset);
    context.end = at.end;
  } else if (at?.kind === 'quoted') {
    typing = at;
    context.quoted = true;
    const typed = text.slice(at.start + 1, inside ? offset : at.end - 1);
    context.prefix = typed.replace(/""/g, '"');
    context.end = Math.max(offset, at.end);
  } else if (at?.kind === 'number' || (at?.kind === 'string' && inside)) {
    typing = at;
  }
  if (typing && typing.kind !== 'string') {
    context.start = typing.start;
  }
  context.upperKeywords = keywordStyle(all, typing?.start ?? offset, context.prefix);

  // `cursor`: the token being typed, else the first one after the cursor. `lead`: where the
  // (qualified) name being typed starts.
  let cursor = typing ? tokens.indexOf(typing) : tokens.findIndex((t) => t.start >= offset);
  if (cursor < 0) {
    cursor = tokens.length;
  }
  let lead = cursor;
  if (!typing || typing.kind === 'word' || typing.kind === 'quoted') {
    while (lead >= 2 && isPunct(tokens[lead - 1], '.') && isPart(tokens[lead - 2])) {
      context.qualifier.unshift(nameOf(tokens[lead - 2]));
      lead -= 2;
    }
  }

  // The statement around the cursor, and the brackets around the cursor in it (innermost last).
  let first = lead;
  while (first > 0 && !isPunct(tokens[first - 1], ';')) first--;
  let last = cursor;
  while (last < tokens.length && !isPunct(tokens[last], ';')) last++;
  const enclosing: number[] = [];
  for (let i = first; i < lead; i++) {
    if (isOpenBracket(tokens[i])) {
      if (match[i] > i && match[i] < lead) {
        i = match[i];
      } else {
        enclosing.push(i);
      }
    }
  }

  // The queries around the cursor, outermost (the statement) first, and the brackets inside the
  // innermost one: function arguments, lists, column lists.
  const blocks: Range[] = [{ from: first, to: last }];
  for (const p of enclosing) {
    if (isPunct(tokens[p], '(') && p + 1 < lead && isWord(tokens[p + 1], ...QUERY_START)) {
      blocks.push({ from: p + 1, to: match[p] > p ? match[p] : last });
    }
  }
  const block = blocks[blocks.length - 1];
  const brackets = enclosing.filter((p) => p >= block.from);
  const inner = brackets[brackets.length - 1];

  // The function call whose arguments the cursor is in.
  for (let k = brackets.length - 1; k >= 0; k--) {
    const p = brackets[k];
    const callee = tokens[p - 1];
    if (!isPunct(tokens[p], '(') || !(callee?.kind === 'word' ? !NOT_CALLS.has(callee.text.toLowerCase()) : isName(callee))) {
      continue;
    }
    const stop = brackets[k + 1] ?? lead;
    let argument = 0;
    for (let i = p + 1; i < stop; i++) {
      if (isOpenBracket(tokens[i]) && match[i] > i) {
        i = match[i];
      } else if (isPunct(tokens[i], ',')) {
        argument++;
      }
    }
    const atArgumentStart = stop === lead && (lead - 1 === p || isPunct(tokens[lead - 1], ','));
    context.call = { name: nameOf(callee), argument, atArgumentStart };
    break;
  }

  // The last clause keyword before the cursor, at the top level of its query.
  let clause: string | undefined;
  const scanTo = brackets[0] ?? lead;
  for (let i = block.from; i < scanTo; i++) {
    const t = tokens[i];
    if (isOpenBracket(t) && match[i] > i && match[i] < scanTo) {
      i = match[i];
    } else if (t.kind === 'word' && CLAUSES.has(t.text.toLowerCase())) {
      clause = t.text.toLowerCase();
    }
  }

  const prev = lead > first ? tokens[lead - 1] : undefined;
  const creating = first < lead && isWord(tokens[first], 'create');
  const hasWord = (from: number, to: number, ...words: string[]) => tokens.slice(from, to).some((t) => isWord(t, ...words));

  const position = (): Position => {
    if (typing?.kind === 'number') {
      return { kind: 'none' };
    }
    if (typing?.kind === 'string') {
      const before = tokens[cursor - 1];
      const fileArgument = context.call && FILE_FUNCTION.test(context.call.name) && context.call.argument === 0;
      const isPath =
        isWord(before, 'from', 'join', 'attach', 'to', 'lateral') ||
        (isPunct(before, ',') && clause === 'from' && inner === undefined) ||
        fileArgument ||
        (isWord(before, 'database') && isWord(tokens[cursor - 2], 'export', 'import'));
      if (!isPath || !typing.text.startsWith("'")) {
        return { kind: 'none' };
      }
      const typed = text.slice(typing.start + 1, offset).replace(/''/g, "'");
      const name = typed.slice(Math.max(typed.lastIndexOf('/'), typed.lastIndexOf('\\')) + 1);
      context.prefix = name;
      context.start = offset - name.length;
      const stringEnd = typing.open ? typing.end : typing.end - 1;
      let end = offset;
      while (end < stringEnd && !"/\\'".includes(text[end])) end++;
      context.end = end;
      return { kind: 'path', typed };
    }
    if (!prev) {
      return context.qualifier.length ? { kind: 'none' } : { kind: 'statement' };
    }
    if (isPunct(prev, '::')) {
      return { kind: 'type' };
    }
    if (inner !== undefined) {
      if (isWord(prev, 'as') && /^(try_)?cast$/i.test(context.call?.name ?? '')) {
        return { kind: 'type' };
      }
      if (lead - 1 === inner && isPunct(prev, '(') && isWord(tokens[inner - 1], 'from', 'join', 'lateral', 'exists', 'as')) {
        return { kind: 'statement' };
      }
      if (creating && inner === brackets[0] && !hasWord(first, inner, 'as', 'select')) {
        // CREATE TABLE t (name TYPE, …): a type follows a column name.
        return isName(prev) && isPunct(tokens[lead - 2], '(', ',') ? { kind: 'type' } : { kind: 'none' };
      }
      return { kind: 'expression', afterValue: endsOperand(tokens, lead - 1) };
    }
    if (isWord(prev, ...RELATION_AFTER)) {
      return { kind: 'relation' };
    }
    if (isWord(prev, 'table', 'view')) {
      return creating ? { kind: 'none' } : { kind: 'relation' };
    }
    if (isWord(prev, 'use', 'detach')) {
      return { kind: 'database' };
    }
    if (isPunct(prev, ',') && clause === 'from') {
      return { kind: 'relation' };
    }
    if (isWord(prev, 'as')) {
      // CREATE TABLE t AS SELECT …
      return creating && (clause === 'create' || clause === 'table' || clause === 'view') ? { kind: 'statement' } : { kind: 'none' };
    }
    if (clause === 'with' || clause === 'create' || clause === 'view') {
      return { kind: 'none' };
    }
    if (clause && RELATION_CLAUSES.has(clause) && (prev.kind === 'string' || isCloseBracket(prev) || isName(prev))) {
      return { kind: 'afterRelation' };
    }
    return { kind: 'expression', afterValue: endsOperand(tokens, lead - 1) };
  };
  context.position = position();

  // Relations and CTEs visible at the cursor, from the innermost query outwards.
  for (let level = blocks.length - 1; level >= 0; level--) {
    const range = blocks[level];
    const innermost = level === blocks.length - 1;
    const { ctes, body } = parseWith(tokens, match, range, 0);
    context.ctes.push(...ctes);
    const at = innermost ? lead : blocks[level + 1].from;
    if (at < body) {
      continue; // in a WITH query: the main query's tables aren't visible there
    }
    const shape = parseCore(tokens, match, coreRange(tokens, match, { from: body, to: range.to }, at), 0);
    if (innermost) {
      context.scope.push(...shape.from);
      context.selectAliases = shape.items.flatMap((item) => ('name' in item && !item.ref ? [item.name] : []));
    } else {
      // A subquery sees the tables of the queries around it, but not their other subqueries.
      context.scope.push(...shape.from.filter((ref) => !ref.query).map((ref) => ({ ...ref, outer: true })));
    }
  }
  return context;
}

/** Upper case unless the cell writes its keywords in lower case (or starts with a lower-case one). */
function keywordStyle(all: Token[], before: number, prefix: string): boolean {
  for (let k = all.length - 1; k >= 0; k--) {
    const t = all[k];
    if (t.end <= before && t.kind === 'word' && STYLE_WORDS.has(t.text.toLowerCase())) {
      return t.text !== t.text.toLowerCase();
    }
  }
  return !/[a-z]/.test(prefix) || prefix !== prefix.toLowerCase();
}

/** WITH queries at the start of a query, and where its body starts. */
function parseWith(tokens: Token[], match: number[], range: Range, depth: number): { ctes: Cte[]; body: number } {
  let i = range.from;
  const ctes: Cte[] = [];
  if (!isWord(tokens[i], 'with')) {
    return { ctes, body: i };
  }
  i++;
  if (isWord(tokens[i], 'recursive')) i++;
  while (i < range.to && isName(tokens[i])) {
    const name = nameOf(tokens[i]);
    i++;
    let columns: string[] | undefined;
    if (isPunct(tokens[i], '(') && match[i] > i) {
      columns = namesIn(tokens, match, i + 1, match[i]);
      i = match[i] + 1;
    }
    if (!isWord(tokens[i], 'as')) break;
    i++;
    if (isWord(tokens[i], 'not')) i++;
    if (isWord(tokens[i], 'materialized')) i++;
    if (!isPunct(tokens[i], '(')) break;
    const close = match[i] > i ? match[i] : range.to;
    ctes.push({ name, columns, query: parseQuery(tokens, match, { from: i + 1, to: close }, depth + 1) });
    i = close + 1;
    if (!isPunct(tokens[i], ',')) break;
    i++;
  }
  return { ctes, body: i };
}

function parseQuery(tokens: Token[], match: number[], range: Range, depth: number): QueryShape {
  if (depth > 8) {
    return { items: [], from: [], ctes: [] };
  }
  const { ctes, body } = parseWith(tokens, match, range, depth);
  return { ...parseCore(tokens, match, coreRange(tokens, match, { from: body, to: range.to }, body), depth), ctes };
}

/** The part of a UNION / EXCEPT / INTERSECT that holds the token at `at`. */
function coreRange(tokens: Token[], match: number[], range: Range, at: number): Range {
  let from = range.from;
  for (let i = range.from; i < range.to; i++) {
    if (isOpenBracket(tokens[i]) && match[i] > i) {
      i = match[i];
    } else if (isWord(tokens[i], 'union', 'except', 'intersect')) {
      if (i >= at) {
        return { from, to: i };
      }
      from = i + 1;
    }
  }
  return { from, to: range.to };
}

/** One SELECT (or UPDATE, INSERT, …): its select list and the relations it reads. */
function parseCore(tokens: Token[], match: number[], core: Range, depth: number): QueryShape {
  const shape: QueryShape = { items: [], from: [], ctes: [] };
  let selectAt = -1;
  let fromAt = -1;
  for (let i = core.from; i < core.to; i++) {
    const t = tokens[i];
    if (isOpenBracket(t) && match[i] > i) {
      i = match[i];
      continue;
    }
    if (isWord(t, 'select') && selectAt < 0) {
      selectAt = i;
    } else if (isWord(t, 'from') && fromAt < 0) {
      fromAt = i;
    } else if ((i === core.from && isWord(t, 'update', 'pivot', 'unpivot', 'copy')) || (i > core.from && isWord(t, 'into') && selectAt < 0)) {
      // UPDATE t SET …, INSERT INTO t (…), PIVOT t ON …: the statement's own table.
      const { ref } = parseRef(tokens, match, i + 1, core.to, depth, true);
      if (ref) shape.from.push(ref);
    }
  }
  if (fromAt >= 0) {
    shape.from.push(...parseFrom(tokens, match, fromAt + 1, core.to, depth));
  }
  if (selectAt >= 0) {
    shape.items = parseSelectList(tokens, match, selectAt + 1, core.to);
  } else if (isWord(tokens[core.from], 'values') && isPunct(tokens[core.from + 1], '(') && match[core.from + 1] > core.from + 1) {
    const width = namesIn(tokens, match, core.from + 2, match[core.from + 1], true).length;
    shape.items = Array.from({ length: width }, (_, i) => ({ name: `col${i}` }));
  } else if (fromAt >= 0) {
    shape.items = [{ star: undefined, exclude: [] }]; // FROM t without SELECT
  }
  return shape;
}

function parseFrom(tokens: Token[], match: number[], i: number, to: number, depth: number): RelationRef[] {
  const refs: RelationRef[] = [];
  while (i < to) {
    while (isWord(tokens[i], 'lateral', 'only')) i++;
    const { ref, next } = parseRef(tokens, match, i, to, depth);
    if (ref) refs.push(ref);
    // On to the next reference, after a comma or JOIN, unless the FROM clause ends first.
    let more = false;
    for (i = next; i < to; i++) {
      const t = tokens[i];
      if (isOpenBracket(t) && match[i] > i) {
        i = match[i];
      } else if (isPunct(t, ',') || isWord(t, 'join')) {
        i++;
        more = true;
        break;
      } else if (isWord(t, ...FROM_END) || isCloseBracket(t)) {
        return refs;
      }
    }
    if (!more) break;
  }
  return refs;
}

/**
 * A table reference at `i`: a name, table function call, file or subquery, then [AS] alias [(columns)].
 * A statement's `target` (INSERT INTO t (a, b)) is a table, never a call.
 */
function parseRef(
  tokens: Token[],
  match: number[],
  i: number,
  to: number,
  depth: number,
  target = false,
): { ref?: RelationRef; next: number } {
  const t = tokens[i];
  let ref: RelationRef;
  let j = i + 1;
  if (isPunct(t, '(')) {
    const close = match[i] > i ? match[i] : to;
    if (!isWord(tokens[i + 1], ...QUERY_START)) {
      return { next: close + 1 }; // a parenthesized join
    }
    ref = { parts: [], query: parseQuery(tokens, match, { from: i + 1, to: close }, depth + 1) };
    j = close + 1;
  } else if (t?.kind === 'string') {
    ref = { parts: [], file: stringValue(t) };
  } else if (isName(t)) {
    ref = { parts: [nameOf(t)] };
    while (isPunct(tokens[j], '.') && isPart(tokens[j + 1])) {
      ref.parts.push(nameOf(tokens[j + 1]));
      j += 2;
    }
    if (isPunct(tokens[j], '(') && !target) {
      ref.call = true;
      j = match[j] > j ? match[j] + 1 : to;
    }
  } else {
    return { next: i };
  }
  if (isWord(tokens[j], 'as')) j++;
  if (isName(tokens[j]) && !isWord(tokens[j], ...ALIAS_STOP)) {
    ref.alias = nameOf(tokens[j]);
    j++;
    if (isPunct(tokens[j], '(') && match[j] > j) {
      ref.columnAliases = namesIn(tokens, match, j + 1, match[j]);
      j = match[j] + 1;
    }
  }
  return { ref, next: j };
}

function parseSelectList(tokens: Token[], match: number[], i: number, to: number): SelectItem[] {
  if (isWord(tokens[i], 'distinct', 'all')) {
    i++;
    if (isWord(tokens[i], 'on') && isPunct(tokens[i + 1], '(') && match[i + 1] > i + 1) {
      i = match[i + 1] + 1;
    }
  }
  const items: SelectItem[] = [];
  let itemStart = i;
  for (; i < to; i++) {
    const t = tokens[i];
    if (isOpenBracket(t) && match[i] > i) {
      i = match[i];
    } else if (isPunct(t, ',')) {
      const item = selectItem(tokens, match, itemStart, i);
      if (item) items.push(item);
      itemStart = i + 1;
    } else if (isWord(t, ...SELECT_END)) {
      break;
    }
  }
  const item = selectItem(tokens, match, itemStart, i);
  if (item) items.push(item);
  return items;
}

function selectItem(tokens: Token[], match: number[], a: number, b: number): SelectItem | undefined {
  if (a >= b) {
    return undefined;
  }
  // A qualified name or star: t.x, t.*, db.s.t.x
  let k = a;
  const parts: string[] = [];
  while (k + 1 < b && isPart(tokens[k]) && isPunct(tokens[k + 1], '.')) {
    parts.push(nameOf(tokens[k]));
    k += 2;
  }
  if (isPunct(tokens[k], '*')) {
    const exclude: string[] = [];
    if (isWord(tokens[k + 1], 'exclude')) {
      const list = tokens[k + 2];
      if (isPunct(list, '(') && match[k + 2] > k + 2) {
        exclude.push(...namesIn(tokens, match, k + 3, match[k + 2]));
      } else if (isName(list)) {
        exclude.push(nameOf(list));
      }
    }
    return { star: parts.length ? parts[parts.length - 1] : undefined, exclude };
  }
  const last = tokens[b - 1];
  if (b - a >= 3 && isWord(tokens[b - 2], 'as') && (last.kind === 'word' || isName(last))) {
    return { name: nameOf(last) };
  }
  if (k === b - 1 && isPart(last) && (parts.length > 0 || isName(last))) {
    return { name: nameOf(last), ref: [...parts, nameOf(last)] };
  }
  if (isName(tokens[a]) && isPunct(tokens[a + 1], ':') && b - a > 2) {
    return { name: nameOf(tokens[a]) }; // DuckDB's prefix alias: `total: price * qty`
  }
  if (b - a >= 2 && isName(last) && !isPunct(tokens[b - 2], '.') && endsOperand(tokens, b - 2)) {
    return { name: nameOf(last) }; // implicit alias: `count(*) n`
  }
  return undefined;
}

/** The names in a comma-separated list (column lists); with `any`, one entry per item, whatever it is. */
function namesIn(tokens: Token[], match: number[], from: number, to: number, any = false): string[] {
  const names: string[] = [];
  let itemStart = from;
  for (let i = from; i <= to; i++) {
    if (i < to && isOpenBracket(tokens[i]) && match[i] > i) {
      i = match[i];
    } else if (i === to || isPunct(tokens[i], ',')) {
      if (i > itemStart) {
        if (any) {
          names.push('');
        } else if (isPart(tokens[itemStart])) {
          names.push(nameOf(tokens[itemStart]));
        }
      }
      itemStart = i + 1;
    }
  }
  return names;
}
