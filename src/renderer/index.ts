import type { ActivationFunction } from 'vscode-notebook-renderer';
import { PLOTLY_MIME, TABLE_MIME, type TableResult } from '../kernel/protocol';
import { HostClient } from './client';
import { ResultGrid } from './grid';
import css from './styles.css';

export const activate: ActivationFunction = (context) => {
  const host = new HostClient(context);
  const disposers = new Map<string, AbortController>();

  return {
    renderOutputItem(item, element, signal) {
      disposers.get(item.id)?.abort();
      const controller = new AbortController();
      disposers.set(item.id, controller);
      signal.addEventListener('abort', () => controller.abort());

      const style = document.createElement('style');
      style.textContent = css;
      element.replaceChildren(style);

      if (item.mime === TABLE_MIME) {
        new ResultGrid(element, item.json() as TableResult, host, controller.signal);
      } else if (item.mime === PLOTLY_MIME) {
        const container = document.createElement('div');
        container.className = 'dx-plot';
        element.append(container);
        const figure = item.json();
        import('./plotly')
          .then(({ renderPlotly }) => (controller.signal.aborted ? undefined : renderPlotly(container, figure, controller.signal)))
          .catch((err: unknown) => {
            container.className = 'dx-plot-error';
            container.textContent = `Could not render the Plotly figure: ${err instanceof Error ? err.message : String(err)}`;
          });
      }
    },
    disposeOutputItem(id) {
      if (id === undefined) {
        disposers.forEach((c) => c.abort());
        disposers.clear();
      } else {
        disposers.get(id)?.abort();
        disposers.delete(id);
      }
    },
  };
};
