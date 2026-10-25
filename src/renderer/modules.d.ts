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
