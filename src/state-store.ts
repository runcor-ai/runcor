// StateStore interface + InMemoryStateStore implementation

import type { Execution } from './execution.js';
import type { StateFilter } from './types.js';

/** Pluggable storage interface for execution state */
export interface StateStore {
  /** Retrieve execution by ID */
  get(id: string): Promise<Execution | null>;
  /** Retrieve by idempotency key */
  getByIdempotencyKey(key: string): Promise<Execution | null>;
  /** Create or update execution */
  set(execution: Execution): Promise<void>;
  /** List executions with optional filter */
  list(filter?: StateFilter): Promise<Execution[]>;
  /** Remove execution */
  delete(id: string): Promise<void>;
  /** Optional cleanup on shutdown */
  close?(): Promise<void>;
}

const TERMINAL_STATES = new Set(['complete', 'failed']);

/** In-memory StateStore using Map. Supports lazy retention eviction. */
export class InMemoryStateStore implements StateStore {
  private readonly store = new Map<string, Execution>();
  private readonly idempotencyIndex = new Map<string, string>(); // key → execution id
  private readonly retentionPeriodMs: number;

  constructor(retentionPeriodSeconds: number = 3600) {
    // retention=0 means never evict
    this.retentionPeriodMs = retentionPeriodSeconds > 0
      ? retentionPeriodSeconds * 1000
      : 0;
  }

  async get(id: string): Promise<Execution | null> {
    this.evictExpired();
    return this.store.get(id) ?? null;
  }

  async getByIdempotencyKey(key: string): Promise<Execution | null> {
    this.evictExpired();
    const id = this.idempotencyIndex.get(key);
    if (!id) return null;
    return this.store.get(id) ?? null;
  }

  async set(execution: Execution): Promise<void> {
    this.store.set(execution.id, execution);
    this.idempotencyIndex.set(execution.idempotencyKey, execution.id);
  }

  async list(filter?: StateFilter): Promise<Execution[]> {
    this.evictExpired();
    let results = Array.from(this.store.values());

    if (filter?.state) {
      results = results.filter((e) => e.state === filter.state);
    }
    if (filter?.flowName) {
      results = results.filter((e) => e.flowName === filter.flowName);
    }

    return results;
  }

  async delete(id: string): Promise<void> {
    const exec = this.store.get(id);
    if (exec) {
      this.idempotencyIndex.delete(exec.idempotencyKey);
      this.store.delete(id);
    }
  }

  private evictExpired(): void {
    if (this.retentionPeriodMs === 0) return;

    const now = Date.now();
    for (const [id, exec] of this.store) {
      if (
        TERMINAL_STATES.has(exec.state) &&
        exec.timestamps.completed &&
        now - exec.timestamps.completed.getTime() > this.retentionPeriodMs
      ) {
        this.idempotencyIndex.delete(exec.idempotencyKey);
        this.store.delete(id);
      }
    }
  }
}
