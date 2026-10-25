// Loaded on demand (its own chunk), so table-only notebooks never pay for plotly.js.
import Plotly from 'plotly.js-dist-min';

const DEFAULT_HEIGHT = 450;

export async function renderPlotly(container: HTMLElement, figure: any, signal: AbortSignal): Promise<void> {
  const layout = { ...(figure.layout ?? {}) };
  // Blend the chart's paper with the notebook, unless the figure chose a color itself.
  if (layout.paper_bgcolor === undefined) {
    layout.paper_bgcolor = 'rgba(0,0,0,0)';
  }
  if (layout.height === undefined) {
    container.style.height = `${DEFAULT_HEIGHT}px`;
    layout.autosize = true;
  }
  await Plotly.newPlot(container, figure.data ?? [], layout, {
    responsive: true,
    displaylogo: false,
    ...(figure.config ?? {}),
  });
  signal.addEventListener('abort', () => Plotly.purge(container));
}
