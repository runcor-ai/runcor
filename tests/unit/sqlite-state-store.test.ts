// Unit tests for SQLiteStateStore
// Phase 7: T038 (serialization edge cases), T039 (close behavior), T040 (orphan recovery)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteStateStore } from '../../src/sqlite-state-store.js';
import type { Execution } from '../../src/execution.js';
import type { ExecutionState } from '../../src/types.js';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'runcor-sqlite-unit-'));
  dbPath = join(tempDir, 'test.db');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Create a minimal test execution with overrides */
function makeExecution(overrides: Partial<Execution> = {}): Execution {
  const now = new Date();
  return {
    id: 'test-id',
    flowName: 'test-flow',
    idempotencyKey: 'test-idem',
    state: 'complete' as ExecutionState,
    input: { key: 'value' },
    result: { output: 'done' },
    error: null,
    retryCount: 0,
    timestamps: {
      queued: new Date(now.getTime() - 3000),
      started: new Date(now.getTime() - 2000),
      completed: now,
      transitions: [
        { from: 'queued' as ExecutionState, to: 'running' as ExecutionState, at: new Date(now.getTime() - 2000) },
        { from: 'running' as ExecutionState, to: 'complete' as ExecutionState, at: now },
      ],
    },
    waitContext: null,
    resumeData: null,
    replayOf: null,
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Serialization edge cases
// ══════════════════════════════════════════════════════════════════════════════

describe('T038: Serialization edge cases', () => {
  it('roundtrips null input correctly', async () => {
    const store = new SQLiteStateStore({ path: dbPath });
    const exec = makeExecution({ input: null });
    await store.set(exec);

    const restored = await store.get('test-id');
    expect(restored).not.toBeNull();
    expect(restored!.input).toBeNull();
    await store.close();
  });

  it('roundtrips deeply nested result object', async () => {
    const deepResult = {
      level1: {
        level2: {
          level3: {
            level4: {
              values: [1, 'two', true, null, { nested: [3.14] }],
            },
          },
        },
      },
    };

    const store = new SQLiteStateStore({ path: dbPath });
    const exec = makeExecution({ result: deepResult });
    await store.set(exec);

    const restored = await store.get('test-id');
    expect(restored).not.toBeNull();
    expect(restored!.result).toEqual(deepResult);
    await store.close();
  });

  it('roundtrips execution with all nullable fields null', async () => {
    const store = new SQLiteStateStore({ path: dbPath });
    const exec = makeExecution({
      input: null,
      result: null,
      error: null,
      waitContext: null,
      resumeData: null,
      replayOf: null,
      timestamps: {
        queued: new Date('2026-03-01T00:00:00.000Z'),
        started: null,
        completed: null,
        transitions: [],
      },
    });
    await store.set(exec);

    const restored = await store.get('test-id');
    expect(restored).not.toBeNull();
    expect(restored!.input).toBeNull();
    expect(restored!.result).toBeNull();
    expect(restored!.error).toBeNull();
    expect(restored!.waitContext).toBeNull();
    expect(restored!.resumeData).toBeNull();
    expect(restored!.replayOf).toBeNull();
    expect(restored!.timestamps.started).toBeNull();
    expect(restored!.timestamps.completed).toBeNull();
    expect(restored!.timestamps.transitions).toEqual([]);
    await store.close();
  });

  it('roundtrips execution with all fields populated including Date fields', async () => {
    const store = new SQLiteStateStore({ path: dbPath, retentionPeriod: 0 });
    const exec = makeExecution({
      input: { data: 'input-value' },
      result: { data: 'result-value' },
      error: { message: 'test error', code: 'TEST_ERR', retryable: false, retryCount: 2, stack: 'Error\n  at test' },
      retryCount: 2,
      waitContext: {
        reason: 'test-wait',
        expectedResumeBy: new Date('2026-06-01T00:00:00.000Z'),
        waitData: { key: 'wait-value' },
        waitingSince: new Date('2026-03-15T12:00:00.000Z'),
      },
      resumeData: { approved: true, tags: ['a', 'b'] },
      replayOf: 'orig-exec-123',
      timestamps: {
        queued: new Date('2026-03-01T00:00:00.000Z'),
        started: new Date('2026-03-01T00:00:01.000Z'),
        completed: new Date('2026-03-01T00:00:05.000Z'),
        transitions: [
          { from: 'queued' as ExecutionState, to: 'running' as ExecutionState, at: new Date('2026-03-01T00:00:01.000Z') },
          { from: 'running' as ExecutionState, to: 'waiting' as ExecutionState, at: new Date('2026-03-01T00:00:02.000Z') },
          { from: 'waiting' as ExecutionState, to: 'running' as ExecutionState, at: new Date('2026-03-01T00:00:03.000Z') },
          { from: 'running' as ExecutionState, to: 'complete' as ExecutionState, at: new Date('2026-03-01T00:00:05.000Z') },
        ],
      },
    });
    await store.set(exec);

    const restored = await store.get('test-id');
    expect(restored).not.toBeNull();

    // All scalar fields
    expect(restored!.id).toBe('test-id');
    expect(restored!.flowName).toBe('test-flow');
    expect(restored!.idempotencyKey).toBe('test-idem');
    expect(restored!.state).toBe('complete');
    expect(restored!.retryCount).toBe(2);
    expect(restored!.replayOf).toBe('orig-exec-123');

    // JSON fields
    expect(restored!.input).toEqual({ data: 'input-value' });
    expect(restored!.result).toEqual({ data: 'result-value' });
    expect(restored!.error).toEqual({ message: 'test error', code: 'TEST_ERR', retryable: false, retryCount: 2, stack: 'Error\n  at test' });
    expect(restored!.resumeData).toEqual({ approved: true, tags: ['a', 'b'] });

    // Timestamp Dates
    expect(restored!.timestamps.queued).toEqual(new Date('2026-03-01T00:00:00.000Z'));
    expect(restored!.timestamps.queued).toBeInstanceOf(Date);
    expect(restored!.timestamps.started).toEqual(new Date('2026-03-01T00:00:01.000Z'));
    expect(restored!.timestamps.started).toBeInstanceOf(Date);
    expect(restored!.timestamps.completed).toEqual(new Date('2026-03-01T00:00:05.000Z'));
    expect(restored!.timestamps.completed).toBeInstanceOf(Date);

    // Transitions with Date reconstruction
    expect(restored!.timestamps.transitions).toHaveLength(4);
    expect(restored!.timestamps.transitions[0].at).toEqual(new Date('2026-03-01T00:00:01.000Z'));
    expect(restored!.timestamps.transitions[0].at).toBeInstanceOf(Date);
    expect(restored!.timestamps.transitions[3].at).toEqual(new Date('2026-03-01T00:00:05.000Z'));

    // WaitContext with Date reconstruction
    expect(restored!.waitContext).not.toBeNull();
    expect(restored!.waitContext!.reason).toBe('test-wait');
    expect(restored!.waitContext!.expectedResumeBy).toEqual(new Date('2026-06-01T00:00:00.000Z'));
    expect(restored!.waitContext!.expectedResumeBy).toBeInstanceOf(Date);
    expect(restored!.waitContext!.waitingSince).toEqual(new Date('2026-03-15T12:00:00.000Z'));
    expect(restored!.waitContext!.waitingSince).toBeInstanceOf(Date);
    expect(restored!.waitContext!.waitData).toEqual({ key: 'wait-value' });

    await store.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// close() behavior
// ══════════════════════════════════════════════════════════════════════════════

describe('T039: close() behavior', () => {
  it('close() is idempotent — calling twice does not throw', async () => {
    const store = new SQLiteStateStore({ path: dbPath });
    await store.close();
    await store.close(); // Second call should be a no-op
  });

  it('get() throws after close()', async () => {
    const store = new SQLiteStateStore({ path: dbPath });
    await store.close();
    await expect(store.get('any-id')).rejects.toThrow('Database is closed');
  });

  it('getByIdempotencyKey() throws after close()', async () => {
    const store = new SQLiteStateStore({ path: dbPath });
    await store.close();
    await expect(store.getByIdempotencyKey('any-key')).rejects.toThrow('Database is closed');
  });

  it('set() throws after close()', async () => {
    const store = new SQLiteStateStore({ path: dbPath });
    await store.close();
    await expect(store.set(makeExecution())).rejects.toThrow('Database is closed');
  });

  it('list() throws after close()', async () => {
    const store = new SQLiteStateStore({ path: dbPath });
    await store.close();
    await expect(store.list()).rejects.toThrow('Database is closed');
  });

  it('delete() throws after close()', async () => {
    const store = new SQLiteStateStore({ path: dbPath });
    await store.close();
    await expect(store.delete('any-id')).rejects.toThrow('Database is closed');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Orphan recovery
// ══════════════════════════════════════════════════════════════════════════════

describe('T040: Orphan recovery', () => {
  /** Seed orphaned executions into a fresh database, then close it */
  async function seedOrphans(
    path: string,
    states: ExecutionState[] = ['running', 'retrying', 'queued'],
  ): Promise<void> {
    const store = new SQLiteStateStore({ path });
    for (let i = 0; i < states.length; i++) {
      await store.set(makeExecution({
        id: `orphan-${i}`,
        idempotencyKey: `orphan-idem-${i}`,
        state: states[i],
        timestamps: {
          queued: new Date(Date.now() - 5000),
          started: states[i] !== 'queued' ? new Date(Date.now() - 4000) : null,
          completed: null,
          transitions: [],
        },
      }));
    }
    // Force-close the database without proper cleanup (simulates process kill)
    // We access the private db field to bypass close() which sets the closed flag
    (store as any).db.close();
  }

  it('default behavior: orphaned executions transition to failed', async () => {
    await seedOrphans(dbPath);

    // Reopen without callback — default is 'fail'
    const store = new SQLiteStateStore({ path: dbPath });

    for (let i = 0; i < 3; i++) {
      const exec = await store.get(`orphan-${i}`);
      expect(exec).not.toBeNull();
      expect(exec!.state).toBe('failed');
      expect(exec!.error).not.toBeNull();
      expect(exec!.error!.message).toBe('Process terminated');
      expect(exec!.error!.code).toBe('PROCESS_TERMINATED');
    }

    await store.close();
  });

  it('callback returning "requeue" transitions orphans to queued', async () => {
    await seedOrphans(dbPath, ['running']);

    const store = new SQLiteStateStore({
      path: dbPath,
      onOrphanedExecution: () => 'requeue',
    });

    const exec = await store.get('orphan-0');
    expect(exec).not.toBeNull();
    expect(exec!.state).toBe('queued');
    // Error should NOT be set for requeued
    expect(exec!.error).toBeNull();

    await store.close();
  });

  it('callback returning "ignore" leaves orphans unchanged', async () => {
    await seedOrphans(dbPath, ['running', 'retrying']);

    const store = new SQLiteStateStore({
      path: dbPath,
      onOrphanedExecution: () => 'ignore',
    });

    const exec0 = await store.get('orphan-0');
    expect(exec0).not.toBeNull();
    expect(exec0!.state).toBe('running');

    const exec1 = await store.get('orphan-1');
    expect(exec1).not.toBeNull();
    expect(exec1!.state).toBe('retrying');

    await store.close();
  });

  it('callback that throws falls back to "fail"', async () => {
    await seedOrphans(dbPath, ['running']);

    const store = new SQLiteStateStore({
      path: dbPath,
      onOrphanedExecution: () => {
        throw new Error('Callback error');
      },
    });

    const exec = await store.get('orphan-0');
    expect(exec).not.toBeNull();
    expect(exec!.state).toBe('failed');
    expect(exec!.error).not.toBeNull();
    expect(exec!.error!.message).toBe('Process terminated');
    expect(exec!.error!.code).toBe('PROCESS_TERMINATED');

    await store.close();
  });
});
