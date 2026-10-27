import { KernelClient, KernelRequestError } from '../kernel/kernelProcess';
import { RendererRequest, RendererResponse } from '../kernel/protocol';

/** Kernel methods a results grid may call (all served on the kernel's side thread). */
const KERNEL_METHODS = new Set<string>(['fetchPage', 'profileResult', 'filterSql'] satisfies RendererRequest['type'][]);

export type InsertFilteredCell = Extract<RendererRequest, { type: 'insertFilteredCell' }>;

export function isGridRequest(message: unknown): message is RendererRequest {
  const type = (message as RendererRequest | undefined)?.type;
  return type !== undefined && (KERNEL_METHODS.has(type) || type === 'insertFilteredCell');
}

/**
 * Answers a results grid, in a notebook output or the summary panel: kernel methods go to the kernel,
 * and `insertFilteredCell` to the caller, which knows where the new cell belongs.
 */
export async function answerGridRequest(
  kernel: KernelClient,
  message: RendererRequest,
  insertFilteredCell: (request: InsertFilteredCell) => Promise<{}>,
): Promise<RendererResponse> {
  const { type, requestId, ...params } = message;
  if (!kernel.isRunning) {
    // Outputs from a previous session (or a reopened file): don't start a kernel just to say so.
    return { type: 'response', requestId, error: 'expired' };
  }
  try {
    const result = message.type === 'insertFilteredCell' ? await insertFilteredCell(message) : await kernel.request(type, params);
    return { type: 'response', requestId, result };
  } catch (err) {
    const expired = err instanceof KernelRequestError && err.code === 'expired';
    return { type: 'response', requestId, error: expired ? 'expired' : (err as Error).message };
  }
}
