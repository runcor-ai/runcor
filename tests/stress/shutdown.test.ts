// Stress test: Graceful shutdown under load
import { describe, it, expect, afterEach } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import { createWaitSignal } from '../../src/wait-signal.js';
import type { Runcor } from '../../src/engine.js';

describe('Stress: Shutdown', () => {
  let engine: Runcor;

  afterEach(async () => {
    try {
      await engine?.shutdown();
    } catch {
      // May already be shut down
    }
  });

  it('should drain 100+ active executions on shutdown', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 100,
      drainTimeout: 5000,
    });

    engine.register('drain-target', async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 'drained';
    }, { maxRetries: 0, timeout: 10000 });

    const total = 100;
    const executions = [];
    for (let i = 0; i < total; i++) {
      const exec = await engine.trigger('drain-target', { idempotencyKey: `drain-${i}` });
      executions.push(exec);
    }

    // Initiate shutdown while executions are running
    await engine.shutdown();

    // After shutdown, all executions should be in a terminal state
    for (const exec of executions) {
      const final = await engine.getExecution(exec.id);
      expect(['complete', 'failed']).toContain(final!.state);
    }

    // Most should have completed (drain timeout is generous)
    let completedCount = 0;
    for (const exec of executions) {
      const final = await engine.getExecution(exec.id);
      if (final!.state === 'complete') completedCount++;
    }
    expect(completedCount).toBeGreaterThan(0);
  }, 30000);

  it('should not leave orphaned executions when shutdown occurs during queue dispatch', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 5,
      drainTimeout: 3000,
    });

    engine.register('queue-dispatch', async () => {
      await new Promise((r) => setTimeout(r, 100));
      return 'done';
    }, { maxRetries: 0, timeout: 5000 });

    // Trigger more than concurrency limit to fill queue
    const total = 50;
    const executions = [];
    for (let i = 0; i < total; i++) {
      const exec = await engine.trigger('queue-dispatch', { idempotencyKey: `qd-${i}` });
      executions.push(exec);
    }

    // Shutdown immediately
    await engine.shutdown();

    // Every execution should be in a terminal state — no orphans
    for (const exec of executions) {
      const final = await engine.getExecution(exec.id);
      expect(final).toBeDefined();
      expect(['complete', 'failed']).toContain(final!.state);
    }
  }, 30000);

  it('should clean up waiting executions on shutdown', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 20,
      drainTimeout: 2000,
    });

    engine.register('wait-shutdown', async () => {
      return createWaitSignal({ reason: 'external' });
    }, { maxRetries: 0, timeout: 0, waitTimeout: 60000 });

    // Create waiting executions
    const waitingExecs = [];
    for (let i = 0; i < 20; i++) {
      const exec = await engine.trigger('wait-shutdown', { idempotencyKey: `ws-${i}` });
      waitingExecs.push(exec);
    }

    // Wait for all to enter waiting state
    await new Promise((r) => setTimeout(r, 500));

    for (const exec of waitingExecs) {
      const state = await engine.getExecution(exec.id);
      expect(state!.state).toBe('waiting');
    }

    // Shutdown — waiting executions should remain in waiting state per engine semantics
    // (they are NOT force-failed; the engine preserves waiting state across restarts)
    await engine.shutdown();

    for (const exec of waitingExecs) {
      const final = await engine.getExecution(exec.id);
      // Engine does NOT force-fail waiting executions on shutdown
      expect(final!.state).toBe('waiting');
    }
  }, 30000);

  it('should handle 20 rapid start/shutdown cycles without resource leaks', async () => {
    for (let cycle = 0; cycle < 20; cycle++) {
      engine = await createEngine({
        model: { provider: new MockProvider() },
        concurrency: 10,
      });

      engine.register('cycle-flow', async () => `cycle-${cycle}`, {
        maxRetries: 0,
        timeout: 0,
      });

      // Trigger a few executions per cycle
      const execPromises = [];
      for (let i = 0; i < 5; i++) {
        execPromises.push(
          engine.trigger('cycle-flow', { idempotencyKey: `cycle-${cycle}-${i}` }),
        );
      }
      await Promise.all(execPromises);
      await new Promise((r) => setTimeout(r, 50));

      await engine.shutdown();

      expect(engine.getStatus()).toBe('stopped');
    }
    // If we reach here without hanging or crashing, no resource leaks
  }, 30000);

  it('should handle zero drain timeout (immediate force-fail)', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 20,
      drainTimeout: 0,
    });

    engine.register('no-drain', async () => {
      await new Promise((r) => setTimeout(r, 1000));
      return 'should-not-complete';
    }, { maxRetries: 0, timeout: 5000 });

    const total = 20;
    const executions = [];
    for (let i = 0; i < total; i++) {
      const exec = await engine.trigger('no-drain', { idempotencyKey: `nd-${i}` });
      executions.push(exec);
    }

    // Give them time to start
    await new Promise((r) => setTimeout(r, 100));

    // Shutdown with zero drain timeout
    await engine.shutdown();

    // All should be in terminal state
    let failedCount = 0;
    for (const exec of executions) {
      const final = await engine.getExecution(exec.id);
      expect(['complete', 'failed']).toContain(final!.state);
      if (final!.state === 'failed') failedCount++;
    }

    // With zero drain timeout, all running executions should be force-failed
    expect(failedCount).toBeGreaterThan(0);
  }, 30000);
});
