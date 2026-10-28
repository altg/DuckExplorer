// The statements of a .sql file: where each starts and ends, and which one a cursor is on. No vscode
// imports: shared with the unit tests.
import { tokenize } from './tokens';

export interface Statement {
  /** Offset of its first token (comments before it are left out). */
  start: number;
  /** Offset just past its last token, before any `;`. */
  end: number;
  /** Offset just past its `;`, or `end` when it has none. */
  through: number;
  text: string;
}

/** Splits SQL on the `;` that end statements (not those in strings, comments or quoted names). */
export function splitStatements(text: string, offset = 0): Statement[] {
  const statements: Statement[] = [];
  let start: number | undefined;
  let end = 0;
  const add = (through: number) => {
    if (start !== undefined) {
      statements.push({ start: start + offset, end: end + offset, through: through + offset, text: text.slice(start, end) });
    }
    start = undefined;
  };
  for (const token of tokenize(text)) {
    if (token.kind === 'comment') continue;
    if (token.kind === 'punct' && token.text === ';') {
      add(token.end);
    } else {
      start ??= token.start;
      end = token.end;
    }
  }
  add(end);
  return statements;
}

/**
 * The statement to run for a cursor at `offset`: the one it is in, or that ends earlier on its line,
 * else the next one (the cursor is on a blank line or a comment above it), else the last.
 */
export function statementAt(statements: Statement[], text: string, offset: number): Statement | undefined {
  let previous: Statement | undefined;
  for (const statement of statements) {
    if (offset < statement.start) {
      return previous && !/[\r\n]/.test(text.slice(previous.through, offset)) ? previous : statement;
    }
    if (offset <= statement.through) {
      return statement;
    }
    previous = statement;
  }
  return previous;
}
