import * as vscode from 'vscode';
import { KernelOutput, OutputUpdate, PLOTLY_MIME, TABLE_MIME, VEGALITE_MIME } from '../kernel/protocol';

export function toCellOutput(output: KernelOutput): vscode.NotebookCellOutput {
  switch (output.type) {
    case 'stream':
      return new vscode.NotebookCellOutput([streamItem(output.name, output.text)]);
    case 'text':
      return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(output.text)]);
    case 'html':
      return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(output.html, 'text/html')]);
    case 'table':
      return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.json(output.table, TABLE_MIME)]);
    case 'png':
      return new vscode.NotebookCellOutput([new vscode.NotebookCellOutputItem(Buffer.from(output.data, 'base64'), 'image/png')]);
    case 'plotly':
      return new vscode.NotebookCellOutput([new vscode.NotebookCellOutputItem(Buffer.from(output.json, 'utf8'), PLOTLY_MIME)]);
    case 'vegalite':
      return new vscode.NotebookCellOutput([new vscode.NotebookCellOutputItem(Buffer.from(output.json, 'utf8'), VEGALITE_MIME)]);
  }
}

export function errorOutput(name: string, message: string, stack?: string): vscode.NotebookCellOutput {
  return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error({ name, message, stack })]);
}

function streamItem(name: 'stdout' | 'stderr', text: string): vscode.NotebookCellOutputItem {
  return name === 'stderr' ? vscode.NotebookCellOutputItem.stderr(text) : vscode.NotebookCellOutputItem.stdout(text);
}

/**
 * A running cell's outputs as the kernel streams them: each one shows as soon as it is made, and a
 * stream's text as it is written. finish() then leaves the cell with the outputs the kernel made, as
 * if they had come at once (a stream written in pieces becomes one item, as it is saved).
 */
export class LiveOutputs {
  /** The kernel's outputs so far. */
  readonly outputs: KernelOutput[] = [];
  private readonly shown: vscode.NotebookCellOutput[] = [];
  private readonly pieces: number[] = [];
  /** The execution's edits, in the order the updates came. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly execution: vscode.NotebookCellExecution) {}

  update(update: OutputUpdate): void {
    const { index } = update;
    if ('output' in update) {
      if (index < this.outputs.length) return; // already shown
      const output = update.output;
      const cellOutput = toCellOutput(output);
      this.outputs[index] = output;
      this.shown[index] = cellOutput;
      this.pieces[index] = 1;
      this.enqueue(() => this.execution.appendOutput(cellOutput));
      return;
    }
    const output = this.outputs[index];
    if (output?.type !== 'stream') return;
    output.text += update.text;
    this.pieces[index]++;
    const item = streamItem(output.name, update.text);
    this.enqueue(() => this.execution.appendOutputItems(item, this.shown[index]));
  }

  /** After the reply: merges the pieces of each stream, then appends `extra` (an error). */
  async finish(extra: vscode.NotebookCellOutput[] = []): Promise<void> {
    await this.queue;
    for (const [index, output] of this.outputs.entries()) {
      if (output.type === 'stream' && this.pieces[index] > 1) {
        await this.execution.replaceOutputItems(streamItem(output.name, output.text), this.shown[index]);
      }
    }
    if (extra.length) await this.execution.appendOutput(extra);
  }

  private enqueue(edit: () => Thenable<void>): void {
    // A failed edit (the cell was deleted, say) doesn't stop the ones after it.
    this.queue = this.queue.then(edit).then(undefined, () => undefined);
  }
}
