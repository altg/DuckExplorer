import * as vscode from 'vscode';
import { PythonExtension } from '@vscode/python-extension';

/**
 * The interpreter that runs the kernel: the `duckexplorer.pythonPath` setting, then the
 * interpreter selected in the Python extension, then `python` on PATH.
 */
export async function resolvePython(log: vscode.LogOutputChannel): Promise<string> {
  const configured = vscode.workspace.getConfiguration('duckexplorer').get<string>('pythonPath')?.trim();
  if (configured) {
    return configured;
  }
  if (vscode.extensions.getExtension('ms-python.python')) {
    try {
      const api = await withTimeout(PythonExtension.api(), 10_000);
      const active = api.environments.getActiveEnvironmentPath(vscode.workspace.workspaceFolders?.[0]?.uri);
      const env = await withTimeout(api.environments.resolveEnvironment(active), 10_000);
      const executable = env?.executable.uri?.fsPath;
      if (executable) {
        return executable;
      }
    } catch (err) {
      log.warn(`Could not get the interpreter from the Python extension: ${String(err)}`);
    }
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Explains a kernel that died during startup, offering the fix for missing packages. */
export async function reportStartupFailure(python: string, stderr: string): Promise<void> {
  const missing = /No module named '([^'.]+)/.exec(stderr)?.[1];
  const install = 'Install packages';
  const choose = 'Select interpreter';
  const showLog = 'Show log';
  const message = missing
    ? `DuckExplorer: the Python package '${missing}' is missing from ${python}. The kernel needs duckdb and pyarrow (pandas, matplotlib, plotly and altair are optional).`
    : `DuckExplorer: the kernel failed to start with ${python}.`;
  const choice = await vscode.window.showErrorMessage(message, install, choose, showLog);
  if (choice === install) {
    const terminal = vscode.window.createTerminal('DuckExplorer: install packages');
    terminal.show();
    const quoted = !python.includes(' ') ? python : process.platform === 'win32' ? `& "${python}"` : `"${python}"`;
    terminal.sendText(`${quoted} -m pip install --upgrade duckdb pyarrow pandas matplotlib plotly altair`);
  } else if (choice === choose) {
    await vscode.commands.executeCommand('python.setInterpreter');
  } else if (choice === showLog) {
    await vscode.commands.executeCommand('duckexplorer.showLog');
  }
}
