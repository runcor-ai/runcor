// Integration tests for scoped memory system
// Per spec.md user stories and acceptance scenarios

import { describe, it, expect, beforeEach } from 'vitest';
import { createEngine, type Runcor } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';

describe('Scoped Memory Integration', () => {
  let engine: Runcor;

  beforeEach(async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
    });
  });

  // US1: Tool-Scoped Memory
  describe('US1: Tool-Scoped Memory', () => {
    it('returns null on first read (no prior value)', async () => {
      let firstRead: unknown = 'not-set';

      engine.register('reader', async (ctx) => {
        firstRead = await ctx.memory.tool.get('missing');
        return firstRead;
      });

      await engine.trigger('reader', { idempotencyKey: 'r-1' });
      // Wait for execution to complete
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(firstRead).toBeNull();
    });

    it('persists tool memory across 3 sequential invocations (SC-001)', async () => {
      const results: number[] = [];

      engine.register('counter', async (ctx) => {
        const count = (await ctx.memory.tool.get<number>('count')) ?? 0;
        await ctx.memory.tool.set('count', count + 1);
        results.push(count + 1);
        return count + 1;
      });

      for (let i = 1; i <= 3; i++) {
        await engine.trigger('counter', { idempotencyKey: `count-${i}` });
        await new Promise((resolve) => engine.once('execution:complete', resolve));
      }

      expect(results).toEqual([1, 2, 3]);
    });

    it('isolates tool memory per flow (flow A cannot see flow B)', async () => {
      let flowBRead: unknown = 'not-set';

      engine.register('flowA', async (ctx) => {
        await ctx.memory.tool.set('data', 'secret-A');
        return 'written';
      });

      engine.register('flowB', async (ctx) => {
        flowBRead = await ctx.memory.tool.get('data');
        return flowBRead;
      });

      // Flow A writes
      await engine.trigger('flowA', { idempotencyKey: 'a-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      // Flow B reads — should NOT see flow A's data
      await engine.trigger('flowB', { idempotencyKey: 'b-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(flowBRead).toBeNull();
    });
  });

  // US2: User-Scoped Memory
  describe('US2: User-Scoped Memory', () => {
    it('shares user memory across different flows for the same userId', async () => {
      let readValue: unknown = 'not-set';

      engine.register('save-pref', async (ctx) => {
        await ctx.memory.user.set('language', 'fr');
        return 'saved';
      });

      engine.register('load-pref', async (ctx) => {
        readValue = await ctx.memory.user.get('language');
        return readValue;
      });

      // Save for user-1
      await engine.trigger('save-pref', { idempotencyKey: 'sp-1', userId: 'user-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      // Load for user-1 — should see "fr"
      await engine.trigger('load-pref', { idempotencyKey: 'lp-1', userId: 'user-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(readValue).toBe('fr');
    });

    it('isolates user memory per userId (user-2 cannot see user-1 data)', async () => {
      let readValue: unknown = 'not-set';

      engine.register('save', async (ctx) => {
        await ctx.memory.user.set('data', 'user1-only');
        return 'saved';
      });

      engine.register('load', async (ctx) => {
        readValue = await ctx.memory.user.get('data');
        return readValue;
      });

      // Save for user-1
      await engine.trigger('save', { idempotencyKey: 'u-1', userId: 'user-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      // Load for user-2 — should NOT see user-1's data
      await engine.trigger('load', { idempotencyKey: 'u-2', userId: 'user-2' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(readValue).toBeNull();
    });

    it('throws MISSING_USER_ID when accessing user memory without userId', async () => {
      let thrownError: unknown = null;

      engine.register('no-user', async (ctx) => {
        try {
          await ctx.memory.user.get('anything');
        } catch (err) {
          thrownError = err;
          throw err;
        }
        return 'should not reach';
      });

      await engine.trigger('no-user', { idempotencyKey: 'nu-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(thrownError).not.toBeNull();
      expect((thrownError as any).code).toBe('MISSING_USER_ID');
    });
  });

  // US3: Session-Scoped Memory
  describe('US3: Session-Scoped Memory', () => {
    it('shares session memory across flows in the same session', async () => {
      let readValue: unknown = 'not-set';

      engine.register('step1', async (ctx) => {
        await ctx.memory.session.set('step1Result', 'done');
        return 'step1 complete';
      });

      engine.register('step2', async (ctx) => {
        readValue = await ctx.memory.session.get('step1Result');
        return readValue;
      });

      // Step 1 in session-1
      await engine.trigger('step1', { idempotencyKey: 's1-1', sessionId: 'sess-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      // Step 2 in same session — should see data
      await engine.trigger('step2', { idempotencyKey: 's2-1', sessionId: 'sess-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(readValue).toBe('done');
    });

    it('isolates session memory per sessionId', async () => {
      let readValue: unknown = 'not-set';

      engine.register('write-sess', async (ctx) => {
        await ctx.memory.session.set('data', 'sess1-only');
        return 'written';
      });

      engine.register('read-sess', async (ctx) => {
        readValue = await ctx.memory.session.get('data');
        return readValue;
      });

      // Write in session-1
      await engine.trigger('write-sess', { idempotencyKey: 'ws-1', sessionId: 'sess-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      // Read in session-2 — should NOT see session-1 data
      await engine.trigger('read-sess', { idempotencyKey: 'rs-1', sessionId: 'sess-2' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(readValue).toBeNull();
    });

    it('throws MISSING_SESSION_ID when accessing session memory without sessionId', async () => {
      let thrownError: unknown = null;

      engine.register('no-session', async (ctx) => {
        try {
          await ctx.memory.session.get('anything');
        } catch (err) {
          thrownError = err;
          throw err;
        }
        return 'should not reach';
      });

      await engine.trigger('no-session', { idempotencyKey: 'ns-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(thrownError).not.toBeNull();
      expect((thrownError as any).code).toBe('MISSING_SESSION_ID');
    });
  });

  // US4: TTL and Expiry
  // Note: TTL tests use a single flow (re-invoked) or session scope for cross-flow reads,
  // because tool-scoped memory is isolated per flow name.
  describe('US4: TTL and Expiry', () => {
    it('returns value within TTL window', async () => {
      const results: unknown[] = [];

      engine.register('ttl-flow', async (ctx) => {
        const existing = await ctx.memory.tool.get('cached');
        if (!existing) {
          await ctx.memory.tool.set('cached', 'fresh', 5000); // 5s TTL
          results.push('written');
        } else {
          results.push(existing);
        }
        return results[results.length - 1];
      });

      // First call: write
      await engine.trigger('ttl-flow', { idempotencyKey: 'tf-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      // Second call immediately: read — should be present
      await engine.trigger('ttl-flow', { idempotencyKey: 'tf-2' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(results).toEqual(['written', 'fresh']);
    });

    it('returns null after TTL expires', async () => {
      const results: unknown[] = [];

      engine.register('short-ttl', async (ctx) => {
        const existing = await ctx.memory.tool.get('temp');
        if (!existing && results.length === 0) {
          await ctx.memory.tool.set('temp', 'ephemeral', 50); // 50ms TTL
          results.push('written');
        } else {
          results.push(existing);
        }
        return results[results.length - 1];
      });

      // Write
      await engine.trigger('short-ttl', { idempotencyKey: 'st-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Read — should be null (expired)
      await engine.trigger('short-ttl', { idempotencyKey: 'st-2' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(results[0]).toBe('written');
      expect(results[1]).toBeNull();
    });

    it('persists key indefinitely without TTL', async () => {
      const results: unknown[] = [];

      engine.register('no-ttl', async (ctx) => {
        const existing = await ctx.memory.tool.get('permanent');
        if (!existing && results.length === 0) {
          await ctx.memory.tool.set('permanent', 'forever'); // no TTL
          results.push('written');
        } else {
          results.push(existing);
        }
        return results[results.length - 1];
      });

      await engine.trigger('no-ttl', { idempotencyKey: 'nt-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      await new Promise((resolve) => setTimeout(resolve, 50));

      await engine.trigger('no-ttl', { idempotencyKey: 'nt-2' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(results[0]).toBe('written');
      expect(results[1]).toBe('forever');
    });

    it('overwrites TTL when key is re-set', async () => {
      const results: unknown[] = [];

      engine.register('overwrite-ttl', async (ctx) => {
        const existing = await ctx.memory.tool.get('key');
        if (results.length === 0) {
          await ctx.memory.tool.set('key', 'v1', 50); // short TTL
          await ctx.memory.tool.set('key', 'v2', 5000); // long TTL resets expiry
          results.push('overwritten');
        } else {
          results.push(existing);
        }
        return results[results.length - 1];
      });

      await engine.trigger('overwrite-ttl', { idempotencyKey: 'ot-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      // Wait past original short TTL
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should still be present due to new long TTL
      await engine.trigger('overwrite-ttl', { idempotencyKey: 'ot-2' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(results[0]).toBe('overwritten');
      expect(results[1]).toBe('v2');
    });

    it('TTL 0 means no expiry', async () => {
      const results: unknown[] = [];

      engine.register('ttl-zero', async (ctx) => {
        const existing = await ctx.memory.tool.get('key');
        if (results.length === 0) {
          await ctx.memory.tool.set('key', 'persistent', 0); // TTL 0 = no expiry
          results.push('written');
        } else {
          results.push(existing);
        }
        return results[results.length - 1];
      });

      await engine.trigger('ttl-zero', { idempotencyKey: 'tz-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      await new Promise((resolve) => setTimeout(resolve, 50));

      await engine.trigger('ttl-zero', { idempotencyKey: 'tz-2' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(results[0]).toBe('written');
      expect(results[1]).toBe('persistent');
    });

    it('negative TTL causes key to not be stored', async () => {
      const results: unknown[] = [];

      engine.register('neg-ttl', async (ctx) => {
        if (results.length === 0) {
          await ctx.memory.tool.set('key', 'should-not-exist', -100);
          results.push('attempted');
        }
        const val = await ctx.memory.tool.get('key');
        results.push(val);
        return val;
      });

      await engine.trigger('neg-ttl', { idempotencyKey: 'ng-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(results[0]).toBe('attempted');
      expect(results[1]).toBeNull();
    });

    it('list() excludes expired keys', async () => {
      let listedKeys: string[] = [];

      engine.register('mixed-ttl', async (ctx) => {
        const keys = await ctx.memory.tool.list();
        if (keys.length === 0) {
          await ctx.memory.tool.set('alive', 'yes');
          await ctx.memory.tool.set('dying', 'soon', 50); // 50ms TTL
          return 'written';
        }
        listedKeys = await ctx.memory.tool.list();
        return listedKeys;
      });

      await engine.trigger('mixed-ttl', { idempotencyKey: 'mt-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      // Wait for "dying" to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      await engine.trigger('mixed-ttl', { idempotencyKey: 'mt-2' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(listedKeys).toEqual(['alive']);
    });
  });

  // Edge Cases & Cross-Cutting Concerns (T025)
  describe('Edge Cases', () => {
    it('rejects non-serializable value (function) with INVALID_MEMORY_VALUE', async () => {
      let thrownError: unknown = null;

      engine.register('bad-value', async (ctx) => {
        try {
          await ctx.memory.tool.set('fn', (() => {}) as unknown);
        } catch (err) {
          thrownError = err;
          throw err;
        }
        return 'should not reach';
      });

      await engine.trigger('bad-value', { idempotencyKey: 'bv-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(thrownError).not.toBeNull();
      expect((thrownError as any).code).toBe('INVALID_MEMORY_VALUE');
    });

    it('50 concurrent flows accessing memory with zero cross-scope leakage (SC-002)', async () => {
      const flowCount = 50;
      const results = new Map<string, number>();

      // Register 50 flows, each writing to its own tool-scoped memory
      for (let i = 0; i < flowCount; i++) {
        const flowName = `flow-${i}`;
        engine.register(flowName, async (ctx) => {
          await ctx.memory.tool.set('id', i);
          // Small delay to increase chance of interleaving
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
          const readBack = await ctx.memory.tool.get<number>('id');
          results.set(flowName, readBack!);
          return readBack;
        });
      }

      // Trigger all 50 flows concurrently
      let completedCount = 0;
      const allDone = new Promise<void>((resolve) => {
        engine.on('execution:complete', () => {
          completedCount++;
          if (completedCount === flowCount) resolve();
        });
      });

      for (let i = 0; i < flowCount; i++) {
        await engine.trigger(`flow-${i}`, { idempotencyKey: `sc002-${i}` });
      }

      await allDone;

      // Verify: each flow read back its own value (no cross-scope leakage)
      expect(results.size).toBe(flowCount);
      for (let i = 0; i < flowCount; i++) {
        expect(results.get(`flow-${i}`)).toBe(i);
      }
    });

    it('flow can access all three scopes simultaneously', async () => {
      const scopeResults: Record<string, unknown> = {};

      engine.register('multi-scope', async (ctx) => {
        await ctx.memory.tool.set('key', 'tool-val');
        await ctx.memory.user.set('key', 'user-val');
        await ctx.memory.session.set('key', 'session-val');

        scopeResults.tool = await ctx.memory.tool.get('key');
        scopeResults.user = await ctx.memory.user.get('key');
        scopeResults.session = await ctx.memory.session.get('key');
        return scopeResults;
      });

      await engine.trigger('multi-scope', {
        idempotencyKey: 'ms-1',
        userId: 'user-1',
        sessionId: 'sess-1',
      });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(scopeResults.tool).toBe('tool-val');
      expect(scopeResults.user).toBe('user-val');
      expect(scopeResults.session).toBe('session-val');
    });

    it('delete on nonexistent key succeeds silently', async () => {
      let deleteSucceeded = false;

      engine.register('delete-missing', async (ctx) => {
        await ctx.memory.tool.delete('nonexistent');
        deleteSucceeded = true;
        return 'ok';
      });

      await engine.trigger('delete-missing', { idempotencyKey: 'dm-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(deleteSucceeded).toBe(true);
    });

    it('list on empty scope returns empty array', async () => {
      let keys: string[] | null = null;

      engine.register('list-empty', async (ctx) => {
        keys = await ctx.memory.tool.list();
        return keys;
      });

      await engine.trigger('list-empty', { idempotencyKey: 'le-1' });
      await new Promise((resolve) => engine.once('execution:complete', resolve));

      expect(keys).toEqual([]);
    });
  });
});
