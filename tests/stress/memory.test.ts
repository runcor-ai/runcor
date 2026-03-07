// Stress test: Memory and state store under pressure
import { describe, it, expect, afterEach } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import { InMemoryStore } from '../../src/memory/store.js';
import { ScopedMemoryImpl } from '../../src/memory/scoped.js';
import type { Runcor } from '../../src/engine.js';

describe('Stress: Memory', () => {
  let engine: Runcor;

  afterEach(async () => {
    await engine?.shutdown();
  });

  it('should handle state store list() with 10K+ executions', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 200,
    });

    engine.register('list-perf', async () => 'ok', { maxRetries: 0, timeout: 0 });

    const count = 10000;
    let completed = 0;
    const allDone = new Promise<void>((resolve) => {
      engine.on('execution:complete', () => {
        completed++;
        if (completed >= count) resolve();
      });
    });

    // Batch triggers for speed
    const batchSize = 500;
    for (let batch = 0; batch < count / batchSize; batch++) {
      const promises = [];
      for (let i = 0; i < batchSize; i++) {
        const idx = batch * batchSize + i;
        promises.push(engine.trigger('list-perf', { idempotencyKey: `lp-${idx}` }));
      }
      await Promise.all(promises);
    }

    await allDone;

    // Measure list() performance
    const listStart = performance.now();
    const all = await engine.list({ state: 'complete' });
    const listTime = performance.now() - listStart;

    expect(all.length).toBe(count);
    // list() should complete within 1 second for 10K in-memory entries
    expect(listTime).toBeLessThan(1000);
  }, 30000);

  it('should handle 100 concurrent users writing to scoped memory simultaneously', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 100,
    });

    const userCount = 100;

    engine.register('mem-write', async (ctx) => {
      const userId = ctx.input as string;
      // Each user writes their own keys
      for (let j = 0; j < 10; j++) {
        await ctx.memory.user.set(`key-${j}`, `${userId}-val-${j}`);
      }
      // Read back
      const values: string[] = [];
      for (let j = 0; j < 10; j++) {
        const v = await ctx.memory.user.get<string>(`key-${j}`);
        values.push(v!);
      }
      return values;
    }, { maxRetries: 0, timeout: 5000 });

    let completed = 0;
    const allDone = new Promise<void>((resolve) => {
      engine.on('execution:complete', () => {
        completed++;
        if (completed >= userCount) resolve();
      });
    });

    const executions = [];
    for (let i = 0; i < userCount; i++) {
      const exec = await engine.trigger('mem-write', {
        idempotencyKey: `mem-${i}`,
        input: `user-${i}`,
        userId: `user-${i}`,
      });
      executions.push(exec);
    }

    await allDone;
    await new Promise((r) => setTimeout(r, 100));

    // Verify each user got their own scoped values (no cross-contamination)
    for (let i = 0; i < userCount; i++) {
      const final = await engine.getExecution(executions[i].id);
      expect(final!.state).toBe('complete');
      const values = final!.result as string[];
      for (let j = 0; j < 10; j++) {
        expect(values[j]).toBe(`user-${i}-val-${j}`);
      }
    }
  }, 30000);

  it('should correctly expire memory entries with TTL under load', async () => {
    const store = new InMemoryStore();
    const scoped = new ScopedMemoryImpl(store, 'tool:ttl-stress');

    // Write 100 entries with short TTL
    const count = 100;
    for (let i = 0; i < count; i++) {
      await scoped.set(`ttl-key-${i}`, `value-${i}`, 100); // 100ms TTL
    }

    // Immediately: all should be readable
    for (let i = 0; i < count; i++) {
      const val = await scoped.get(`ttl-key-${i}`);
      expect(val).toBe(`value-${i}`);
    }

    // Wait for TTL expiry
    await new Promise((r) => setTimeout(r, 200));

    // After TTL: all should be null
    for (let i = 0; i < count; i++) {
      const val = await scoped.get(`ttl-key-${i}`);
      expect(val).toBeNull();
    }
  }, 30000);

  it('should handle large payloads (1MB+) through execution input/result', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 10,
    });

    engine.register('large-payload', async (ctx) => {
      return ctx.input; // Echo back
    }, { maxRetries: 0, timeout: 5000 });

    // Create a ~1MB payload
    const largeData = 'x'.repeat(1024 * 1024);

    let completed = 0;
    const allDone = new Promise<void>((resolve) => {
      engine.on('execution:complete', () => {
        completed++;
        if (completed >= 5) resolve();
      });
    });

    const executions = [];
    for (let i = 0; i < 5; i++) {
      const exec = await engine.trigger('large-payload', {
        idempotencyKey: `large-${i}`,
        input: { data: largeData, index: i },
      });
      executions.push(exec);
    }

    await allDone;
    await new Promise((r) => setTimeout(r, 100));

    for (const exec of executions) {
      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');
      const result = final!.result as { data: string; index: number };
      expect(result.data.length).toBe(1024 * 1024);
    }
  }, 30000);

  it('should handle concurrent memory operations across multiple scopes', async () => {
    const store = new InMemoryStore();

    // 50 scopes, each doing 20 operations concurrently
    const scopeCount = 50;
    const opsPerScope = 20;

    const promises = [];
    for (let s = 0; s < scopeCount; s++) {
      const scoped = new ScopedMemoryImpl(store, `scope-${s}`);
      for (let o = 0; o < opsPerScope; o++) {
        promises.push(
          (async () => {
            await scoped.set(`key-${o}`, `scope-${s}-val-${o}`);
            const val = await scoped.get<string>(`key-${o}`);
            expect(val).toBe(`scope-${s}-val-${o}`);
          })(),
        );
      }
    }

    await Promise.all(promises);

    // Verify isolation
    for (let s = 0; s < scopeCount; s++) {
      const scoped = new ScopedMemoryImpl(store, `scope-${s}`);
      const keys = await scoped.list();
      expect(keys.length).toBe(opsPerScope);
    }
  }, 30000);
});
