// The table summary panel's webview (src/explorer/summaryPanel.ts): the relation's name and kind,
// and the results grid opened on its Column Explorer.
import type { SummaryAction, SummaryMessage, SummaryRelation } from '../kernel/protocol';
import { ResultGrid } from './grid';
import summaryCss from './summary.css';
import { el } from './util';
import { addStyles, client, onMessage, send as post } from './webview';

addStyles(summaryCss);
const header = el('header', 'dx-summary-head');
const main = el('main', 'dx-summary-body');
document.body.append(header, main);

let shown: { controller: AbortController; grid?: ResultGrid } | undefined;

onMessage((data) => {
  const message = data as SummaryMessage;
  if (message?.type !== 'loading' && message?.type !== 'summary' && message?.type !== 'error') return;
  shown?.controller.abort();
  shown = { controller: new AbortController() };
  renderHeader(message.relation, message.type === 'summary' ? message.table.sampledFrom : undefined);
  if (message.type === 'loading') {
    main.replaceChildren(el('div', 'dx-summary-status', `Reading ${message.relation.name}…`));
  } else if (message.type === 'error') {
    main.replaceChildren(el('div', 'dx-summary-status dx-error', `Could not summarize ${message.relation.name}: ${message.message}`));
  } else {
    main.replaceChildren();
    shown.grid = new ResultGrid(main, message.table, client, shown.controller.signal, {
      tab: 'columns',
      maxHeight: availableHeight(),
      queryCell: true,
    });
  }
});

window.addEventListener('resize', () => shown?.grid?.setMaxHeight(availableHeight()));
send({ type: 'ready' });

function renderHeader(relation: SummaryRelation, sampledFrom: number | undefined): void {
  const title = el('div', 'dx-summary-title');
  title.append(el('h1', '', relation.name), el('span', 'dx-summary-kind', relation.kind));
  const names = el('div', 'dx-summary-names');
  names.append(title, el('div', 'dx-summary-where', `${relation.database} › ${relation.schema}`));
  if (relation.comment) names.append(el('p', 'dx-summary-comment', relation.comment));
  if (sampledFrom !== undefined) {
    const note = `Statistics and rows are from a random sample: ${relation.name} has ${sampledFrom.toLocaleString()} rows. ` +
      'Filters written to a notebook with New cell query all of them.';
    names.append(el('p', 'dx-summary-note', note));
  }

  const actions = el('div', 'dx-summary-actions');
  const preview = el('button', 'dx-button', 'Preview in notebook');
  preview.title = `Add SELECT * FROM ${relation.qualified} LIMIT 100 to a notebook and run it`;
  preview.addEventListener('click', () => send({ type: 'preview' }));
  const refresh = el('button', 'dx-button secondary', 'Refresh');
  refresh.title = 'Read the rows again, e.g. after they changed';
  refresh.addEventListener('click', () => send({ type: 'refresh' }));
  actions.append(preview, refresh);
  header.replaceChildren(names, actions);
}

/** The rows and Column Explorer fill the panel below the header, leaving room for the footer. */
function availableHeight(): number {
  return Math.max(200, Math.floor(window.innerHeight - main.getBoundingClientRect().top - 64));
}

function send(action: SummaryAction): void {
  post(action);
}
