// Performance verification for SC-001 and SC-003

import { describe, it, expect } from 'vitest';
import { InMemoryStore } from '../../src/memory/store.js';
import { ScopedMemoryImpl } from '../../src/memory/scoped.js';

describe('Memory Performance', () => {
  it('SC-003: individual get/set/delete operations complete in under 1ms', async () => {
    const store = new InMemoryStore();
    const scoped = new ScopedMemoryImpl(store, 'tool:perf');

    // Warm up
    await scoped.set('warmup', 'val');
    await scoped.get('warmup');
    await scoped.delete('warmup');

    // Measure set
    const setStart = performance.now();
    await scoped.set('perf-key', { data: 'test', nested: { a: 1 } });
    const setTime = performance.now() - setStart;

    // Measure get
    const getStart = performance.now();
    await scoped.get('perf-key');
    const getTime = performance.now() - getStart;

    // Measure delete
    const delStart = performance.now();
    await scoped.delete('perf-key');
    const delTime = performance.now() - delStart;

    expect(setTime).toBeLessThan(1);
    expect(getTime).toBeLessThan(1);
    expect(delTime).toBeLessThan(1);
  });

  it('SC-001: 3 sequential memory invocations complete in under 10ms total', async () => {
    const store = new InMemoryStore();
    const scoped = new ScopedMemoryImpl(store, 'tool:counter');

    const start = performance.now();
    for (let i = 0; i < 3; i++) {
      const count = ((await scoped.get<number>('count')) ?? 0);
      await scoped.set('count', count + 1);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(10);
    expect(await scoped.get<number>('count')).toBe(3);
  });
});
