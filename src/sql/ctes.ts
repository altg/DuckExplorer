// The CTEs of a query (WITH a AS (…), b AS (…) SELECT …), for the live preview's CTE inspection: with
// the cursor in a CTE, the preview shows that CTE's rows. No vscode imports: shared with the unit tests.

import { quoteIdentifier } from './identifiers';
import { nameOf, tokenize } from './tokens';

export interface Cte {
  name: string;
  /** Offsets in the statement: of its name, and just past the `)` that closes its query (the statement's end while that is missing). */
  start: number;
  end: number;
}

export interface WithClause {
  ctes: Cte[];
  /** Where the query after the CTEs starts (the statement's end while it's missing). */
  queryStart: number;
}

/** The statement's own WITH clause (not one of a subquery); undefined when it starts with something else. */
export function withClause(text: string): WithClause | undefined {
  const tokens = tokenize(text).filter((token) => token.kind !== 'comment');
  const word = (i: number) => (tokens[i]?.kind === 'word' ? tokens[i].text.toUpperCase() : '');
  const isPunct = (i: number, p: string) => tokens[i]?.kind === 'punct' && tokens[i].text === p;
  /** The `)` of the `(` at i, or tokens.length when it's missing. */
  const closeOf = (i: number) => {
    let depth = 0;
    for (let j = i; j < tokens.length; j++) {
      if (isPunct(j, '(')) depth++;
      else if (isPunct(j, ')') && --depth === 0) return j;
    }
    return tokens.length;
  };
  if (word(0) !== 'WITH') {
    return undefined;
  }
  const ctes: Cte[] = [];
  let i = word(1) === 'RECURSIVE' ? 2 : 1;
  while (tokens[i]?.kind === 'word' || tokens[i]?.kind === 'quoted') {
    const name = tokens[i];
    // AS, after a column list or USING KEY (…).
    let j = i + 1;
    while (j < tokens.length && word(j) !== 'AS') j = isPunct(j, '(') ? closeOf(j) + 1 : j + 1;
    j++;
    while (word(j) === 'NOT' || word(j) === 'MATERIALIZED') j++;
    if (!isPunct(j, '(')) break;
    const close = closeOf(j);
    ctes.push({ name: nameOf(name), start: name.start, end: close < tokens.length ? tokens[close].end : text.length });
    i = close + 1;
    if (!isPunct(i, ',')) break;
    i++;
  }
  return ctes.length ? { ctes, queryStart: tokens[i]?.start ?? text.length } : undefined;
}

/** What the live preview runs for a cursor at `offset` in a statement. */
export interface PreviewTarget {
  sql: string;
  /** The CTE whose rows it shows; undefined for the statement's own. */
  cte?: string;
  /** The statement's CTEs, by name. */
  ctes: string[];
}

/** The statement, or with the cursor in one of its CTEs, that CTE: its own and the earlier CTEs, then `SELECT * FROM` it. */
export function previewTarget(text: string, offset: number): PreviewTarget {
  const clause = withClause(text);
  const ctes = clause?.ctes.map((cte) => cte.name) ?? [];
  const cte = clause?.ctes.find((c) => c.start <= offset && offset <= c.end);
  if (!cte) {
    return { sql: text, ctes };
  }
  return { sql: `${text.slice(0, cte.end)}\nSELECT * FROM ${quoteIdentifier(cte.name)}`, cte: cte.name, ctes };
}
