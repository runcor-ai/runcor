// Integration test for failure scenarios
import { describe, it, expect, vi } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { RetryableError } from '../../src/errors.js';
import { MockProvider } from '../../src/model/mock.js';

describe('Failure Scenarios Integration', () => {
  it('should complete full retry → fail cycle with events', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const stateChanges: Array<{ from: string; to: string }> = [];
    engine.on('execution:state_change', (event) => {
      stateChanges.push({ from: event.from, to: event.to });
    });

    let attempts = 0;
    engine.register('retry-then-fail', async () => {
      attempts++;
      throw new RetryableError(`attempt ${attempts}`);
    }, { maxRetries: 2, baseRetryDelay: 10, maxRetryDelay: 50 });

    const completionPromise = new Promise<any>((resolve) => {
      engine.on('execution:complete', resolve);
    });

    const exec = await engine.trigger('retry-then-fail', { idempotencyKey: 'rf1' });
    const event = await completionPromise;

    expect(event.state).toBe('failed');
    expect(attempts).toBe(3); // 1 original + 2 retries

    // Verify state transitions include retrying
    expect(stateChanges).toContainEqual({ from: 'queued', to: 'running' });
    expect(stateChanges).toContainEqual({ from: 'running', to: 'retrying' });
    expect(stateChanges).toContainEqual({ from: 'retrying', to: 'running' });

    const final = await engine.getExecution(exec.id);
    expect(final!.error!.retryCount).toBe(2);
    expect(final!.timestamps.transitions.length).toBeGreaterThan(2);

    await engine.shutdown();
  }, 10000);

  it('should timeout without affecting other concurrent executions', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    engine.register('slow', async () => {
      await new Promise((r) => setTimeout(r, 5000));
    }, { timeout: 100, maxRetries: 0 });

    engine.register('fast', async () => 'quick result', { maxRetries: 0 });

    const slowExec = await engine.trigger('slow', { idempotencyKey: 'slow-1' });
    const fastExec = await engine.trigger('fast', { idempotencyKey: 'fast-1' });

    // Wait for both to complete
    await new Promise((r) => setTimeout(r, 300));

    const slowFinal = await engine.getExecution(slowExec.id);
    const fastFinal = await engine.getExecution(fastExec.id);

    expect(slowFinal!.state).toBe('failed');
    expect(slowFinal!.error!.code).toBe('TIMEOUT');
    expect(fastFinal!.state).toBe('complete');
    expect(fastFinal!.result).toBe('quick result');

    await engine.shutdown();
  });

  it('should cancel mid-execution and preserve reason', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
      drainTimeout: 100,
    });

    engine.register('cancellable', async () => {
      await new Promise((r) => setTimeout(r, 10000));
    }, { maxRetries: 0 });

    const exec = await engine.trigger('cancellable', { idempotencyKey: 'c1' });
    await new Promise((r) => setTimeout(r, 50)); // Let it start

    await engine.cancel(exec.id, 'User requested cancellation');

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('failed');
    expect(final!.error!.code).toBe('CANCELLED');
    expect(final!.error!.message).toBe('User requested cancellation');

    await engine.shutdown();
  }, 10000);

  it('should handle graceful shutdown with mixed running/queued executions', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 1,
      drainTimeout: 200,
    });

    engine.register('running-flow', async () => {
      await new Promise((r) => setTimeout(r, 5000));
    }, { maxRetries: 0 });

    engine.register('queued-flow', async () => 'queued result', { maxRetries: 0 });

    const running = await engine.trigger('running-flow', { idempotencyKey: 'run-1' });
    const queued = await engine.trigger('queued-flow', { idempotencyKey: 'que-1' });

    // queued-flow should be queued since concurrency=1
    expect(queued.state).toBe('queued');

    await engine.shutdown();

    const runFinal = await engine.getExecution(running.id);
    const queFinal = await engine.getExecution(queued.id);

    // Both should be failed with SHUTDOWN after drain
    expect(runFinal!.state).toBe('failed');
    expect(runFinal!.error!.code).toBe('SHUTDOWN');
    // Queued one should also be failed
    expect(queFinal!.state).toBe('failed');

    expect(engine.getStatus()).toBe('stopped');
  });
});
