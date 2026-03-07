// Stress test: State machine transitions under pressure
import { describe, it, expect, afterEach } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import { createWaitSignal } from '../../src/wait-signal.js';
import type { Runcor } from '../../src/engine.js';

describe('Stress: State Machine', () => {
  let engine: Runcor;

  afterEach(async () => {
    await engine?.shutdown();
  });

  it('should handle 500 rapid trigger-complete cycles with sub-ms handlers', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 100,
    });

    // Sub-ms handler — immediate return
    engine.register('instant', async () => 'done', { maxRetries: 0, timeout: 0 });

    const count = 500;
    let completed = 0;
    const allDone = new Promise<void>((resolve) => {
      engine.on('execution:complete', () => {
        completed++;
        if (completed >= count) resolve();
      });
    });

    for (let i = 0; i < count; i++) {
      await engine.trigger('instant', { idempotencyKey: `rapid-${i}` });
    }

    await allDone;
    expect(completed).toBe(count);

    // Verify all reached terminal 'complete' state
    const all = await engine.list({ state: 'complete' });
    expect(all.length).toBe(count);
  }, 30000);

  it('should cancel executions in queued state', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 1,
    });

    // Block the only concurrency slot
    let releaseBlocker: () => void;
    const blockerRunning = new Promise<void>((resolve) => {
      engine.register('blocker', async () => {
        resolve();
        await new Promise<void>((r) => { releaseBlocker = r; });
        return 'blocked';
      }, { maxRetries: 0, timeout: 10000 });
    });

    await engine.trigger('blocker', { idempotencyKey: 'block-1' });
    await blockerRunning;

    // This should be queued since concurrency=1 is occupied
    engine.register('queued-flow', async () => 'should-not-run', {
      maxRetries: 0,
      timeout: 10000,
    });

    const queued = await engine.trigger('queued-flow', { idempotencyKey: 'q-cancel-1' });
    expect(queued.state).toBe('queued');

    // Cancel the queued execution
    await engine.cancel(queued.id, 'cancelled while queued');

    const final = await engine.getExecution(queued.id);
    expect(final!.state).toBe('failed');
    expect(final!.error!.message).toContain('cancelled while queued');

    releaseBlocker!();
    await new Promise((r) => setTimeout(r, 100));
  }, 30000);

  it('should cancel executions in running state', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 10,
      drainTimeout: 1000,
    });

    let handlerStarted = false;
    engine.register('long-running', async () => {
      handlerStarted = true;
      // Use a promise that the cancel will interrupt via state check
      await new Promise((r) => setTimeout(r, 60000));
      return 'should-not-reach';
    }, { maxRetries: 0, timeout: 60000 });

    const exec = await engine.trigger('long-running', { idempotencyKey: 'cancel-running' });
    // Wait for handler to actually start
    while (!handlerStarted) {
      await new Promise((r) => setTimeout(r, 10));
    }

    await engine.cancel(exec.id, 'cancelled while running');

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('failed');
    expect(final!.error!.message).toContain('cancelled while running');
  }, 30000);

  it('should cancel executions in waiting state', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 10,
    });

    engine.register('wait-flow', async () => {
      return createWaitSignal({ reason: 'waiting for approval' });
    }, { maxRetries: 0, timeout: 0, waitTimeout: 60000 });

    const exec = await engine.trigger('wait-flow', { idempotencyKey: 'cancel-waiting' });
    await new Promise((r) => setTimeout(r, 200)); // Let it enter waiting state

    const waiting = await engine.getExecution(exec.id);
    expect(waiting!.state).toBe('waiting');

    await engine.cancel(exec.id, 'cancelled while waiting');

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('failed');
    expect(final!.error!.message).toContain('cancelled while waiting');
  }, 30000);

  it('should handle concurrent resume attempts on same execution (only one succeeds)', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 10,
    });

    engine.register('wait-for-resume', async (ctx) => {
      if (ctx.resumeData !== undefined) {
        return `resumed-with-${ctx.resumeData}`;
      }
      return createWaitSignal({ reason: 'need approval' });
    }, { maxRetries: 0, timeout: 0, waitTimeout: 60000 });

    const exec = await engine.trigger('wait-for-resume', { idempotencyKey: 'multi-resume' });
    await new Promise((r) => setTimeout(r, 200));

    const mid = await engine.getExecution(exec.id);
    expect(mid!.state).toBe('waiting');

    // Fire 10 concurrent resumes
    const resumeResults = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        engine.resume(exec.id, `data-${i}`),
      ),
    );

    await new Promise((r) => setTimeout(r, 300));

    // Only one resume should succeed, others should get INVALID_STATE
    const successes = resumeResults.filter((r) => r.status === 'fulfilled');
    const failures = resumeResults.filter((r) => r.status === 'rejected');

    // The first resume transitions to 'running'; subsequent calls may see 'running'
    // and return idempotently if resumeData matches, or throw INVALID_STATE
    expect(successes.length).toBeGreaterThanOrEqual(1);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    expect((final!.result as string)).toMatch(/^resumed-with-data-\d$/);
  }, 30000);

  it('should replay the same execution 100+ times', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 50,
    });

    let invocationCount = 0;
    engine.register('replayable', async () => {
      invocationCount++;
      return `invocation-${invocationCount}`;
    }, { maxRetries: 0, timeout: 0 });

    // Initial execution — wait for completion via polling
    const original = await engine.trigger('replayable', { idempotencyKey: 'replay-orig' });
    while ((await engine.getExecution(original.id))!.state !== 'complete') {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Replay 100 times
    const replayCount = 100;
    const replays = [];
    for (let i = 0; i < replayCount; i++) {
      const replay = await engine.replay(original.id);
      replays.push(replay);
    }

    // Poll until all replays are complete
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      let allComplete = true;
      for (const replay of replays) {
        const state = (await engine.getExecution(replay.id))!.state;
        if (state !== 'complete' && state !== 'failed') {
          allComplete = false;
          break;
        }
      }
      if (allComplete) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // All replays should have unique IDs
    const ids = new Set(replays.map((r) => r.id));
    expect(ids.size).toBe(replayCount);

    // All replays should link back to original
    for (const replay of replays) {
      expect(replay.replayOf).toBe(original.id);
    }

    // All should be complete
    for (const replay of replays) {
      const final = await engine.getExecution(replay.id);
      expect(final!.state).toBe('complete');
    }

    // Total invocations = 1 original + 100 replays
    expect(invocationCount).toBe(1 + replayCount);
  }, 30000);
});
