// Lays out SQL that DuckDB keeps on one line (a view's definition: DuckDB stores it normalized, without
// the comments and line breaks it was written with): a clause per line, long select lists one item per
// line, long conditions an AND or OR per line, CTEs and long subqueries indented in their brackets.
// The tokens themselves are kept as they are. No vscode imports: shared with the unit tests.

import { tokenize } from './tokens';

const INDENT = '    ';
/** Statements this short stay on one line. */
const WIDTH = 80;
/** Select lists, conditions and subqueries longer than this are split. */
const LONG = 60;

const QUERY_STARTS = new Set(['SELECT', 'WITH', 'FROM', 'VALUES', 'TABLE', 'PIVOT', 'UNPIVOT', 'SUMMARIZE', 'DESCRIBE']);
const JOIN_WORDS = new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'ASOF', 'POSITIONAL', 'ANTI', 'SEMI']);
const LISTS = new Set(['SELECT', 'GROUP BY', 'ORDER BY']);
const CONDITIONS = new Set(['WHERE', 'HAVING', 'QUALIFY']);

interface Frame {
  /** A query's own level, where its clauses start. */
  query: boolean;
  /** Its clauses start lines (a query level that is laid out over lines). */
  block: boolean;
  /** What it holds may be laid out over lines (false inside a subquery kept on one line). */
  wrap: boolean;
  /** Indent of its clauses. */
  base: number;
  /** Indent of the line its `)` starts. */
  close: number;
  clause?: string;
  /** Indent of the line after one of its commas, when its list is split. */
  commas?: number;
  /** Indent of the line one of its ANDs or ORs starts, when its condition is split. */
  logic?: number;
  /** BETWEENs at this level still waiting for their AND. */
  between: number;
  /** Indent of the line a join at this level starts, in DuckDB 2's brackets around joins: FROM ((a JOIN b …) JOIN c …). */
  joins?: number;
}

export function formatSql(sql: string): string {
  const text = sql.trim();
  const tokens = tokenize(text);
  const isPunct = (i: number, p: string) => tokens[i]?.kind === 'punct' && tokens[i].text === p;
  const word = (i: number) => (tokens[i]?.kind === 'word' ? tokens[i].text.toUpperCase() : '');

  // The `)` of each `(` (tokens.length when it has none).
  const closeOf: number[] = [];
  const open: number[] = [];
  tokens.forEach((_, i) => {
    if (isPunct(i, '(')) open.push(i);
    else if (isPunct(i, ')') && open.length) closeOf[open.pop()!] = i;
  });
  open.forEach((i) => (closeOf[i] = tokens.length));

  const length = (from: number, to: number) => text.slice(tokens[from].start, tokens[Math.min(to, tokens.length - 1)].end).length;
  const isQueryParen = (i: number) => {
    let j = i + 1;
    while (isPunct(j, '(')) j++;
    return QUERY_STARTS.has(word(j));
  };
  const holdsQuery = (i: number) => {
    for (let j = i + 1; j < closeOf[i]; j++) if (isPunct(j, '(') && isQueryParen(j)) return true;
    return false;
  };
  /** Whether brackets hold a join of their own (not only in brackets inside them). */
  const holdsJoin = (i: number) => {
    for (let j = i + 1; j < closeOf[i]; j = isPunct(j, '(') ? closeOf[j] + 1 : j + 1) if (clauseAt(j)?.name === 'JOIN') return true;
    return false;
  };

  /** The clause (or join, or set operation) that starts at token j of a query level, and its last word. */
  const clauseAt = (j: number): { name: string; end: number } | undefined => {
    const w = word(j);
    switch (w) {
      case '':
        return undefined;
      case 'SELECT':
      case 'WHERE':
      case 'HAVING':
      case 'QUALIFY':
      case 'WINDOW':
      case 'LIMIT':
      case 'OFFSET':
        return { name: w, end: j };
      case 'FROM': // not IS [NOT] DISTINCT FROM
        return word(j - 1) === 'DISTINCT' && ['IS', 'NOT'].includes(word(j - 2)) ? undefined : { name: w, end: j };
      case 'GROUP':
      case 'ORDER':
        return word(j + 1) === 'BY' ? { name: `${w} BY`, end: j + 1 } : undefined;
      case 'WITH': // not TIMESTAMP WITH TIME ZONE
        return word(j + 1) === 'TIME' ? undefined : { name: w, end: word(j + 1) === 'RECURSIVE' ? j + 1 : j };
      case 'UNION':
      case 'EXCEPT':
      case 'INTERSECT': {
        let end = j;
        while (['ALL', 'DISTINCT', 'BY', 'NAME'].includes(word(end + 1))) end++;
        return { name: 'SET', end };
      }
      case 'JOIN':
        return JOIN_WORDS.has(word(j - 1)) ? undefined : { name: 'JOIN', end: j };
      default: {
        if (!JOIN_WORDS.has(w) || JOIN_WORDS.has(word(j - 1))) return undefined;
        let end = j;
        while (JOIN_WORDS.has(word(end + 1))) end++;
        return word(end + 1) === 'JOIN' ? { name: 'JOIN', end: end + 1 } : undefined;
      }
    }
  };
  /** The last token of the clause whose first token after its keywords is j: before the next clause at its level. */
  const clauseEnd = (j: number) => {
    let k = j;
    while (k < tokens.length && !isPunct(k, ')') && !isPunct(k, ';') && !(k > j && clauseAt(k))) {
      k = isPunct(k, '(') ? closeOf[k] + 1 : k + 1;
    }
    return k - 1;
  };

  const frames: Frame[] = [{ query: true, block: text.length > WIDTH, wrap: text.length > WIDTH, base: 0, close: 0, between: 0 }];
  /** Tokens that start a line, and its indent. */
  const breaks = new Map<number, number>();
  let out = '';
  let lineIndent = 0;

  tokens.forEach((token, i) => {
    let indent = breaks.get(i);
    let frame = frames[frames.length - 1];
    if (isPunct(i, ')')) {
      if (frames.length > 1) {
        frames.pop();
        if (frame.block) indent = frame.close;
        frame = frames[frames.length - 1];
      }
    } else if (frame.block) {
      const clause = clauseAt(i);
      if (clause) {
        indent = frame.base;
        frame.clause = clause.name;
        frame.commas = frame.logic = undefined;
        if (clause.name === 'SET') {
          breaks.set(clause.end + 1, frame.base);
          frame.clause = undefined;
        } else {
          let first = clause.end + 1;
          if (clause.name === 'SELECT') {
            while (['DISTINCT', 'ALL'].includes(word(first))) first++;
            if (word(first - 1) === 'DISTINCT' && word(first) === 'ON' && isPunct(first + 1, '(')) first = closeOf[first + 1] + 1;
          }
          const last = clauseEnd(first);
          const long = first <= last && length(first, last) > LONG;
          if (LISTS.has(clause.name) && long) {
            breaks.set(first, frame.base + 1);
            frame.commas = frame.base + 1;
          } else if (clause.name === 'WITH') {
            frame.commas = frame.base;
          } else if (CONDITIONS.has(clause.name) && long) {
            frame.logic = frame.base + 1;
          }
        }
      } else if (isPunct(i, '(') && frames.length === 1 && !frame.clause && word(i - 1) === 'AS' && isQueryParen(i)) {
        indent = frame.base; // CREATE VIEW v AS (SELECT …) UNION …
      } else if (isPunct(i, ',') && frame.commas !== undefined) {
        breaks.set(i + 1, frame.commas);
      }
    } else if (frame.joins !== undefined && clauseAt(i)?.name === 'JOIN') {
      indent = frame.joins;
    }
    if (frame.logic !== undefined && token.kind === 'word') {
      const w = word(i);
      if (w === 'BETWEEN') frame.between++;
      else if (w === 'AND' && frame.between) frame.between--;
      else if (w === 'AND' || w === 'OR') indent = frame.logic;
    }

    if (indent !== undefined && out) {
      out = `${out.trimEnd()}\n${INDENT.repeat(indent)}`;
      lineIndent = indent;
    } else if (out && spaceBefore(i)) {
      out += ' ';
    }
    out += token.text;

    if (isPunct(i, '(')) {
      if (isQueryParen(i)) {
        const cte = frame.clause === 'WITH' && ['AS', 'MATERIALIZED'].includes(word(i - 1));
        if (frame.wrap && (cte || length(i, closeOf[i]) > LONG || holdsQuery(i))) {
          frames.push({ query: true, block: true, wrap: true, base: lineIndent + 1, close: lineIndent, between: 0 });
          breaks.set(i + 1, lineIndent + 1);
        } else {
          frames.push({ query: true, block: false, wrap: false, base: 0, close: 0, between: 0 });
        }
      } else {
        // WHERE ((a) AND (b)): DuckDB's brackets around a whole condition split like the condition would.
        const whole = frame.logic !== undefined && CONDITIONS.has(word(i - 1)) && clauseEnd(i) === closeOf[i];
        const joins = !frame.wrap || !holdsJoin(i)
          ? undefined
          : frame.joins ?? (frame.block && (frame.clause === 'FROM' || frame.clause === 'JOIN') ? frame.base + 1 : undefined);
        frames.push({ query: false, block: false, wrap: frame.wrap, base: 0, close: 0, between: 0, logic: whole ? frame.logic : undefined, joins });
      }
    } else if (token.kind === 'comment' && token.text.startsWith('--')) {
      breaks.set(i + 1, lineIndent);
    } else if (isPunct(i, ';') && frames.length === 1) {
      breaks.set(i + 1, 0);
      frame.clause = frame.commas = frame.logic = undefined;
    }
  });
  return out;

  /** Whether the text had a space before token i (or needs one: DuckDB 1.x writes `)SELECT`), less any before , ; ) or after (. */
  function spaceBefore(i: number): boolean {
    if (isPunct(i, ',') || isPunct(i, ';') || isPunct(i, ')') || isPunct(i - 1, '(')) return false;
    const gap = text.slice(tokens[i - 1].end, tokens[i].start);
    return /\s/.test(gap) || (isPunct(i - 1, ')') && tokens[i].kind === 'word');
  }
}
