// Integration tests for SQLiteStateStore
// Covers User Stories 1, 2, 3 — persistence, wait/resume, schema migration

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SQLiteStateStore } from '../../src/sqlite-state-store.js';
import { createEngine, type Runcor } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import type { Execution } from '../../src/execution.js';
import type { ExecutionState, WaitContext } from '../../src/types.js';

// -- Helpers --

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'runcor-sqlite-test-'));
  dbPath = join(tempDir, 'test.db');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Create a fully populated test execution */
function createTestExecution(overrides: Partial<Execution> = {}): Execution {
  const now = new Date();
  return {
    id: 'exec-001',
    flowName: 'test-flow',
    idempotencyKey: 'idem-001',
    state: 'complete' as ExecutionState,
    input: { name: 'Alice', count: 42 },
    result: { greeting: 'Hello, Alice!' },
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
// User Story 1: Persistent Execution State
// ══════════════════════════════════════════════════════════════════════════════

describe('US1: Persistent Execution State', () => {
  // T016: Persist and retrieve execution with all fields across close/reopen
  it('persists and retrieves execution with all fields intact across restart', async () => {
    const exec = createTestExecution({
      input: { nested: { deep: [1, 2, 3] } },
      result: { computed: true, values: ['a', 'b'] },
      error: null,
      waitContext: {
        reason: 'awaiting approval',
        expectedResumeBy: new Date('2026-04-01T00:00:00.000Z'),
        waitData: { approver: 'boss' },
        waitingSince: new Date('2026-03-01T10:00:00.000Z'),
      },
      resumeData: { approved: true },
      replayOf: 'original-exec-id',
      state: 'complete',
    });

    // Write and close
    const store1 = new SQLiteStateStore({ path: dbPath });
    await store1.set(exec);
    await store1.close();

    // Reopen and read
    const store2 = new SQLiteStateStore({ path: dbPath });
    const restored = await store2.get('exec-001');
    await store2.close();

    expect(restored).not.toBeNull();
    expect(restored!.id).toBe(exec.id);
    expect(restored!.flowName).toBe(exec.flowName);
    expect(restored!.idempotencyKey).toBe(exec.idempotencyKey);
    expect(restored!.state).toBe(exec.state);
    expect(restored!.retryCount).toBe(exec.retryCount);
    expect(restored!.replayOf).toBe(exec.replayOf);

    // Deep equality for JSON-serialized fields
    expect(restored!.input).toEqual(exec.input);
    expect(restored!.result).toEqual(exec.result);
    expect(restored!.resumeData).toEqual(exec.resumeData);

    // Date field reconstruction
    expect(restored!.timestamps.queued).toEqual(exec.timestamps.queued);
    expect(restored!.timestamps.started).toEqual(exec.timestamps.started);
    expect(restored!.timestamps.completed).toEqual(exec.timestamps.completed);
    expect(restored!.timestamps.transitions).toHaveLength(2);
    expect(restored!.timestamps.transitions[0].at).toEqual(exec.timestamps.transitions[0].at);
    expect(restored!.timestamps.transitions[1].at).toEqual(exec.timestamps.transitions[1].at);

    // WaitContext Date reconstruction
    expect(restored!.waitContext).not.toBeNull();
    expect(restored!.waitContext!.reason).toBe('awaiting approval');
    expect(restored!.waitContext!.expectedResumeBy).toEqual(new Date('2026-04-01T00:00:00.000Z'));
    expect(restored!.waitContext!.waitingSince).toEqual(new Date('2026-03-01T10:00:00.000Z'));
    expect(restored!.waitContext!.waitData).toEqual({ approver: 'boss' });

    // Verify they are Date instances
    expect(restored!.timestamps.queued).toBeInstanceOf(Date);
    expect(restored!.timestamps.transitions[0].at).toBeInstanceOf(Date);
    expect(restored!.waitContext!.waitingSince).toBeInstanceOf(Date);
  });

  // T017: Idempotency key deduplication
  it('getByIdempotencyKey returns the latest execution for a key', async () => {
    const exec1 = createTestExecution({ id: 'exec-A', idempotencyKey: 'shared-key' });
    const exec2 = createTestExecution({ id: 'exec-B', idempotencyKey: 'shared-key', result: { updated: true } });

    const store = new SQLiteStateStore({ path: dbPath });
    await store.set(exec1);
    await store.set(exec2);

    // idempotencyKey is UNIQUE — INSERT OR REPLACE means exec2 replaces exec1
    const found = await store.getByIdempotencyKey('shared-key');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('exec-B');
    expect(found!.result).toEqual({ updated: true });
    await store.close();
  });

  // T018: List filtering by state and flowName
  it('list() filters by state and flowName correctly', async () => {
    const store = new SQLiteStateStore({ path: dbPath });

    await store.set(createTestExecution({ id: 'e1', idempotencyKey: 'k1', state: 'complete', flowName: 'flow-a' }));
    await store.set(createTestExecution({ id: 'e2', idempotencyKey: 'k2', state: 'failed', flowName: 'flow-a' }));
    await store.set(createTestExecution({ id: 'e3', idempotencyKey: 'k3', state: 'complete', flowName: 'flow-b' }));
    await store.set(createTestExecution({ id: 'e4', idempotencyKey: 'k4', state: 'running', flowName: 'flow-b' }));

    // Filter by state
    const completed = await store.list({ state: 'complete' });
    expect(completed).toHaveLength(2);
    expect(completed.map((e) => e.id).sort()).toEqual(['e1', 'e3']);

    // Filter by flowName
    const flowA = await store.list({ flowName: 'flow-a' });
    expect(flowA).toHaveLength(2);
    expect(flowA.map((e) => e.id).sort()).toEqual(['e1', 'e2']);

    // Filter by both
    const completedFlowB = await store.list({ state: 'complete', flowName: 'flow-b' });
    expect(completedFlowB).toHaveLength(1);
    expect(completedFlowB[0].id).toBe('e3');

    // No filter
    const all = await store.list();
    expect(all).toHaveLength(4);

    await store.close();
  });

  // T019: Auto-create database file
  it('creates database file at non-existent path', async () => {
    const newPath = join(tempDir, 'subdir', 'new.db');
    // The parent directory must exist for better-sqlite3
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(tempDir, 'subdir'), { recursive: true });

    const store = new SQLiteStateStore({ path: newPath });
    const exec = createTestExecution();
    await store.set(exec);

    const retrieved = await store.get('exec-001');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe('exec-001');

    const all = await store.list();
    expect(all).toHaveLength(1);

    await store.close();
  });

  // T020: Delete persists across close/reopen
  it('delete persists across close/reopen cycle', async () => {
    const store1 = new SQLiteStateStore({ path: dbPath });
    await store1.set(createTestExecution());
    await store1.delete('exec-001');

    const afterDelete = await store1.get('exec-001');
    expect(afterDelete).toBeNull();
    await store1.close();

    // Verify persistence of delete
    const store2 = new SQLiteStateStore({ path: dbPath });
    const afterReopen = await store2.get('exec-001');
    expect(afterReopen).toBeNull();
    await store2.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// User Story 2: Resume After Process Kill
// ══════════════════════════════════════════════════════════════════════════════

describe('US2: Resume After Process Kill', () => {
  // T021: Waiting state with full waitContext survives restart
  it('preserves waiting state with all waitContext Date fields across restart', async () => {
    const waitContext: WaitContext = {
      reason: 'Waiting for manager approval',
      expectedResumeBy: new Date('2026-03-15T12:00:00.000Z'),
      waitData: { requestId: 'req-42', priority: 'high' },
      waitingSince: new Date('2026-03-01T08:30:00.000Z'),
    };

    const exec = createTestExecution({
      id: 'wait-exec',
      idempotencyKey: 'wait-key',
      state: 'waiting',
      result: null,
      timestamps: {
        queued: new Date('2026-03-01T08:00:00.000Z'),
        started: new Date('2026-03-01T08:00:01.000Z'),
        completed: null,
        transitions: [
          { from: 'queued' as ExecutionState, to: 'running' as ExecutionState, at: new Date('2026-03-01T08:00:01.000Z') },
          { from: 'running' as ExecutionState, to: 'waiting' as ExecutionState, at: new Date('2026-03-01T08:30:00.000Z') },
        ],
      },
      waitContext,
    });

    const store1 = new SQLiteStateStore({ path: dbPath });
    await store1.set(exec);
    await store1.close();

    // Reopen — waiting state is NOT orphaned because we use the onOrphanedExecution to ignore
    const store2 = new SQLiteStateStore({
      path: dbPath,
      onOrphanedExecution: () => 'ignore',
    });
    const restored = await store2.get('wait-exec');
    await store2.close();

    expect(restored).not.toBeNull();
    expect(restored!.state).toBe('waiting');
    expect(restored!.waitContext).not.toBeNull();
    expect(restored!.waitContext!.reason).toBe('Waiting for manager approval');
    expect(restored!.waitContext!.expectedResumeBy).toEqual(new Date('2026-03-15T12:00:00.000Z'));
    expect(restored!.waitContext!.expectedResumeBy).toBeInstanceOf(Date);
    expect(restored!.waitContext!.waitingSince).toEqual(new Date('2026-03-01T08:30:00.000Z'));
    expect(restored!.waitContext!.waitingSince).toBeInstanceOf(Date);
    expect(restored!.waitContext!.waitData).toEqual({ requestId: 'req-42', priority: 'high' });
  });

  // T022: ResumeData preserved across restart
  it('preserves resumeData across restart', async () => {
    const exec = createTestExecution({
      id: 'resume-exec',
      idempotencyKey: 'resume-key',
      state: 'waiting',
      result: null,
      resumeData: { approved: true, notes: 'Budget approved by VP' },
      timestamps: {
        queued: new Date('2026-03-01T08:00:00.000Z'),
        started: new Date('2026-03-01T08:00:01.000Z'),
        completed: null,
        transitions: [],
      },
    });

    const store1 = new SQLiteStateStore({ path: dbPath });
    await store1.set(exec);
    await store1.close();

    const store2 = new SQLiteStateStore({
      path: dbPath,
      onOrphanedExecution: () => 'ignore',
    });
    const restored = await store2.get('resume-exec');
    await store2.close();

    expect(restored).not.toBeNull();
    expect(restored!.resumeData).toEqual({ approved: true, notes: 'Budget approved by VP' });
  });

  // T023: replayOf preserved across restart
  it('preserves replayOf field across restart', async () => {
    const original = createTestExecution({ id: 'original-exec', idempotencyKey: 'orig-key' });
    const replay = createTestExecution({
      id: 'replay-exec',
      idempotencyKey: 'replay-key',
      replayOf: 'original-exec',
    });

    const store1 = new SQLiteStateStore({ path: dbPath });
    await store1.set(original);
    await store1.set(replay);
    await store1.close();

    const store2 = new SQLiteStateStore({ path: dbPath });
    const restoredReplay = await store2.get('replay-exec');
    const restoredOriginal = await store2.get('original-exec');
    await store2.close();

    expect(restoredReplay).not.toBeNull();
    expect(restoredReplay!.replayOf).toBe('original-exec');
    expect(restoredOriginal).not.toBeNull();
    expect(restoredOriginal!.id).toBe('original-exec');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// User Story 3: Schema Migration
// ══════════════════════════════════════════════════════════════════════════════

describe('US3: Schema Migration', () => {
  // T024: PRAGMA user_version is set after creation
  it('sets PRAGMA user_version to 2 on new database', async () => {
    const store = new SQLiteStateStore({ path: dbPath });
    await store.close();

    // Verify with raw better-sqlite3
    const rawDb = new Database(dbPath);
    const version = rawDb.pragma('user_version', { simple: true });
    rawDb.close();

    expect(version).toBe(2);
  });

  // T025: Data intact after reopen, no re-migration
  it('preserves data after reopen without re-running migration', async () => {
    const store1 = new SQLiteStateStore({ path: dbPath });
    await store1.set(createTestExecution());
    await store1.close();

    const store2 = new SQLiteStateStore({ path: dbPath });
    const exec = await store2.get('exec-001');
    await store2.close();

    expect(exec).not.toBeNull();
    expect(exec!.id).toBe('exec-001');

    // Verify version still 2
    const rawDb = new Database(dbPath);
    const version = rawDb.pragma('user_version', { simple: true });
    rawDb.close();
    expect(version).toBe(2);
  });

  // T026: Existing v1 database with data opens cleanly
  it('opens existing v1 database with data without errors', async () => {
    // Manually create a v1 database using raw better-sqlite3
    const rawDb = new Database(dbPath);
    rawDb.pragma('journal_mode = WAL');
    rawDb.exec(`
      CREATE TABLE executions (
        id TEXT PRIMARY KEY,
        flow_name TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        input TEXT,
        result TEXT,
        error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        ts_queued INTEGER NOT NULL,
        ts_started INTEGER,
        ts_completed INTEGER,
        transitions TEXT NOT NULL DEFAULT '[]',
        wait_context TEXT,
        resume_data TEXT,
        replay_of TEXT
      );
      CREATE INDEX idx_idempotency_key ON executions (idempotency_key);
      CREATE INDEX idx_state ON executions (state);
      CREATE INDEX idx_flow_name ON executions (flow_name);
      CREATE INDEX idx_state_completed ON executions (state, ts_completed);
    `);
    rawDb.pragma('user_version = 1');

    // Insert a row manually
    const now = Date.now();
    rawDb.prepare(`
      INSERT INTO executions (id, flow_name, idempotency_key, state, input, retry_count, ts_queued, ts_completed, transitions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('manual-exec', 'manual-flow', 'manual-key', 'complete', '"hello"', 0, now - 1000, now, '[]');
    rawDb.close();

    // Open with SQLiteStateStore — should migrate v1 → v2 (adds user_id column)
    const store = new SQLiteStateStore({ path: dbPath });
    const exec = await store.get('manual-exec');
    await store.close();

    expect(exec).not.toBeNull();
    expect(exec!.id).toBe('manual-exec');
    expect(exec!.flowName).toBe('manual-flow');
    expect(exec!.input).toBe('hello');
    expect(exec!.state).toBe('complete');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// User Story 4: Configuration and Fallback
// ══════════════════════════════════════════════════════════════════════════════

describe('US4: Configuration and Fallback', () => {
  // T032: No state config → InMemoryStateStore (backward compatible)
  it('uses InMemoryStateStore when no state config is provided', async () => {
    const provider = new MockProvider();
    provider.queueResponses([{ content: 'hello' }]);

    const engine = await createEngine({
      model: { provider },
    });

    engine.register('test', async (ctx) => ctx.input);

    const exec = await engine.trigger('test', {
      idempotencyKey: 'compat-001',
      input: 'works',
    });

    // Wait for completion
    await new Promise<void>((resolve) => {
      const check = setInterval(async () => {
        const e = await engine.getExecution(exec.id);
        if (e && (e.state === 'complete' || e.state === 'failed')) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    const result = await engine.getExecution(exec.id);
    expect(result).not.toBeNull();
    expect(result!.state).toBe('complete');
    await engine.shutdown();
  });

  // T033: SQLite config → persistence across engine restarts
  it('persists execution across engine restart with SQLite config', async () => {
    const provider = new MockProvider();
    provider.queueResponses([{ content: 'persisted-result' }]);

    const engine1 = await createEngine({
      model: { provider },
      state: { type: 'sqlite', path: dbPath },
    });

    engine1.register('persist-flow', async () => 'persisted-result');

    const exec = await engine1.trigger('persist-flow', {
      idempotencyKey: 'persist-001',
      input: 'test-input',
    });

    // Wait for completion
    await new Promise<void>((resolve) => {
      const check = setInterval(async () => {
        const e = await engine1.getExecution(exec.id);
        if (e && (e.state === 'complete' || e.state === 'failed')) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    await engine1.shutdown();

    // Second engine instance — same database
    const provider2 = new MockProvider();
    const engine2 = await createEngine({
      model: { provider: provider2 },
      state: { type: 'sqlite', path: dbPath },
    });

    const restored = await engine2.getExecution(exec.id);
    expect(restored).not.toBeNull();
    expect(restored!.state).toBe('complete');
    expect(restored!.result).toBe('persisted-result');

    await engine2.shutdown();
  });

  // T034: Invalid path → clear error
  it('throws clear error for invalid SQLite path', async () => {
    const provider = new MockProvider();

    await expect(
      createEngine({
        model: { provider },
        state: { type: 'sqlite', path: '/nonexistent/readonly/path.db' },
      }),
    ).rejects.toThrow();
  });

  // T041: Orphan recovery with engine
  it('recovers orphaned running execution as failed after unclean shutdown', async () => {
    const provider = new MockProvider();
    provider.queueResponses([{ content: 'test' }]);

    // Create engine with SQLite, register a flow that will be "running"
    const engine1 = await createEngine({
      model: { provider },
      state: { type: 'sqlite', path: dbPath },
    });

    // Shut down engine1 cleanly first — this ensures the schema exists
    await engine1.shutdown();

    // Now insert a "running" execution directly via raw DB (simulating process kill mid-execution)
    const rawDb = new Database(dbPath);
    const now = Date.now();
    rawDb.prepare(`
      INSERT INTO executions (id, flow_name, idempotency_key, state, input, retry_count, ts_queued, ts_started, transitions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('orphan-engine-exec', 'some-flow', 'orphan-engine-key', 'running', '"test-input"', 0, now - 5000, now - 4000, '[]');
    rawDb.close();

    // Reopen engine — orphan recovery should fire in SQLiteStateStore constructor
    const provider2 = new MockProvider();
    const engine2 = await createEngine({
      model: { provider: provider2 },
      state: { type: 'sqlite', path: dbPath },
    });

    const recovered = await engine2.getExecution('orphan-engine-exec');
    expect(recovered).not.toBeNull();
    expect(recovered!.state).toBe('failed');
    expect(recovered!.error).not.toBeNull();
    expect(recovered!.error!.message).toBe('Process terminated');
    expect(recovered!.error!.code).toBe('PROCESS_TERMINATED');

    await engine2.shutdown();
  });

  // T035: Retention eviction with SQLite
  it('evicts terminal executions older than retention period', async () => {
    // Create store with 1-second retention
    const store = new SQLiteStateStore({ path: dbPath, retentionPeriod: 1 });

    // Set execution with old completed timestamp
    const exec = createTestExecution({
      id: 'old-exec',
      idempotencyKey: 'old-key',
      state: 'complete',
      timestamps: {
        queued: new Date(Date.now() - 5000),
        started: new Date(Date.now() - 4000),
        completed: new Date(Date.now() - 3000), // 3 seconds ago → older than 1s retention
        transitions: [],
      },
    });
    await store.set(exec);

    // Set a fresh execution
    const fresh = createTestExecution({
      id: 'fresh-exec',
      idempotencyKey: 'fresh-key',
      state: 'complete',
    });
    await store.set(fresh);

    // Trigger eviction via a read
    const all = await store.list();

    // Old exec should be evicted, fresh should remain
    expect(all.find((e) => e.id === 'old-exec')).toBeUndefined();
    expect(all.find((e) => e.id === 'fresh-exec')).toBeDefined();

    await store.close();
  });
});
