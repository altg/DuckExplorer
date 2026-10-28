/** In the webviews of the summary panel and the results view (src/renderer/webview.ts). */
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

declare module '*.css' {
  const css: string;
  export default css;
}

declare module 'plotly.js-dist-min' {
  const Plotly: {
    newPlot(root: HTMLElement, data: unknown[], layout?: unknown, config?: unknown): Promise<unknown>;
    purge(root: HTMLElement): void;
  };
  export default Plotly;
}
