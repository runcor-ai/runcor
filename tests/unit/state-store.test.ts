// Unit tests for InMemoryStateStore
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryStateStore } from '../../src/state-store.js';
import { createExecution } from '../../src/execution.js';

describe('InMemoryStateStore', () => {
  let store: InMemoryStateStore;

  beforeEach(() => {
    store = new InMemoryStateStore();
  });

  describe('get/set', () => {
    it('should store and retrieve an execution by ID', async () => {
      const exec = createExecution('flow-a', 'key-1', { x: 1 });
      await store.set(exec);

      const retrieved = await store.get(exec.id);
      expect(retrieved).toBe(exec);
    });

    it('should return null for missing ID', async () => {
      const result = await store.get('nonexistent-id');
      expect(result).toBeNull();
    });

    it('should overwrite existing execution on set', async () => {
      const exec = createExecution('flow-a', 'key-1', null);
      await store.set(exec);

      exec.state = 'running' as any;
      await store.set(exec);

      const retrieved = await store.get(exec.id);
      expect(retrieved!.state).toBe('running');
    });
  });

  describe('getByIdempotencyKey', () => {
    it('should retrieve execution by idempotency key', async () => {
      const exec = createExecution('flow-a', 'unique-key', null);
      await store.set(exec);

      const retrieved = await store.getByIdempotencyKey('unique-key');
      expect(retrieved).toBe(exec);
    });

    it('should return null for missing idempotency key', async () => {
      const result = await store.getByIdempotencyKey('no-such-key');
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should remove an execution', async () => {
      const exec = createExecution('flow-a', 'key-1', null);
      await store.set(exec);
      await store.delete(exec.id);

      const result = await store.get(exec.id);
      expect(result).toBeNull();
    });

    it('should remove idempotency key index on delete', async () => {
      const exec = createExecution('flow-a', 'key-1', null);
      await store.set(exec);
      await store.delete(exec.id);

      const result = await store.getByIdempotencyKey('key-1');
      expect(result).toBeNull();
    });
  });

  describe('list', () => {
    it('should list all executions', async () => {
      const exec1 = createExecution('flow-a', 'key-1', null);
      const exec2 = createExecution('flow-b', 'key-2', null);
      await store.set(exec1);
      await store.set(exec2);

      const all = await store.list();
      expect(all).toHaveLength(2);
    });

    it('should filter by state', async () => {
      const exec1 = createExecution('flow-a', 'key-1', null);
      const exec2 = createExecution('flow-a', 'key-2', null);
      exec2.state = 'running' as any;
      await store.set(exec1);
      await store.set(exec2);

      const queued = await store.list({ state: 'queued' });
      expect(queued).toHaveLength(1);
      expect(queued[0].id).toBe(exec1.id);
    });

    it('should filter by flowName', async () => {
      const exec1 = createExecution('flow-a', 'key-1', null);
      const exec2 = createExecution('flow-b', 'key-2', null);
      await store.set(exec1);
      await store.set(exec2);

      const flowA = await store.list({ flowName: 'flow-a' });
      expect(flowA).toHaveLength(1);
      expect(flowA[0].flowName).toBe('flow-a');
    });

    it('should filter by both state and flowName', async () => {
      const exec1 = createExecution('flow-a', 'key-1', null);
      const exec2 = createExecution('flow-a', 'key-2', null);
      exec2.state = 'running' as any;
      const exec3 = createExecution('flow-b', 'key-3', null);
      await store.set(exec1);
      await store.set(exec2);
      await store.set(exec3);

      const result = await store.list({ state: 'queued', flowName: 'flow-a' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(exec1.id);
    });
  });

  describe('retention eviction', () => {
    it('should evict terminal executions older than retention period', async () => {
      const store = new InMemoryStateStore(1); // 1 second retention

      const exec = createExecution('flow-a', 'key-1', null);
      exec.state = 'complete' as any;
      exec.timestamps.completed = new Date(Date.now() - 2000); // 2 seconds ago
      await store.set(exec);

      // Access triggers eviction
      const result = await store.get(exec.id);
      expect(result).toBeNull();
    });

    it('should not evict non-terminal executions', async () => {
      const store = new InMemoryStateStore(1);

      const exec = createExecution('flow-a', 'key-1', null);
      exec.state = 'running' as any;
      await store.set(exec);

      // Wait a bit then access
      await new Promise((r) => setTimeout(r, 50));
      const result = await store.get(exec.id);
      expect(result).not.toBeNull();
    });

    it('should not evict when retention is 0 (forever)', async () => {
      const store = new InMemoryStateStore(0);

      const exec = createExecution('flow-a', 'key-1', null);
      exec.state = 'complete' as any;
      exec.timestamps.completed = new Date(Date.now() - 100000);
      await store.set(exec);

      const result = await store.get(exec.id);
      expect(result).not.toBeNull();
    });

    it('should evict on list() access too', async () => {
      const store = new InMemoryStateStore(1);

      const exec = createExecution('flow-a', 'key-1', null);
      exec.state = 'failed' as any;
      exec.timestamps.completed = new Date(Date.now() - 2000);
      await store.set(exec);

      const all = await store.list();
      expect(all).toHaveLength(0);
    });
  });
});
