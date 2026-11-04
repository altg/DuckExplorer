import * as fs from 'fs';
import * as path from 'path';

// The extension's ID as VS Code knows it, `publisher.name` from package.json, so the tests don't
// change when the publisher does.
const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
export const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;
