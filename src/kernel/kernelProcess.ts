import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { KernelInfo } from './protocol';
import { reportStartupFailure, resolvePython } from './pythonEnv';

const STARTUP_TIMEOUT_MS = 60_000;

interface Pending {
  method: string;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export class KernelRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * The Python sidecar (`python -m duckexplorer_kernel`) and the line-delimited JSON protocol to it.
 * The kernel starts on first use and again on the next request after a crash or restart.
 */
export class KernelClient implements vscode.Disposable {
  private proc: ChildProcess | undefined;
  private starting: Promise<KernelInfo> | undefined;
  private info: KernelInfo | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private busyCount = 0;
  private disposed = false;
  private failed = false;
  private readonly statusItem = vscode.window.createStatusBarItem('duckexplorer.kernel', vscode.StatusBarAlignment.Left, 50);
  private readonly startedEmitter = new vscode.EventEmitter<KernelInfo>();
  /** Fires after each (re)start, once the kernel is ready; listeners restore attached databases. */
  readonly onDidStart = this.startedEmitter.event;

  constructor(
    private readonly extensionPath: string,
    private readonly log: vscode.LogOutputChannel,
    private readonly configure: () => Record<string, unknown>,
  ) {
    this.statusItem.name = 'DuckExplorer Kernel';
    this.statusItem.command = 'duckexplorer.showLog';
    this.updateStatus();
  }

  get isRunning(): boolean {
    return this.proc !== undefined && this.info !== undefined;
  }

  get kernelInfo(): KernelInfo | undefined {
    return this.info;
  }

  /** The last start failed (and was reported); background features shouldn't retry it on their own. */
  get startFailed(): boolean {
    return this.failed;
  }

  ensureStarted(): Promise<KernelInfo> {
    if (this.disposed) {
      return Promise.reject(new Error('DuckExplorer kernel is disposed'));
    }
    if (this.info && this.proc) {
      return Promise.resolve(this.info);
    }
    this.starting ??= this.start().finally(() => (this.starting = undefined));
    return this.starting;
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.ensureStarted();
    return this.send<T>(method, params);
  }

  /** Like request(), but marks the kernel busy in the status bar while it runs. */
  async execute<T>(method: string, params: Record<string, unknown>): Promise<T> {
    await this.ensureStarted();
    this.busyCount++;
    this.updateStatus();
    try {
      return await this.send<T>(method, params);
    } finally {
      this.busyCount--;
      this.updateStatus();
    }
  }

  /** Interrupts the running cell, if any. Never starts the kernel. */
  async interrupt(): Promise<void> {
    if (this.isRunning) {
      await this.send('interrupt', {}).catch(() => undefined);
    }
  }

  /** Sends settings and theme to a running kernel; a kernel that starts later gets them on startup. */
  async reconfigure(): Promise<void> {
    if (this.isRunning) {
      await this.send('configure', this.configure()).catch((err) => this.log.warn(`configure failed: ${err}`));
    }
  }

  async restart(): Promise<KernelInfo> {
    const starting = this.starting;
    this.stop();
    // A start that was in progress fails once its process is stopped; start afresh after it.
    await starting?.catch(() => undefined);
    return this.ensureStarted();
  }

  stop(): void {
    const proc = this.proc;
    this.proc = undefined;
    this.info = undefined;
    if (proc) {
      try {
        proc.stdin?.end(JSON.stringify({ id: 0, method: 'shutdown' }) + '\n');
      } catch {
        // already gone
      }
      setTimeout(() => proc.kill(), 2_000).unref();
    }
    this.rejectAll(new Error('Kernel was restarted'));
    this.updateStatus();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.statusItem.dispose();
    this.startedEmitter.dispose();
  }

  private async start(): Promise<KernelInfo> {
    const python = await resolvePython(this.log);
    const pythonDir = path.join(this.extensionPath, 'python');
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const env = {
      ...process.env,
      PYTHONPATH: [pythonDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    };
    this.log.info(`Starting kernel: ${python} -m duckexplorer_kernel (cwd ${cwd})`);
    this.statusItem.text = '$(loading~spin) DuckDB';
    this.statusItem.tooltip = `Starting the DuckExplorer kernel with ${python}`;
    this.statusItem.show();

    const proc = spawn(python, ['-m', 'duckexplorer_kernel'], { cwd, env, windowsHide: true });
    this.proc = proc;
    let stderrTail = '';

    const ready = new Promise<KernelInfo>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The kernel did not start within 60 s')), STARTUP_TIMEOUT_MS);
      let buffer = '';
      proc.stdout!.setEncoding('utf8');
      proc.stdout!.on('data', (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) {
            continue;
          }
          let message: any;
          try {
            message = JSON.parse(line);
          } catch {
            this.log.warn(`Unparseable kernel message: ${line.slice(0, 200)}`);
            continue;
          }
          if (message.method === 'ready') {
            clearTimeout(timer);
            resolve(message.params as KernelInfo);
          } else if (message.id !== undefined) {
            this.settle(message);
          }
        }
      });
      proc.stderr!.setEncoding('utf8');
      proc.stderr!.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-8_000);
        for (const line of chunk.split(/\r?\n/)) {
          if (line.trim()) {
            this.log.info(`[kernel] ${line}`);
          }
        }
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`The kernel exited during startup (code ${code ?? signal})`));
        if (this.proc === proc) {
          this.log.warn(`Kernel exited (code ${code ?? signal})`);
          this.proc = undefined;
          this.info = undefined;
          this.rejectAll(new Error('The DuckExplorer kernel stopped. Run the cell again to restart it.'));
          this.updateStatus();
        }
      });
    });

    try {
      const info = await ready;
      if (this.proc !== proc) {
        throw new Error('Kernel was restarted');
      }
      this.info = info;
      this.failed = false;
      this.log.info(
        `Kernel ready: Python ${info.python}, duckdb ${info.duckdb}, pyarrow ${info.pyarrow}, ` +
          `pandas ${info.pandas ?? '-'}, matplotlib ${info.matplotlib ?? '-'}, plotly ${info.plotly ?? '-'}`,
      );
      await this.send('configure', this.configure());
      this.updateStatus();
      this.startedEmitter.fire(info);
      return info;
    } catch (err) {
      if (this.proc !== proc) {
        throw err; // stopped or restarted while starting: nothing to report
      }
      this.proc = undefined;
      this.failed = true;
      proc.kill();
      this.updateStatus();
      this.log.error(`Kernel failed to start: ${String(err)}`);
      void reportStartupFailure(python, stderrTail || String(err));
      throw err;
    }
  }

  private send<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const proc = this.proc;
    if (!proc?.stdin) {
      return Promise.reject(new Error('The DuckExplorer kernel is not running'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      proc.stdin!.write(JSON.stringify({ id, method, params }) + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private settle(message: { id: number; result?: unknown; error?: { code: string; message: string; traceback?: string } }): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      if (message.error.traceback) {
        this.log.error(`${pending.method} failed:\n${message.error.traceback}`);
      }
      pending.reject(new KernelRequestError(message.error.message, message.error.code));
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  private updateStatus(): void {
    if (this.disposed) {
      return;
    }
    if (!this.proc) {
      this.statusItem.text = '$(database) DuckDB';
      this.statusItem.tooltip = 'DuckExplorer kernel: not running (starts when needed)';
    } else if (!this.info) {
      return; // start() shows the starting state
    } else if (this.busyCount > 0) {
      this.statusItem.text = `$(sync~spin) DuckDB ${this.info.duckdb}`;
      this.statusItem.tooltip = 'DuckExplorer kernel: running a cell';
    } else {
      this.statusItem.text = `$(database) DuckDB ${this.info.duckdb}`;
      this.statusItem.tooltip = `DuckExplorer kernel: idle\nPython ${this.info.python} (${this.info.executable})`;
    }
    this.statusItem.show();
  }
}
