// E2E: Every valid and invalid state transition (14 tests)
// Systematic coverage of the state machine — existing tests cover individual transitions
// but not the exhaustive matrix

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import { createWaitSignal } from '../../src/wait-signal.js';
import { RetryableError, EngineError } from '../../src/errors.js';
import { createTestEngine, waitForState, waitForCompletion, delay } from './helpers.js';

let engine: Runcor;

afterEach(async () => {
  if (engine) await engine.shutdown();
});

describe('State transitions: exhaustive matrix', { timeout: 30000 }, () => {
  it('queued → running (normal dispatch)', async () => {
    engine = await createTestEngine();
    const states: string[] = [];
    engine.on('execution:state_change', (e) => states.push(`${e.from}->${e.to}`));

    engine.register('simple-flow', async () => 'done', { maxRetries: 0 });

    const exec = await engine.trigger('simple-flow', { idempotencyKey: 'st-1' });
    await waitForCompletion(engine, exec.id);

    expect(states).toContain('queued->running');
  });

  it('queued → failed (cancel while queued)', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 1,
    });

    // Occupy the only slot
    engine.register('blocking-flow', async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return 'done';
    }, { maxRetries: 0 });

    engine.register('queued-flow', async () => 'done', { maxRetries: 0 });

    // Start the blocking flow
    const blocker = await engine.trigger('blocking-flow', { idempotencyKey: 'block-1' });
    await waitForState(engine, blocker.id, 'running');

    // This should be queued since concurrency=1
    const queued = await engine.trigger('queued-flow', { idempotencyKey: 'q-1' });
    const qState = await engine.getExecution(queued.id);
    expect(qState!.state).toBe('queued');

    // Cancel while queued
    await engine.cancel(queued.id, 'not needed');
    const canceled = await engine.getExecution(queued.id);
    expect(canceled!.state).toBe('failed');
    expect(canceled!.error!.code).toBe('CANCELLED');
  });

  it('running → complete (success)', async () => {
    engine = await createTestEngine();
    const states: string[] = [];
    engine.on('execution:state_change', (e) => states.push(`${e.from}->${e.to}`));

    engine.register('success-flow', async () => 'result', { maxRetries: 0 });

    const exec = await engine.trigger('success-flow', { idempotencyKey: 'rc-1' });
    await waitForCompletion(engine, exec.id);

    expect(states).toContain('running->complete');
    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    expect(final!.result).toBe('result');
  });

  it('running → failed (non-retryable error)', async () => {
    engine = await createTestEngine();
    const states: string[] = [];
    engine.on('execution:state_change', (e) => states.push(`${e.from}->${e.to}`));

    engine.register('fail-flow', async () => {
      throw new Error('permanent failure');
    }, { maxRetries: 0 });

    const exec = await engine.trigger('fail-flow', { idempotencyKey: 'rf-1' });
    await waitForCompletion(engine, exec.id);

    expect(states).toContain('running->failed');
    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('failed');
    expect(final!.error!.message).toContain('permanent failure');
  });

  it('running → waiting (WaitSignal)', async () => {
    engine = await createTestEngine();
    const states: string[] = [];
    engine.on('execution:state_change', (e) => states.push(`${e.from}->${e.to}`));

    engine.register('wait-flow', async () => {
      return createWaitSignal({ reason: 'need input' });
    }, { maxRetries: 0 });

    const exec = await engine.trigger('wait-flow', { idempotencyKey: 'rw-1' });
    await waitForState(engine, exec.id, 'waiting');

    expect(states).toContain('running->waiting');
  });

  it('running → retrying (RetryableError)', async () => {
    engine = await createTestEngine();
    const states: string[] = [];
    engine.on('execution:state_change', (e) => states.push(`${e.from}->${e.to}`));

    let attempt = 0;
    engine.register('retry-flow', async () => {
      attempt++;
      if (attempt < 2) throw new RetryableError('transient');
      return 'ok';
    }, { maxRetries: 3, baseRetryDelay: 10, maxRetryDelay: 50 });

    const exec = await engine.trigger('retry-flow', { idempotencyKey: 'rr-1' });
    await waitForCompletion(engine, exec.id);

    expect(states).toContain('running->retrying');
  });

  it('waiting → running (resume)', async () => {
    engine = await createTestEngine();
    const states: string[] = [];
    engine.on('execution:state_change', (e) => states.push(`${e.from}->${e.to}`));

    engine.register('resume-flow', async (ctx) => {
      if (!ctx.resumeData) return createWaitSignal({ reason: 'pause' });
      return 'resumed';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('resume-flow', { idempotencyKey: 'wr-1' });
    await waitForState(engine, exec.id, 'waiting');

    await engine.resume(exec.id, 'go');
    await waitForCompletion(engine, exec.id);

    expect(states).toContain('waiting->running');
  });

  it('waiting → failed (wait timeout)', async () => {
    engine = await createTestEngine();
    const states: string[] = [];
    engine.on('execution:state_change', (e) => states.push(`${e.from}->${e.to}`));

    engine.register('timeout-wait-flow', async () => {
      return createWaitSignal({ reason: 'waiting' });
    }, { maxRetries: 0, waitTimeout: 50 });

    const exec = await engine.trigger('timeout-wait-flow', { idempotencyKey: 'wf-1' });
    await waitForState(engine, exec.id, 'waiting');
    await waitForCompletion(engine, exec.id);

    expect(states).toContain('waiting->failed');
    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('failed');
    expect(final!.error!.code).toBe('WAIT_TIMEOUT');
  });

  it('waiting → failed (cancel while waiting)', async () => {
    engine = await createTestEngine();

    engine.register('cancel-wait-flow', async () => {
      return createWaitSignal({ reason: 'waiting' });
    }, { maxRetries: 0 });

    const exec = await engine.trigger('cancel-wait-flow', { idempotencyKey: 'cw-1' });
    await waitForState(engine, exec.id, 'waiting');

    await engine.cancel(exec.id, 'no longer needed');
    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('failed');
    expect(final!.error!.code).toBe('CANCELLED');
  });

  it('retrying → running (retry fires)', async () => {
    engine = await createTestEngine();
    const states: string[] = [];
    engine.on('execution:state_change', (e) => states.push(`${e.from}->${e.to}`));

    let attempt = 0;
    engine.register('retry-fire-flow', async () => {
      attempt++;
      if (attempt < 2) throw new RetryableError('transient');
      return 'ok';
    }, { maxRetries: 3, baseRetryDelay: 10, maxRetryDelay: 50 });

    const exec = await engine.trigger('retry-fire-flow', { idempotencyKey: 'rtf-1' });
    await waitForCompletion(engine, exec.id);

    expect(states).toContain('retrying->running');
  });

  it('retrying → failed (cancel during retry backoff)', async () => {
    engine = await createTestEngine();

    engine.register('cancel-retry-flow', async () => {
      throw new RetryableError('keep retrying');
    }, { maxRetries: 10, baseRetryDelay: 2000, maxRetryDelay: 5000 });

    const exec = await engine.trigger('cancel-retry-flow', { idempotencyKey: 'cr-1' });
    await waitForState(engine, exec.id, 'retrying');

    await engine.cancel(exec.id, 'abort');
    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('failed');
    expect(final!.error!.code).toBe('CANCELLED');
  });

  it('complete is terminal — no operations change state', async () => {
    engine = await createTestEngine();

    engine.register('terminal-complete', async () => 'done', { maxRetries: 0 });

    const exec = await engine.trigger('terminal-complete', { idempotencyKey: 'tc-1' });
    await waitForCompletion(engine, exec.id);

    // Cancel should fail
    await expect(
      engine.cancel(exec.id),
    ).rejects.toThrow(/Cannot cancel|INVALID_STATE/i);

    // Resume should fail
    await expect(
      engine.resume(exec.id, 'data'),
    ).rejects.toThrow(/Cannot resume|INVALID_STATE/i);

    // State unchanged
    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
  });

  it('failed is terminal — no operations change state', async () => {
    engine = await createTestEngine();

    engine.register('terminal-failed', async () => {
      throw new Error('fail');
    }, { maxRetries: 0 });

    const exec = await engine.trigger('terminal-failed', { idempotencyKey: 'tf-1' });
    await waitForCompletion(engine, exec.id);

    // Cancel should fail
    await expect(
      engine.cancel(exec.id),
    ).rejects.toThrow(/Cannot cancel|INVALID_STATE/i);

    // Resume should fail
    await expect(
      engine.resume(exec.id, 'data'),
    ).rejects.toThrow(/Cannot resume|INVALID_STATE/i);

    // State unchanged
    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('failed');
  });

  it('invalid transitions rejected', async () => {
    engine = await createTestEngine();

    engine.register('inv-flow', async (ctx) => {
      if (!ctx.resumeData) return createWaitSignal({ reason: 'pause' });
      return 'ok';
    }, { maxRetries: 0 });

    // Create a completed execution
    engine.register('done-flow', async () => 'done', { maxRetries: 0 });
    const doneExec = await engine.trigger('done-flow', { idempotencyKey: 'inv-done' });
    await waitForCompletion(engine, doneExec.id);

    // complete → running (via resume) should fail
    await expect(
      engine.resume(doneExec.id, 'data'),
    ).rejects.toThrow();

    // Create a failed execution
    engine.register('err-flow', async () => { throw new Error('fail'); }, { maxRetries: 0 });
    const errExec = await engine.trigger('err-flow', { idempotencyKey: 'inv-err' });
    await waitForCompletion(engine, errExec.id);

    // failed → running (via resume) should fail
    await expect(
      engine.resume(errExec.id, 'data'),
    ).rejects.toThrow();
  });
});
