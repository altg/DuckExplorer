// `npm run dev`: opens an Extension Development Host on samples/ with this checkout's DuckExplorer,
// like F5 without the debugger. The code CLI turns a relative --extensionDevelopmentPath into the
// root of the drive, so both paths are made absolute here.
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const samples = join(root, 'samples');
if (!existsSync(join(samples, 'demo.duckdb'))) {
  console.warn('samples/demo.duckdb is missing; build it with: python samples/make_sample_db.py');
}

const args = [`--extensionDevelopmentPath=${root}`, samples];
// On Windows `code` is a .cmd file, which Node starts only through a shell: one command line, quoted.
const child =
  process.platform === 'win32'
    ? spawn(['code', ...args.map((arg) => `"${arg}"`)].join(' '), { stdio: 'inherit', shell: true })
    : spawn('code', args, { stdio: 'inherit' });
child.on('error', (err) => {
  console.error(`Could not run VS Code's \`code\` command (${err.message}). Is it on PATH?`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
