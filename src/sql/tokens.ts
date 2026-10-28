// A DuckDB SQL tokenizer, enough to tell where the cursor is: in a string, comment or quoted
// identifier, after which keyword, inside which brackets. No vscode imports: shared with the unit tests.

export type TokenKind = 'word' | 'quoted' | 'string' | 'number' | 'comment' | 'punct';

export interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
  /** An unterminated string, quoted identifier or block comment: it runs to the end of the text. */
  open?: boolean;
}

const WORD = /[A-Za-z_À-￿][A-Za-z0-9_$À-￿]*/y;
const NUMBER = /(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;
const PARAMETER = /\$\d*/y;
const PUNCT = ['->>', '::', ':=', '=>', '->', '<=', '>=', '<>', '!=', '||', '**', '//', '=='];

function sticky(pattern: RegExp, text: string, at: number): string | undefined {
  pattern.lastIndex = at;
  return pattern.exec(text)?.[0];
}

/** Scans a quoted run from `at` (just past the opening quote); a doubled quote is an escaped one. */
function closeQuote(text: string, at: number, quote: string, backslashes: boolean): number | undefined {
  for (let i = at; i < text.length; i++) {
    if (backslashes && text[i] === '\\') {
      i++;
    } else if (text[i] === quote) {
      if (text[i + 1] !== quote) {
        return i + 1;
      }
      i++;
    }
  }
  return undefined;
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const push = (kind: TokenKind, start: number, end: number | undefined) => {
    const token: Token = { kind, text: text.slice(start, end ?? text.length), start, end: end ?? text.length };
    if (end === undefined) {
      token.open = true;
    }
    tokens.push(token);
    return token.end;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    let match: string | undefined;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '-' && text[i + 1] === '-') {
      const newline = text.indexOf('\n', i);
      i = push('comment', i, newline < 0 ? text.length : newline);
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = push('comment', i, close < 0 ? undefined : close + 2);
    } else if (c === "'") {
      i = push('string', i, closeQuote(text, i + 1, "'", false));
    } else if ((c === 'e' || c === 'E') && text[i + 1] === "'") {
      i = push('string', i, closeQuote(text, i + 2, "'", true));
    } else if (c === '"') {
      i = push('quoted', i, closeQuote(text, i + 1, '"', false));
    } else if (c === '$') {
      const tag = sticky(DOLLAR_TAG, text, i);
      if (tag) {
        const close = text.indexOf(tag, i + tag.length);
        i = push('string', i, close < 0 ? undefined : close + tag.length);
      } else {
        i = push('number', i, i + sticky(PARAMETER, text, i)!.length);
      }
    } else if ((match = sticky(WORD, text, i))) {
      i = push('word', i, i + match.length);
    } else if ((match = sticky(NUMBER, text, i))) {
      i = push('number', i, i + match.length);
    } else {
      const op = PUNCT.find((p) => text.startsWith(p, i)) ?? c;
      i = push('punct', i, i + op.length);
    }
  }
  return tokens;
}

/** The value of a quoted identifier, or a word as written. */
export function nameOf(token: Token): string {
  if (token.kind !== 'quoted') {
    return token.text;
  }
  const inner = token.open ? token.text.slice(1) : token.text.slice(1, -1);
  return inner.replace(/""/g, '"');
}

/** The value of a '…' string literal. */
export function stringValue(token: Token): string {
  const inner = token.open ? token.text.slice(1) : token.text.slice(1, -1);
  return inner.replace(/''/g, "'");
}
