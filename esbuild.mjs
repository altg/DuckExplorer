import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const contexts = await Promise.all([
  // Extension host: Node, CommonJS, vscode provided at runtime.
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  }),
  // Notebook renderer: browser ESM; Plotly is split into a lazily loaded chunk.
  esbuild.context({
    ...common,
    entryPoints: { renderer: 'src/renderer/index.ts' },
    outdir: 'dist',
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    loader: { '.css': 'text' },
  }),
]);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
