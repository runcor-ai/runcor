// SQLiteStateStore — persistent StateStore using better-sqlite3

import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import type { StateStore } from './state-store.js';
import type { Execution } from './execution.js';
import type { StateFilter, ExecutionState, ExecutionTimestamps, WaitContext } from './types.js';

/** Shape of a raw row returned by better-sqlite3 queries */
interface SQLiteRow {
  id: string;
  flow_name: string;
  idempotency_key: string;
  state: string;
  input: string | null;
  result: string | null;
  error: string | null;
  retry_count: number;
  ts_queued: number;
  ts_started: number | null;
  ts_completed: number | null;
  transitions: string;
  wait_context: string | null;
  resume_data: string | null;
  replay_of: string | null;
  user_id: string | null;
}

/** Options for constructing a SQLiteStateStore */
export interface SQLiteStateStoreOptions {
  /** Filesystem path to SQLite database file */
  path: string;
  /** How long to keep terminal executions in seconds. 0 = never evict. Default: 3600 */
  retentionPeriod?: number;
  /** Callback for orphaned execution recovery. Default: fail all orphans */
  onOrphanedExecution?: (execution: Execution) => 'fail' | 'requeue' | 'ignore';
}

/** Persistent StateStore backed by SQLite via better-sqlite3 */
export class SQLiteStateStore implements StateStore {
  private readonly db: DatabaseType;
  private readonly retentionPeriodMs: number;
  private readonly onOrphanedExecution?: (execution: Execution) => 'fail' | 'requeue' | 'ignore';
  private closed = false;

  // Pre-compiled prepared statements
  private readonly stmtGetById: Statement;
  private readonly stmtGetByIdempotencyKey: Statement;
  private readonly stmtInsert: Statement;
  private readonly stmtListAll: Statement;
  private readonly stmtListByState: Statement;
  private readonly stmtListByFlowName: Statement;
  private readonly stmtListByStateAndFlowName: Statement;
  private readonly stmtDeleteById: Statement;
  private readonly stmtEvict: Statement;

  constructor(options: SQLiteStateStoreOptions) {
    const { path, retentionPeriod = 3600, onOrphanedExecution } = options;

    this.retentionPeriodMs = retentionPeriod > 0 ? retentionPeriod * 1000 : 0;
    this.onOrphanedExecution = onOrphanedExecution;

    // Validate path: reject relative paths that traverse upward
    const resolvedPath = resolve(path);
    if (path.includes('..')) {
      throw new Error(`SQLite database path must not contain path traversal: ${path}`);
    }

    // Open (or create) database, set WAL mode and synchronous
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    // Schema migration
    this.migrate();

    // Orphaned execution recovery (before prepared statements)
    this.recoverOrphaned();

    // Pre-compile all prepared statements
    this.stmtGetById = this.db.prepare(
      'SELECT * FROM executions WHERE id = ?',
    );
    this.stmtGetByIdempotencyKey = this.db.prepare(
      'SELECT * FROM executions WHERE idempotency_key = ?',
    );
    this.stmtInsert = this.db.prepare(`
      INSERT OR REPLACE INTO executions
        (id, flow_name, idempotency_key, state, input, result, error,
         retry_count, ts_queued, ts_started, ts_completed, transitions,
         wait_context, resume_data, replay_of, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtListAll = this.db.prepare('SELECT * FROM executions');
    this.stmtListByState = this.db.prepare(
      'SELECT * FROM executions WHERE state = ?',
    );
    this.stmtListByFlowName = this.db.prepare(
      'SELECT * FROM executions WHERE flow_name = ?',
    );
    this.stmtListByStateAndFlowName = this.db.prepare(
      'SELECT * FROM executions WHERE state = ? AND flow_name = ?',
    );
    this.stmtDeleteById = this.db.prepare('DELETE FROM executions WHERE id = ?');
    this.stmtEvict = this.db.prepare(
      "DELETE FROM executions WHERE state IN ('complete', 'failed') AND ts_completed < ?",
    );
  }

  // Schema migration system
  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;

    if (version < 1) {
      this.db.transaction(() => {
        this.db.exec(`
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
            replay_of TEXT,
            user_id TEXT
          );

          CREATE INDEX idx_idempotency_key ON executions (idempotency_key);
          CREATE INDEX idx_state ON executions (state);
          CREATE INDEX idx_flow_name ON executions (flow_name);
          CREATE INDEX idx_state_completed ON executions (state, ts_completed);
        `);
        this.db.pragma('user_version = 2');
      })();
    }

    if (version === 1) {
      this.db.transaction(() => {
        this.db.exec('ALTER TABLE executions ADD COLUMN user_id TEXT');
        this.db.pragma('user_version = 2');
      })();
    }
  }

  // Orphaned execution recovery
  private recoverOrphaned(): void {
    // Use direct prepare (not pre-compiled statements — they aren't created yet)
    const findOrphaned = this.db.prepare(
      "SELECT * FROM executions WHERE state IN ('running', 'retrying', 'queued')",
    );
    const updateState = this.db.prepare(
      'UPDATE executions SET state = ?, error = ?, ts_completed = ? WHERE id = ?',
    );
    const updateStateOnly = this.db.prepare(
      'UPDATE executions SET state = ? WHERE id = ?',
    );

    const orphans = findOrphaned.all() as SQLiteRow[];
    if (orphans.length === 0) return;

    this.db.transaction(() => {
      for (const row of orphans) {
        const exec = this.deserializeRow(row);
        let action: 'fail' | 'requeue' | 'ignore' = 'fail';

        if (this.onOrphanedExecution) {
          try {
            action = this.onOrphanedExecution(exec);
          } catch {
            // Callback errors treated as 'fail' (safe default)
            action = 'fail';
          }
        }

        if (action === 'fail') {
          const error = JSON.stringify({
            message: 'Process terminated',
            code: 'PROCESS_TERMINATED',
            retryable: false,
            retryCount: exec.retryCount,
            stack: null,
          });
          updateState.run('failed', error, Date.now(), (row as SQLiteRow).id);
        } else if (action === 'requeue') {
          updateStateOnly.run('queued', (row as SQLiteRow).id);
        }
        // 'ignore' — leave unchanged
      }
    })();
  }

  // Serialization helpers
  private serializeExecution(exec: Execution): unknown[] {
    // Serialize transitions with Date→ms conversion
    const transitions = exec.timestamps.transitions.map((t) => ({
      from: t.from,
      to: t.to,
      at: t.at.getTime(),
    }));

    // Serialize waitContext with Date→ms conversion
    let waitContextJson: string | null = null;
    if (exec.waitContext) {
      waitContextJson = JSON.stringify({
        reason: exec.waitContext.reason,
        expectedResumeBy: exec.waitContext.expectedResumeBy?.getTime() ?? null,
        waitData: exec.waitContext.waitData,
        waitingSince: exec.waitContext.waitingSince.getTime(),
      });
    }

    return [
      exec.id,
      exec.flowName,
      exec.idempotencyKey,
      exec.state,
      exec.input != null ? JSON.stringify(exec.input) : null,
      exec.result != null ? JSON.stringify(exec.result) : null,
      exec.error != null ? JSON.stringify(exec.error) : null,
      exec.retryCount,
      exec.timestamps.queued.getTime(),
      exec.timestamps.started?.getTime() ?? null,
      exec.timestamps.completed?.getTime() ?? null,
      JSON.stringify(transitions),
      waitContextJson,
      exec.resumeData != null ? JSON.stringify(exec.resumeData) : null,
      exec.replayOf,
      exec.userId ?? null,
    ];
  }

  private deserializeRow(row: SQLiteRow): Execution {
    // Parse transitions and reconstruct Date objects
    const rawTransitions = JSON.parse(row.transitions || '[]');
    const transitions = rawTransitions.map((t: { from: string; to: string; at: number }) => ({
      from: t.from as ExecutionState,
      to: t.to as ExecutionState,
      at: new Date(t.at),
    }));

    // Parse waitContext and reconstruct Date objects
    let waitContext: WaitContext | null = null;
    if (row.wait_context) {
      const wc = JSON.parse(row.wait_context);
      waitContext = {
        reason: wc.reason,
        expectedResumeBy: wc.expectedResumeBy != null ? new Date(wc.expectedResumeBy) : null,
        waitData: wc.waitData,
        waitingSince: new Date(wc.waitingSince),
      };
    }

    const timestamps: ExecutionTimestamps = {
      queued: new Date(row.ts_queued),
      started: row.ts_started != null ? new Date(row.ts_started) : null,
      completed: row.ts_completed != null ? new Date(row.ts_completed) : null,
      transitions,
    };

    return {
      id: row.id,
      flowName: row.flow_name,
      idempotencyKey: row.idempotency_key,
      state: row.state as ExecutionState,
      input: row.input != null ? JSON.parse(row.input) : null,
      result: row.result != null ? JSON.parse(row.result) : null,
      error: row.error != null ? JSON.parse(row.error) : null,
      retryCount: row.retry_count,
      timestamps,
      waitContext,
      resumeData: row.resume_data != null ? JSON.parse(row.resume_data) : null,
      replayOf: row.replay_of,
      userId: row.user_id ?? null,
    };
  }

  private throwIfClosed(): void {
    if (this.closed) {
      throw new Error('Database is closed');
    }
  }

  // Lazy retention eviction
  private evictExpired(): void {
    if (this.retentionPeriodMs === 0) return;
    const cutoff = Date.now() - this.retentionPeriodMs;
    this.stmtEvict.run(cutoff);
  }

  // get(id)
  async get(id: string): Promise<Execution | null> {
    this.throwIfClosed();
    this.evictExpired();
    const row = this.stmtGetById.get(id) as SQLiteRow | undefined;
    return row ? this.deserializeRow(row) : null;
  }

  // getByIdempotencyKey(key)
  async getByIdempotencyKey(key: string): Promise<Execution | null> {
    this.throwIfClosed();
    this.evictExpired();
    const row = this.stmtGetByIdempotencyKey.get(key) as SQLiteRow | undefined;
    return row ? this.deserializeRow(row) : null;
  }

  // set(execution)
  async set(execution: Execution): Promise<void> {
    this.throwIfClosed();
    const values = this.serializeExecution(execution);
    this.db.transaction(() => {
      this.stmtInsert.run(...values);
    })();
  }

  // list(filter?)
  async list(filter?: StateFilter): Promise<Execution[]> {
    this.throwIfClosed();
    this.evictExpired();

    let rows: SQLiteRow[];
    if (filter?.state && filter?.flowName) {
      rows = this.stmtListByStateAndFlowName.all(filter.state, filter.flowName) as SQLiteRow[];
    } else if (filter?.state) {
      rows = this.stmtListByState.all(filter.state) as SQLiteRow[];
    } else if (filter?.flowName) {
      rows = this.stmtListByFlowName.all(filter.flowName) as SQLiteRow[];
    } else {
      rows = this.stmtListAll.all() as SQLiteRow[];
    }

    return rows.map((row) => this.deserializeRow(row));
  }

  // delete(id)
  async delete(id: string): Promise<void> {
    this.throwIfClosed();
    this.stmtDeleteById.run(id);
  }

  // close()
  async close(): Promise<void> {
    if (this.closed) return; // Idempotent
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.close();
    this.closed = true;
  }
}
