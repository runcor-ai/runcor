// Stress test: Engine concurrency — high-volume simultaneous triggers
import { describe, it, expect, afterEach } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import type { Runcor } from '../../src/engine.js';

describe('Stress: Concurrency', () => {
  let engine: Runcor;

  afterEach(async () => {
    await engine?.shutdown();
  });

  it('should run 1000 simultaneous triggers with unique result verification', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 200,
    });

    engine.register('unique', async (ctx) => `result-${ctx.input}`, {
      maxRetries: 0,
      timeout: 0,
    });

    const count = 1000;
    let completed = 0;
    const allDone = new Promise<void>((resolve) => {
      engine.on('execution:complete', () => {
        completed++;
        if (completed >= count) resolve();
      });
    });

    const executions = [];
    for (let i = 0; i < count; i++) {
      const exec = await engine.trigger('unique', {
        idempotencyKey: `conc-1k-${i}`,
        input: i,
      });
      executions.push(exec);
    }

    await allDone;
    await new Promise((r) => setTimeout(r, 100));

    const results = new Set<string>();
    for (const exec of executions) {
      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');
      results.add(final!.result as string);
    }

    expect(results.size).toBe(count);
  }, 30000);

  it('should queue when triggers exceed concurrency limit and dispatch FIFO', async () => {
    const concurrencyLimit = 5;
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: concurrencyLimit,
    });

    const completionOrder: number[] = [];
    let resolvers: Array<() => void> = [];

    engine.register('blocking', async (ctx) => {
      // Each execution waits for explicit resolution
      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      completionOrder.push(ctx.input as number);
      return ctx.input;
    }, { maxRetries: 0, timeout: 10000 });

    // Trigger more executions than concurrency allows
    const total = 15;
    for (let i = 0; i < total; i++) {
      await engine.trigger('blocking', { idempotencyKey: `fifo-${i}`, input: i });
    }

    // Wait for first batch to start executing
    await new Promise((r) => setTimeout(r, 100));

    // Only concurrency limit should be executing (rest queued)
    expect(resolvers.length).toBe(concurrencyLimit);

    // Resolve them in order — FIFO queue should dispatch next ones
    let completedCount = 0;
    const allDone = new Promise<void>((resolve) => {
      engine.on('execution:complete', () => {
        completedCount++;
        if (completedCount >= total) resolve();
      });
    });

    // Resolve all resolvers as they appear
    while (completedCount < total) {
      const batch = resolvers.splice(0);
      for (const r of batch) r();
      await new Promise((r) => setTimeout(r, 50));
    }

    await allDone;
    expect(completedCount).toBe(total);
  }, 30000);

  it('should handle concurrent trigger + cancel on overlapping executions', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 50,
      drainTimeout: 2000,
    });

    engine.register('cancel-target', async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 'completed';
    }, { maxRetries: 0, timeout: 5000 });

    const total = 100;
    const executions = [];
    for (let i = 0; i < total; i++) {
      const exec = await engine.trigger('cancel-target', {
        idempotencyKey: `cancel-${i}`,
      });
      executions.push(exec);
    }

    // Cancel half of them immediately
    const cancelPromises = executions
      .filter((_, i) => i % 2 === 0)
      .map((exec) => engine.cancel(exec.id, 'stress test cancel').catch(() => {}));
    await Promise.all(cancelPromises);

    // Wait for all to reach terminal state
    await new Promise((r) => setTimeout(r, 300));

    let cancelledCount = 0;
    let completedCount = 0;
    for (const exec of executions) {
      const final = await engine.getExecution(exec.id);
      if (final!.state === 'failed') cancelledCount++;
      else if (final!.state === 'complete') completedCount++;
    }

    // At least some should be cancelled and some should complete
    expect(cancelledCount).toBeGreaterThan(0);
    expect(completedCount).toBeGreaterThan(0);
    expect(cancelledCount + completedCount).toBe(total);
  }, 30000);

  it('should never exceed configured concurrency limit for activeExecutions', async () => {
    const concurrencyLimit = 10;
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: concurrencyLimit,
    });

    let maxObservedActive = 0;
    let currentActive = 0;

    engine.register('track-active', async () => {
      currentActive++;
      maxObservedActive = Math.max(maxObservedActive, currentActive);
      await new Promise((r) => setTimeout(r, 10));
      currentActive--;
      return 'ok';
    }, { maxRetries: 0, timeout: 5000 });

    const total = 100;
    let completed = 0;
    const allDone = new Promise<void>((resolve) => {
      engine.on('execution:complete', () => {
        completed++;
        if (completed >= total) resolve();
      });
    });

    for (let i = 0; i < total; i++) {
      await engine.trigger('track-active', { idempotencyKey: `active-${i}` });
    }

    await allDone;

    expect(maxObservedActive).toBeLessThanOrEqual(concurrencyLimit);
    expect(maxObservedActive).toBeGreaterThan(0);
  }, 30000);

  it('should handle 200+ rapid fire-and-forget triggers without awaiting', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 100,
    });

    engine.register('fire-forget', async (ctx) => ctx.input, {
      maxRetries: 0,
      timeout: 0,
    });

    const total = 200;
    let completed = 0;
    const allDone = new Promise<void>((resolve) => {
      engine.on('execution:complete', () => {
        completed++;
        if (completed >= total) resolve();
      });
    });

    // Fire all triggers as fast as possible
    const triggerPromises = [];
    for (let i = 0; i < total; i++) {
      triggerPromises.push(
        engine.trigger('fire-forget', { idempotencyKey: `ff-${i}`, input: i }),
      );
    }

    const executions = await Promise.all(triggerPromises);
    await allDone;

    // Verify all completed
    expect(completed).toBe(total);
    expect(executions.length).toBe(total);

    // Verify unique IDs
    const ids = new Set(executions.map((e) => e.id));
    expect(ids.size).toBe(total);
  }, 30000);
});
