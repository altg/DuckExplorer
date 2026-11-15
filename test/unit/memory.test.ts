import * as assert from 'assert';
import { formatBytes, memoryLabel, memoryLines } from '../../src/kernel/memory';
import type { MemoryInfo } from '../../src/kernel/protocol';

const MB = 1024 ** 2;

function info(overrides: Partial<MemoryInfo> = {}): MemoryInfo {
  return {
    processBytes: 612 * MB,
    results: { bytes: 498 * MB, count: 2, largestBytes: 400 * MB, limitBytes: 1024 * MB },
    duckdbBytes: 0,
    duckdbLimit: '12.5 GiB',
    ...overrides,
  };
}

suite('memory indicator', () => {
  test('sizes in MB, and GB from 1,024 MB', () => {
    assert.strictEqual(formatBytes(0), '0 MB');
    assert.strictEqual(formatBytes(1000), '<1 MB');
    assert.strictEqual(formatBytes(1.4 * MB), '1 MB');
    assert.strictEqual(formatBytes(1023 * MB), '1,023 MB');
    assert.strictEqual(formatBytes(1024 * MB), '1.0 GB');
    assert.strictEqual(formatBytes(2.25 * 1024 * MB), '2.3 GB');
  });

  test('the label is the process memory, else the kept results', () => {
    assert.strictEqual(memoryLabel(info()), '612 MB');
    assert.strictEqual(memoryLabel(info({ processBytes: null })), '498 MB');
  });

  test('the tooltip lines', () => {
    assert.deepStrictEqual(memoryLines(info()), [
      'Memory: **612 MB** (the kernel process)',
      'Query results: 498 MB of 1.0 GB (2 results, largest 400 MB)',
      'DuckDB buffers: 0 MB of 12.5 GiB (memory_limit)',
    ]);
    const bare = info({
      processBytes: null,
      results: { bytes: 0, count: 0, largestBytes: 0, limitBytes: 0 },
      duckdbBytes: null,
      duckdbLimit: null,
    });
    assert.deepStrictEqual(memoryLines(bare), ['Query results: 0 MB, no limit (none kept)']);
  });
});
