// Loaded on demand (its own chunk), so notebooks without Vega-Lite charts never pay for Vega.
import embed, { type VisualizationSpec } from 'vega-embed';

/**
 * Draws a Vega-Lite spec (an Altair chart, or the Chart view of a result) in the colors of the VS Code
 * theme; the spec's own config wins over them. Expressions are interpreted rather than compiled to
 * functions, so charts work under the webviews' content security policy.
 */
export async function renderVegaLite(container: HTMLElement, spec: VisualizationSpec, signal: AbortSignal): Promise<void> {
  const result = await embed(container, spec, {
    mode: 'vega-lite',
    ast: true,
    actions: false,
    config: themeConfig(container),
    tooltip: { theme: isDark() ? 'dark' : 'light' },
  });
  if (signal.aborted) {
    result.finalize();
  } else {
    signal.addEventListener('abort', () => result.finalize());
  }
}

function isDark(): boolean {
  const classes = document.body.classList;
  return classes.contains('vscode-dark') || classes.contains('vscode-high-contrast');
}

/** Text, axes and gridlines in the theme's colors, on a transparent background. */
function themeConfig(element: HTMLElement): Record<string, unknown> {
  const style = getComputedStyle(element);
  const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const text = color('--vscode-foreground', isDark() ? '#cccccc' : '#3b3b3b');
  const muted = color('--vscode-descriptionForeground', text);
  const font = color('--vscode-font-family', 'sans-serif');
  const line = 'rgba(128, 128, 128, 0.45)';
  const grid = 'rgba(128, 128, 128, 0.18)';
  return {
    background: 'transparent',
    font,
    title: { color: text, subtitleColor: muted },
    axis: { labelColor: muted, titleColor: text, domainColor: line, tickColor: line, gridColor: grid },
    legend: { labelColor: muted, titleColor: text },
    header: { labelColor: text, titleColor: text },
    view: { stroke: grid },
  };
}
