import * as vscode from 'vscode';
import { KernelClient } from '../kernel/kernelProcess';
import { FrameInfo, FunctionCatalog, FunctionInfo, SchemaTree, SqlCatalogResult } from '../kernel/protocol';

/** What the kernel knows of names, as seen from one notebook. */
export interface CatalogSnapshot {
  schema: SchemaTree;
  frames: FrameInfo[];
  functions: FunctionInfo[];
  /** By lower-case name; a name can be both a function and a macro. */
  functionsByName: Map<string, FunctionInfo[]>;
  types: string[];
}

/** How long a completion waits for fresh names when it has older ones to show. */
const WAIT_CACHED_MS = 300;
/** ... and when it has none yet (the kernel may be starting). */
const WAIT_FIRST_MS = 10_000;

/**
 * The kernel's schema, functions and per-notebook DataFrames for completions. Cached, and loaded
 * again by the first completion after something that may have changed them: a cell run, an
 * attach or detach, a kernel restart.
 */
export class SqlCatalog implements vscode.Disposable {
  private schema: SchemaTree | undefined;
  private functions: FunctionCatalog | undefined;
  private functionsByName = new Map<string, FunctionInfo[]>();
  private readonly frames = new Map<string, FrameInfo[]>();
  /** Notebooks ('' for none) whose names are current. */
  private readonly fresh = new Set<string>();
  private readonly loading = new Map<string, Promise<void>>();
  private generation = 0;
  private readonly closeListener: vscode.Disposable;

  constructor(
    private readonly kernel: KernelClient,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.closeListener = vscode.workspace.onDidCloseNotebookDocument((doc) => this.frames.delete(doc.uri.toString()));
  }

  dispose(): void {
    this.closeListener.dispose();
  }

  invalidate(): void {
    this.generation++;
    this.fresh.clear();
  }

  /**
   * Names for completions in `notebook`; undefined while the kernel has never answered. Without
   * `startKernel` (a .sql file, which may not be DuckDB's at all), only a running kernel is asked.
   */
  async snapshot(notebook: string | undefined, startKernel = true): Promise<CatalogSnapshot | undefined> {
    if (!startKernel && !this.kernel.isRunning) {
      return undefined;
    }
    const key = notebook ?? '';
    if (!this.fresh.has(key)) {
      const load = this.loading.get(key) ?? this.load(key);
      // With names cached, a busy kernel (say, summarizing a large table) doesn't hold completions up.
      await Promise.race([load, delay(this.schema ? WAIT_CACHED_MS : WAIT_FIRST_MS)]);
    }
    if (!this.schema) {
      return undefined;
    }
    return {
      schema: this.schema,
      frames: this.frames.get(key) ?? [],
      functions: this.functions?.functions ?? [],
      functionsByName: this.functionsByName,
      types: this.functions?.types ?? [],
    };
  }

  private load(key: string): Promise<void> {
    const generation = this.generation;
    const promise = (async () => {
      if (!this.kernel.isRunning && this.kernel.startFailed) {
        return; // reported already; typing shouldn't start it again on every keystroke
      }
      const result = await this.kernel.request<SqlCatalogResult>('sqlCatalog', {
        notebook: key || undefined,
        functionsVersion: this.functions?.version,
      });
      this.schema = result.schema;
      this.frames.set(key, result.frames);
      if (result.functions) {
        this.functions = result.functions;
        this.functionsByName = new Map();
        for (const fn of result.functions.functions) {
          const name = fn.name.toLowerCase();
          this.functionsByName.set(name, [...(this.functionsByName.get(name) ?? []), fn]);
        }
      }
      if (generation === this.generation) {
        this.fresh.add(key);
      }
    })()
      .catch((err) => this.log.warn(`Could not load names for SQL completions: ${(err as Error).message}`))
      .finally(() => {
        if (this.loading.get(key) === promise) {
          this.loading.delete(key);
        }
      });
    this.loading.set(key, promise);
    return promise;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
