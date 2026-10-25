import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath: path.resolve(__dirname, 'suite', 'index'),
      launchArgs: [path.join(extensionDevelopmentPath, 'samples'), '--disable-extensions', '--disable-workspace-trust'],
    });
  } catch (err) {
    console.error('Extension tests failed:', err);
    process.exit(1);
  }
}

void main();
