// The results view of .sql files (src/sql/resultsView.ts): what ran and how it went, with the
// results grid for the last statement's rows.
import type { ResultsAction, ResultsMessage, RunSource, StatementsResult } from '../kernel/protocol';
import { ResultGrid } from './grid';
import resultsCss from './results.css';
import { el, formatDuration } from './util';
import { addStyles, client, onMessage, send as post } from './webview';

const MAX_SQL_CHARS = 200;

addStyles(resultsCss);
const header = el('header', 'dx-run-head');
const main = el('main', 'dx-run-body');
document.body.append(header, main);
const keys = /Mac/.test(navigator.userAgent) ? 'Cmd+Enter' : 'Ctrl+Enter';
main.append(el('div', 'dx-run-empty', `Run a statement of a .sql file (${keys}) to see its result here.`));

let shown: { controller: AbortController; grid?: ResultGrid } | undefined;

onMessage((data) => {
  const message = data as ResultsMessage;
  if (message?.type !== 'running' && message?.type !== 'result' && message?.type !== 'failed') return;
  renderHeader(message);
  if (message.type === 'running') {
    // The last result stays, dimmed, until the new one is in.
    main.classList.add('dx-stale');
    return;
  }
  main.classList.remove('dx-stale');
  shown?.controller.abort();
  shown = { controller: new AbortController() };
  if (message.type === 'failed') {
    main.replaceChildren(el('pre', 'dx-run-error', message.message));
    return;
  }
  const { result } = message;
  if (result.error) {
    main.replaceChildren(el('pre', 'dx-run-error', result.error.evalue));
  } else if (result.table) {
    main.replaceChildren();
    shown.grid = new ResultGrid(main, result.table, client, shown.controller.signal, {
      maxHeight: availableHeight(),
      queryCell: true,
      queryLink: {
        label: 'Insert query',
        title: 'Add this query below the statement, filtered and sorted like the grid, and run it',
      },
    });
  } else {
    main.replaceChildren();
  }
});

window.addEventListener('resize', () => shown?.grid?.setMaxHeight(availableHeight()));
send({ type: 'ready' });

function renderHeader(message: ResultsMessage): void {
  const { source } = message;
  const where = el('button', 'dx-link dx-run-source', source.label);
  where.title = 'Show the statement in its file';
  where.addEventListener('click', () => send({ type: 'reveal' }));
  const sql = el('code', 'dx-run-sql', shorten(source.sql));
  sql.title = source.sql.length > 2000 ? `${source.sql.slice(0, 2000)}…` : source.sql;
  const children: HTMLElement[] = [where, sql];
  if (message.type === 'running') {
    children.push(el('span', 'dx-run-status', 'Running…'));
    const cancel = el('button', 'dx-button secondary', 'Cancel');
    cancel.title = 'Interrupt the running statement';
    cancel.addEventListener('click', () => send({ type: 'cancel' }));
    children.push(cancel);
  } else if (message.type === 'failed') {
    children.push(el('span', 'dx-run-status dx-error', 'Could not run'));
  } else {
    const status = statusOf(source, message.result);
    children.push(el('span', message.result.error ? 'dx-run-status dx-error' : 'dx-run-status', status));
  }
  header.replaceChildren(...children);
}

/** How the run went; the grid's footer counts the rows of a result. */
function statusOf(source: RunSource, result: StatementsResult): string {
  const time = formatDuration(result.elapsedMs);
  if (result.error) {
    const which = source.statements > 1 ? `Statement ${result.error.statement + 1} of ${source.statements}` : 'The statement';
    return result.error.ename === 'KeyboardInterrupt' ? `${which} was interrupted` : `${which} failed`;
  }
  const ran = source.statements > 1 ? `Ran ${source.statements} statements` : '';
  if (result.table) return ran;
  return [ran, result.message || (ran ? '' : 'Statement executed'), time].filter(Boolean).join(' · ');
}

function shorten(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SQL_CHARS ? `${flat.slice(0, MAX_SQL_CHARS - 1)}…` : flat;
}

/** The grid fills the view below the header, leaving room for its footer. */
function availableHeight(): number {
  return Math.max(120, Math.floor(window.innerHeight - main.getBoundingClientRect().top - 52));
}

function send(action: ResultsAction): void {
  post(action);
}
