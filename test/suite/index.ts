import * as fs from 'fs';
import * as path from 'path';
import Mocha from 'mocha';
import { annotateFailure } from '../annotate';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 180_000 });
  for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js'))) {
    mocha.addFile(path.join(__dirname, file));
  }
  return new Promise((resolve, reject) => {
    const runner = mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
    // Each failing test (or hook) is an annotation on a CI run.
    runner.on('fail', (test, err) => annotateFailure(test.fullTitle(), err));
  });
}
