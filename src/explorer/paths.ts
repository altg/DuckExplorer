import * as fs from 'fs';
import * as path from 'path';

/**
 * The same file. DuckDB reports an attached file by its final path (long names rather than 8.3 short ones
 * like C:\Users\RUNNER~1, symlinks resolved, the drive letter in upper case), while VS Code's paths are as
 * written (and the drive letter in lower case), so files that exist are compared as the file system resolves
 * them. Case doesn't matter on Windows.
 */
export function samePath(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

function canonical(file: string): string {
  let resolved = path.resolve(file);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // A file that is gone is compared as written.
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
