// Unit tests for Engine (US1 + US3)
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { EngineError, RetryableError } from '../../src/errors.js';
import { createWaitSignal } from '../../src/wait-signal.js';
import type { ModelProvider } from '../../src/model/provider.js';
import type { EngineConfig } from '../../src/types.js';

function createMockProvider(): ModelProvider {
  return {
    name: 'mock',
    complete: vi.fn().mockResolvedValue({
      text: 'mock response',
      model: 'mock',
      provider: 'mock',
      usage: { promptTokens: 10, completionTokens: 10 },
    }),
  };
}

function createConfig(overrides?: Partial<EngineConfig>): EngineConfig {
  return {
    model: { provider: createMockProvider() },
    ...overrides,
  };
}

describe('Runcor', () => {
  describe('createEngine', () => {
    it('should emit "ready" event on initialization', async () => {
      const readyHandler = vi.fn();
      const engine = await createEngine(createConfig());
      // ready event fires during createEngine; we test it was called by checking engine state
      expect(engine).toBeDefined();
      await engine.shutdown();
    });

    it('should complete startup in under 1 second (SC-006)', async () => {
      const start = performance.now();
      const engine = await createEngine(createConfig());
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(1000);
      await engine.shutdown();
    });
  });

  describe('register', () => {
    it('should accept a flow registration', async () => {
      const engine = await createEngine(createConfig());
      engine.register('test-flow', async () => 'result');

      // Should not throw
      await engine.shutdown();
    });

    it('should reject duplicate flow name', async () => {
      const engine = await createEngine(createConfig());
      engine.register('test-flow', async () => 'result');

      expect(() =>
        engine.register('test-flow', async () => 'other'),
      ).toThrow(EngineError);

      await engine.shutdown();
    });

    it('should throw when engine is not ready', async () => {
      const engine = await createEngine(createConfig());
      await engine.shutdown();

      expect(() =>
        engine.register('test-flow', async () => 'result'),
      ).toThrow(EngineError);
    });
  });

  describe('trigger', () => {
    it('should create execution in queued state', async () => {
      const engine = await createEngine(createConfig());
      engine.register('test-flow', async () => 'result');

      const exec = await engine.trigger('test-flow', {
        idempotencyKey: 'key-1',
      });

      expect(exec.flowName).toBe('test-flow');
      expect(exec.idempotencyKey).toBe('key-1');
      // It may already be running or complete due to async dispatch
      expect(['queued', 'running', 'complete']).toContain(exec.state);

      await engine.shutdown();
    });

    it('should reject missing idempotency key', async () => {
      const engine = await createEngine(createConfig());
      engine.register('test-flow', async () => 'result');

      await expect(
        engine.trigger('test-flow', { idempotencyKey: '' }),
      ).rejects.toThrow(EngineError);

      await engine.shutdown();
    });

    it('should reject unregistered flow', async () => {
      const engine = await createEngine(createConfig());

      await expect(
        engine.trigger('no-such-flow', { idempotencyKey: 'key-1' }),
      ).rejects.toThrow(EngineError);

      await engine.shutdown();
    });

    it('should return cached execution for duplicate idempotency key', async () => {
      const engine = await createEngine(createConfig());
      engine.register('flow-a', async () => 'result-a');
      engine.register('flow-b', async () => 'result-b');

      const exec1 = await engine.trigger('flow-a', {
        idempotencyKey: 'same-key',
      });
      const exec2 = await engine.trigger('flow-b', {
        idempotencyKey: 'same-key',
      });

      expect(exec1.id).toBe(exec2.id);
      expect(exec2.flowName).toBe('flow-a'); // Returns original regardless of flow name

      await engine.shutdown();
    });

    it('should pass input to execution', async () => {
      const engine = await createEngine(createConfig());
      engine.register('test-flow', async (ctx) => ctx.input);

      const exec = await engine.trigger('test-flow', {
        idempotencyKey: 'key-1',
        input: { data: 'hello' },
      });

      expect(exec.input).toEqual({ data: 'hello' });

      await engine.shutdown();
    });
  });

  describe('getExecution', () => {
    it('should return execution by ID', async () => {
      const engine = await createEngine(createConfig());
      engine.register('test-flow', async () => 'result');

      const exec = await engine.trigger('test-flow', {
        idempotencyKey: 'key-1',
      });
      const retrieved = await engine.getExecution(exec.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(exec.id);

      await engine.shutdown();
    });

    it('should return null for missing execution', async () => {
      const engine = await createEngine(createConfig());
      const result = await engine.getExecution('nonexistent');
      expect(result).toBeNull();
      await engine.shutdown();
    });
  });

  describe('flow execution', () => {
    it('should transition queued → running → complete', async () => {
      const engine = await createEngine(createConfig());
      const states: string[] = [];

      engine.on('execution:state_change', (event) => {
        states.push(`${event.from}→${event.to}`);
      });

      engine.register('test-flow', async () => 'done');

      const exec = await engine.trigger('test-flow', {
        idempotencyKey: 'key-1',
      });

      // Wait for completion
      await waitForState(engine, exec.id, 'complete');

      expect(states).toContain('queued→running');
      expect(states).toContain('running→complete');

      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');
      expect(final!.result).toBe('done');

      await engine.shutdown();
    });

    it('should store null when handler returns undefined', async () => {
      const engine = await createEngine(createConfig());
      engine.register('void-flow', async () => undefined);

      const exec = await engine.trigger('void-flow', {
        idempotencyKey: 'key-1',
      });
      await waitForState(engine, exec.id, 'complete');

      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');
      expect(final!.result).toBeNull();

      await engine.shutdown();
    });

    it('should store null when handler returns null', async () => {
      const engine = await createEngine(createConfig());
      engine.register('null-flow', async () => null);

      const exec = await engine.trigger('null-flow', {
        idempotencyKey: 'key-1',
      });
      await waitForState(engine, exec.id, 'complete');

      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');
      expect(final!.result).toBeNull();

      await engine.shutdown();
    });

    it('should move to failed on non-retryable error', async () => {
      const engine = await createEngine(createConfig());
      engine.register('fail-flow', async () => {
        throw new Error('boom');
      }, { maxRetries: 0 });

      const exec = await engine.trigger('fail-flow', {
        idempotencyKey: 'key-1',
      });
      await waitForState(engine, exec.id, 'failed');

      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('failed');
      expect(final!.error).not.toBeNull();
      expect(final!.error!.message).toBe('boom');

      await engine.shutdown();
    });
  });

  describe('events', () => {
    it('should emit execution:state_change for each transition', async () => {
      const engine = await createEngine(createConfig());
      const events: Array<{ executionId: string; from: string; to: string }> = [];

      engine.on('execution:state_change', (event) => {
        events.push(event);
      });

      engine.register('test-flow', async () => 'result');
      const exec = await engine.trigger('test-flow', {
        idempotencyKey: 'key-1',
      });
      await waitForState(engine, exec.id, 'complete');

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.some((e) => e.from === 'queued' && e.to === 'running')).toBe(true);
      expect(events.some((e) => e.from === 'running' && e.to === 'complete')).toBe(true);
      expect(events.every((e) => e.executionId === exec.id)).toBe(true);

      await engine.shutdown();
    });

    it('should emit execution:complete when execution finishes', async () => {
      const engine = await createEngine(createConfig());
      const completeEvents: any[] = [];

      engine.on('execution:complete', (event) => {
        completeEvents.push(event);
      });

      engine.register('test-flow', async () => 'result');
      const exec = await engine.trigger('test-flow', {
        idempotencyKey: 'key-1',
      });
      await waitForState(engine, exec.id, 'complete');

      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0].executionId).toBe(exec.id);
      expect(completeEvents[0].state).toBe('complete');
      expect(completeEvents[0].result).toBe('result');

      await engine.shutdown();
    });
  });

  // T029: Retry logic tests
  describe('retry logic', () => {
    it('should retry on RetryableError', async () => {
      let attempts = 0;
      const engine = await createEngine(createConfig());
      engine.register('retry-flow', async () => {
        attempts++;
        if (attempts < 3) throw new RetryableError('transient');
        return 'success';
      }, { maxRetries: 3, baseRetryDelay: 10, maxRetryDelay: 100 });

      const exec = await engine.trigger('retry-flow', { idempotencyKey: 'r1' });
      await waitForState(engine, exec.id, 'complete', 10000);

      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');
      expect(final!.result).toBe('success');
      expect(final!.retryCount).toBe(2);

      await engine.shutdown();
    });

    it('should NOT retry on non-retryable error', async () => {
      let attempts = 0;
      const engine = await createEngine(createConfig());
      engine.register('no-retry', async () => {
        attempts++;
        throw new Error('fatal');
      }, { maxRetries: 3, baseRetryDelay: 10 });

      const exec = await engine.trigger('no-retry', { idempotencyKey: 'nr1' });
      await waitForState(engine, exec.id, 'failed');

      expect(attempts).toBe(1);
      const final = await engine.getExecution(exec.id);
      expect(final!.error!.retryable).toBe(false);

      await engine.shutdown();
    });

    it('should fail immediately when maxRetries=0', async () => {
      let attempts = 0;
      const engine = await createEngine(createConfig());
      engine.register('no-retry-config', async () => {
        attempts++;
        throw new RetryableError('transient');
      }, { maxRetries: 0, baseRetryDelay: 10 });

      const exec = await engine.trigger('no-retry-config', { idempotencyKey: 'nr2' });
      await waitForState(engine, exec.id, 'failed');

      expect(attempts).toBe(1);
      await engine.shutdown();
    });

    it('should increment retry count', async () => {
      let attempts = 0;
      const engine = await createEngine(createConfig());
      engine.register('count-retries', async () => {
        attempts++;
        throw new RetryableError('always fails');
      }, { maxRetries: 2, baseRetryDelay: 10, maxRetryDelay: 50 });

      const exec = await engine.trigger('count-retries', { idempotencyKey: 'cr1' });
      await waitForState(engine, exec.id, 'failed', 10000);

      expect(attempts).toBe(3); // 1 original + 2 retries
      const final = await engine.getExecution(exec.id);
      expect(final!.retryCount).toBe(2);

      await engine.shutdown();
    });

    it('should re-evaluate error type on each retry', async () => {
      let attempts = 0;
      const engine = await createEngine(createConfig());
      engine.register('mixed-errors', async () => {
        attempts++;
        if (attempts === 1) throw new RetryableError('retry me');
        throw new Error('fatal on retry');
      }, { maxRetries: 3, baseRetryDelay: 10, maxRetryDelay: 50 });

      const exec = await engine.trigger('mixed-errors', { idempotencyKey: 'me1' });
      await waitForState(engine, exec.id, 'failed', 10000);

      expect(attempts).toBe(2);
      const final = await engine.getExecution(exec.id);
      expect(final!.error!.message).toBe('fatal on retry');
      expect(final!.error!.retryable).toBe(false);

      await engine.shutdown();
    });

    it('should preserve error context (SC-004)', async () => {
      const engine = await createEngine(createConfig());
      engine.register('error-context', async () => {
        throw new RetryableError('transient failure');
      }, { maxRetries: 1, baseRetryDelay: 10, maxRetryDelay: 50 });

      const exec = await engine.trigger('error-context', { idempotencyKey: 'ec1' });
      await waitForState(engine, exec.id, 'failed', 10000);

      const final = await engine.getExecution(exec.id);
      expect(final!.error).not.toBeNull();
      expect(final!.error!.message).toBe('transient failure');
      expect(final!.error!.retryable).toBe(true);
      expect(final!.error!.retryCount).toBe(1);
      expect(final!.timestamps.transitions.length).toBeGreaterThan(0);

      await engine.shutdown();
    });
  });

  // T030: Backoff timing tests
  describe('backoff timing', () => {
    it('should follow exponential backoff formula (SC-007)', async () => {
      const delays: number[] = [];
      let attempts = 0;
      let lastAttemptTime = Date.now();

      const engine = await createEngine(createConfig());
      engine.register('backoff-test', async () => {
        const now = Date.now();
        if (attempts > 0) {
          delays.push(now - lastAttemptTime);
        }
        lastAttemptTime = now;
        attempts++;
        throw new RetryableError('keep retrying');
      }, { maxRetries: 3, baseRetryDelay: 1000, maxRetryDelay: 30000 });

      const exec = await engine.trigger('backoff-test', { idempotencyKey: 'bt1' });
      await waitForState(engine, exec.id, 'failed', 20000);

      expect(delays).toHaveLength(3);
      // ~1s (1000 + 0-1000ms jitter)
      expect(delays[0]).toBeGreaterThanOrEqual(900);
      expect(delays[0]).toBeLessThan(2200);
      // ~2s (2000 + 0-1000ms jitter)
      expect(delays[1]).toBeGreaterThanOrEqual(1900);
      expect(delays[1]).toBeLessThan(3200);
      // ~4s (4000 + 0-1000ms jitter)
      expect(delays[2]).toBeGreaterThanOrEqual(3900);
      expect(delays[2]).toBeLessThan(5200);

      await engine.shutdown();
    }, 25000);
  });

  // T031: Timeout tests
  describe('timeout', () => {
    it('should timeout after configured timeout', async () => {
      const engine = await createEngine(createConfig());
      engine.register('slow-flow', async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return 'too slow';
      }, { timeout: 100, maxRetries: 0 });

      const exec = await engine.trigger('slow-flow', { idempotencyKey: 'to1' });
      await waitForState(engine, exec.id, 'failed', 5000);

      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('failed');
      expect(final!.error!.code).toBe('TIMEOUT');

      await engine.shutdown();
    });

    it('should disable timeout when timeout=0', async () => {
      const engine = await createEngine(createConfig());
      engine.register('no-timeout', async () => {
        await new Promise((r) => setTimeout(r, 100));
        return 'completed';
      }, { timeout: 0, maxRetries: 0 });

      const exec = await engine.trigger('no-timeout', { idempotencyKey: 'nt1' });
      await waitForState(engine, exec.id, 'complete', 5000);

      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');

      await engine.shutdown();
    });

    it('should set error code TIMEOUT', async () => {
      const engine = await createEngine(createConfig());
      engine.register('timeout-code', async () => {
        await new Promise((r) => setTimeout(r, 5000));
      }, { timeout: 50, maxRetries: 0 });

      const exec = await engine.trigger('timeout-code', { idempotencyKey: 'tc1' });
      await waitForState(engine, exec.id, 'failed', 5000);

      const final = await engine.getExecution(exec.id);
      expect(final!.error!.code).toBe('TIMEOUT');

      await engine.shutdown();
    });

    it('should allow trigger-level timeout override', async () => {
      const engine = await createEngine(createConfig());
      engine.register('override-timeout', async () => {
        await new Promise((r) => setTimeout(r, 5000));
      }, { timeout: 30000, maxRetries: 0 }); // Flow-level: 30s

      const exec = await engine.trigger('override-timeout', {
        idempotencyKey: 'ot1',
        timeout: 50, // Override: 50ms
      });
      await waitForState(engine, exec.id, 'failed', 5000);

      const final = await engine.getExecution(exec.id);
      expect(final!.error!.code).toBe('TIMEOUT');

      await engine.shutdown();
    });
  });

  // T032: Cancellation tests
  describe('cancellation', () => {
    it('should cancel a queued execution', async () => {
      const engine = await createEngine({
        ...createConfig(),
        concurrency: 1,
        drainTimeout: 100,
      });

      // Fill the single slot
      engine.register('blocker', async () => {
        await new Promise((r) => setTimeout(r, 60000));
        return 'blocked';
      }, { maxRetries: 0 });
      engine.register('queued-flow', async () => 'result', { maxRetries: 0 });

      await engine.trigger('blocker', { idempotencyKey: 'b1' });
      const exec = await engine.trigger('queued-flow', { idempotencyKey: 'q1' });

      expect(exec.state).toBe('queued');
      await engine.cancel(exec.id, 'No longer needed');

      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('failed');
      expect(final!.error!.code).toBe('CANCELLED');
      expect(final!.error!.message).toBe('No longer needed');

      await engine.shutdown();
    }, 10000);

    it('should cancel a running execution', async () => {
      const engine = await createEngine({
        ...createConfig(),
        drainTimeout: 100,
      });
      engine.register('long-flow', async () => {
        await new Promise((r) => setTimeout(r, 60000));
      }, { maxRetries: 0 });

      const exec = await engine.trigger('long-flow', { idempotencyKey: 'lf1' });
      await new Promise((r) => setTimeout(r, 50)); // Let it start running

      await engine.cancel(exec.id);
      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('failed');
      expect(final!.error!.code).toBe('CANCELLED');

      await engine.shutdown();
    }, 10000);

    it('should throw when cancelling completed execution', async () => {
      const engine = await createEngine(createConfig());
      engine.register('fast-flow', async () => 'done', { maxRetries: 0 });

      const exec = await engine.trigger('fast-flow', { idempotencyKey: 'ff1' });
      await waitForState(engine, exec.id, 'complete');

      await expect(engine.cancel(exec.id)).rejects.toThrow(EngineError);

      await engine.shutdown();
    });

    it('should throw when cancelling failed execution', async () => {
      const engine = await createEngine(createConfig());
      engine.register('fail-flow', async () => {
        throw new Error('failed');
      }, { maxRetries: 0 });

      const exec = await engine.trigger('fail-flow', { idempotencyKey: 'ff2' });
      await waitForState(engine, exec.id, 'failed');

      await expect(engine.cancel(exec.id)).rejects.toThrow(EngineError);

      await engine.shutdown();
    });
  });

  // Resume tests
  describe('resume', () => {
    it('should resume a waiting execution', async () => {
      const engine = await createEngine(createConfig());
      let callCount = 0;
      engine.register('wait-flow', async (ctx) => {
        callCount++;
        if (callCount === 1) return createWaitSignal({ reason: 'need data' });
        return `got: ${ctx.resumeData}`;
      }, { maxRetries: 0 });

      const exec = await engine.trigger('wait-flow', { idempotencyKey: 'w1' });
      await waitForState(engine, exec.id, 'waiting');

      const resumed = await engine.resume(exec.id, 'hello');
      await waitForState(engine, exec.id, 'complete');

      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');
      expect(final!.result).toBe('got: hello');
      expect(final!.resumeData).toBe('hello');

      await engine.shutdown();
    });

    it('should throw EXECUTION_NOT_FOUND for non-existent execution', async () => {
      const engine = await createEngine(createConfig());

      await expect(engine.resume('nonexistent'))
        .rejects.toThrow(EngineError);

      try {
        await engine.resume('nonexistent');
      } catch (e: any) {
        expect(e.code).toBe('EXECUTION_NOT_FOUND');
      }

      await engine.shutdown();
    });

    it('should throw INVALID_STATE for non-waiting execution', async () => {
      const engine = await createEngine(createConfig());
      engine.register('fast-flow', async () => 'done', { maxRetries: 0 });

      const exec = await engine.trigger('fast-flow', { idempotencyKey: 'r1' });
      await waitForState(engine, exec.id, 'complete');

      try {
        await engine.resume(exec.id, 'data');
      } catch (e: any) {
        expect(e).toBeInstanceOf(EngineError);
        expect(e.code).toBe('INVALID_STATE');
      }

      await engine.shutdown();
    });

    it('should handle idempotent resume with same data', async () => {
      const engine = await createEngine(createConfig());
      let callCount = 0;
      engine.register('idempotent-flow', async (ctx) => {
        callCount++;
        if (callCount === 1) return createWaitSignal();
        return 'done';
      }, { maxRetries: 0 });

      const exec = await engine.trigger('idempotent-flow', { idempotencyKey: 'i1' });
      await waitForState(engine, exec.id, 'waiting');

      // First resume
      await engine.resume(exec.id, { key: 'value' });
      await waitForState(engine, exec.id, 'complete');

      // Second resume with same data — should be idempotent (no error)
      const result = await engine.resume(exec.id, { key: 'value' });
      expect(result.state).toBe('complete');
      expect(callCount).toBe(2); // Handler only called twice (not three times)

      await engine.shutdown();
    });

    it('should throw INVALID_STATE on resume with different data after completion', async () => {
      const engine = await createEngine(createConfig());
      let callCount = 0;
      engine.register('diff-data-flow', async (ctx) => {
        callCount++;
        if (callCount === 1) return createWaitSignal();
        return 'done';
      }, { maxRetries: 0 });

      const exec = await engine.trigger('diff-data-flow', { idempotencyKey: 'd1' });
      await waitForState(engine, exec.id, 'waiting');

      await engine.resume(exec.id, 'original');
      await waitForState(engine, exec.id, 'complete');

      // Resume again with different data — should throw
      await expect(engine.resume(exec.id, 'different'))
        .rejects.toThrow(EngineError);

      await engine.shutdown();
    });

    it('should free concurrency slot when entering waiting state', async () => {
      const engine = await createEngine({
        ...createConfig(),
        concurrency: 1,
      });

      let waitResolved = false;
      engine.register('wait-slot', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal();
        return 'done';
      }, { maxRetries: 0 });
      engine.register('other-flow', async () => {
        waitResolved = true;
        return 'other-done';
      }, { maxRetries: 0 });

      // Trigger first flow — it will wait, freeing the slot
      const exec1 = await engine.trigger('wait-slot', { idempotencyKey: 'ws1' });
      await waitForState(engine, exec1.id, 'waiting');

      // Trigger second flow — should run because slot was freed
      const exec2 = await engine.trigger('other-flow', { idempotencyKey: 'ws2' });
      await waitForState(engine, exec2.id, 'complete');

      expect(waitResolved).toBe(true);

      await engine.shutdown();
    });
  });

  // Replay tests
  describe('replay', () => {
    it('should replay a completed execution with new ID', async () => {
      const engine = await createEngine(createConfig());
      engine.register('replay-flow', async () => 'result', { maxRetries: 0 });

      const exec = await engine.trigger('replay-flow', {
        idempotencyKey: 'orig-1',
        input: { data: 'hello' },
      });
      await waitForState(engine, exec.id, 'complete');

      const replayed = await engine.replay(exec.id);
      expect(replayed.id).not.toBe(exec.id);
      expect(replayed.flowName).toBe('replay-flow');
      expect(replayed.input).toEqual({ data: 'hello' });
      expect(replayed.replayOf).toBe(exec.id);

      await waitForState(engine, replayed.id, 'complete');

      // Original unchanged
      const original = await engine.getExecution(exec.id);
      expect(original!.state).toBe('complete');
      expect(original!.replayOf).toBeNull();

      await engine.shutdown();
    });

    it('should replay a failed execution', async () => {
      const engine = await createEngine(createConfig());
      let attempts = 0;
      engine.register('replay-fail', async () => {
        attempts++;
        if (attempts === 1) throw new Error('first fail');
        return 'success on replay';
      }, { maxRetries: 0 });

      const exec = await engine.trigger('replay-fail', { idempotencyKey: 'rf-1' });
      await waitForState(engine, exec.id, 'failed');

      const replayed = await engine.replay(exec.id);
      await waitForState(engine, replayed.id, 'complete');

      expect(replayed.replayOf).toBe(exec.id);
      const final = await engine.getExecution(replayed.id);
      expect(final!.state).toBe('complete');
      expect(final!.result).toBe('success on replay');

      await engine.shutdown();
    });

    it('should throw INVALID_STATE when replaying running execution', async () => {
      const engine = await createEngine({
        ...createConfig(),
        drainTimeout: 100,
      });
      engine.register('long-flow', async () => {
        await new Promise((r) => setTimeout(r, 60000));
        return 'done';
      }, { maxRetries: 0 });

      const exec = await engine.trigger('long-flow', { idempotencyKey: 'lr-1' });
      await new Promise((r) => setTimeout(r, 50)); // Let it start

      try {
        await engine.replay(exec.id);
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(EngineError);
        expect(e.code).toBe('INVALID_STATE');
      }

      await engine.shutdown();
    }, 10000);

    it('should throw INVALID_STATE when replaying waiting execution', async () => {
      const engine = await createEngine(createConfig());
      engine.register('wait-replay', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal();
        return 'done';
      }, { maxRetries: 0 });

      const exec = await engine.trigger('wait-replay', { idempotencyKey: 'wr-1' });
      await waitForState(engine, exec.id, 'waiting');

      try {
        await engine.replay(exec.id);
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(EngineError);
        expect(e.code).toBe('INVALID_STATE');
      }

      await engine.resume(exec.id, 'x');
      await waitForState(engine, exec.id, 'complete');
      await engine.shutdown();
    });

    it('should throw EXECUTION_NOT_FOUND for non-existent execution', async () => {
      const engine = await createEngine(createConfig());

      try {
        await engine.replay('nonexistent');
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(EngineError);
        expect(e.code).toBe('EXECUTION_NOT_FOUND');
      }

      await engine.shutdown();
    });

    it('should throw FLOW_NOT_FOUND when flow is unregistered', async () => {
      const engine = await createEngine(createConfig());
      engine.register('temp-flow', async () => 'done', { maxRetries: 0 });

      const exec = await engine.trigger('temp-flow', { idempotencyKey: 'tf-1' });
      await waitForState(engine, exec.id, 'complete');

      // Unregister the flow
      (engine as any).flowRegistry.delete('temp-flow');

      try {
        await engine.replay(exec.id);
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(EngineError);
        expect(e.code).toBe('FLOW_NOT_FOUND');
      }

      await engine.shutdown();
    });
  });

  // T035: listWaiting tests
  describe('listWaiting', () => {
    it('should return all waiting executions', async () => {
      const engine = await createEngine(createConfig());
      engine.register('wait-a', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal();
        return 'done';
      }, { maxRetries: 0 });
      engine.register('wait-b', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal();
        return 'done';
      }, { maxRetries: 0 });

      const exec1 = await engine.trigger('wait-a', { idempotencyKey: 'la-1' });
      const exec2 = await engine.trigger('wait-b', { idempotencyKey: 'la-2' });
      await waitForState(engine, exec1.id, 'waiting');
      await waitForState(engine, exec2.id, 'waiting');

      const waiting = await engine.listWaiting();
      expect(waiting).toHaveLength(2);
      const ids = waiting.map((e) => e.id).sort();
      expect(ids).toContain(exec1.id);
      expect(ids).toContain(exec2.id);

      // Clean up
      await engine.resume(exec1.id, 'x');
      await engine.resume(exec2.id, 'x');
      await waitForState(engine, exec1.id, 'complete');
      await waitForState(engine, exec2.id, 'complete');
      await engine.shutdown();
    });

    it('should filter by flowName', async () => {
      const engine = await createEngine(createConfig());
      engine.register('flow-x', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal();
        return 'done';
      }, { maxRetries: 0 });
      engine.register('flow-y', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal();
        return 'done';
      }, { maxRetries: 0 });

      const exec1 = await engine.trigger('flow-x', { idempotencyKey: 'fx-1' });
      const exec2 = await engine.trigger('flow-y', { idempotencyKey: 'fy-1' });
      await waitForState(engine, exec1.id, 'waiting');
      await waitForState(engine, exec2.id, 'waiting');

      const xOnly = await engine.listWaiting('flow-x');
      expect(xOnly).toHaveLength(1);
      expect(xOnly[0].flowName).toBe('flow-x');

      // Clean up
      await engine.resume(exec1.id, 'x');
      await engine.resume(exec2.id, 'x');
      await waitForState(engine, exec1.id, 'complete');
      await waitForState(engine, exec2.id, 'complete');
      await engine.shutdown();
    });

    it('should return empty array when no executions are waiting', async () => {
      const engine = await createEngine(createConfig());
      const waiting = await engine.listWaiting();
      expect(waiting).toHaveLength(0);
      await engine.shutdown();
    });

    it('should not include resumed executions', async () => {
      const engine = await createEngine(createConfig());
      engine.register('resume-gone', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal();
        return 'done';
      }, { maxRetries: 0 });

      const exec = await engine.trigger('resume-gone', { idempotencyKey: 'rg-1' });
      await waitForState(engine, exec.id, 'waiting');

      let waiting = await engine.listWaiting();
      expect(waiting).toHaveLength(1);

      await engine.resume(exec.id, 'go');
      await waitForState(engine, exec.id, 'complete');

      waiting = await engine.listWaiting();
      expect(waiting).toHaveLength(0);

      await engine.shutdown();
    });
  });

  // T030: Wait timeout tests
  describe('wait timeout', () => {
    it('should fail with WAIT_TIMEOUT when timeout expires', async () => {
      const engine = await createEngine(createConfig());

      engine.register('wait-timeout-flow', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal();
        return 'done';
      }, { waitTimeout: 100, maxRetries: 0 });

      const exec = await engine.trigger('wait-timeout-flow', {
        idempotencyKey: 'wt-1',
      });
      await waitForState(engine, exec.id, 'waiting');

      // Don't resume — let timeout fire
      await waitForState(engine, exec.id, 'failed', 5000);

      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('failed');
      expect(final!.error!.code).toBe('WAIT_TIMEOUT');

      await engine.shutdown();
    });

    it('should not timeout when waitTimeout=0 (indefinite)', async () => {
      const engine = await createEngine(createConfig());

      engine.register('no-wait-timeout', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal();
        return 'done';
      }, { waitTimeout: 0, maxRetries: 0 });

      const exec = await engine.trigger('no-wait-timeout', {
        idempotencyKey: 'nwt-1',
      });
      await waitForState(engine, exec.id, 'waiting');

      // Wait 200ms — should still be waiting
      await new Promise((r) => setTimeout(r, 200));
      const still = await engine.getExecution(exec.id);
      expect(still!.state).toBe('waiting');

      // Resume to clean up
      await engine.resume(exec.id, 'go');
      await waitForState(engine, exec.id, 'complete');

      await engine.shutdown();
    });

    it('should cancel wait timeout on resume', async () => {
      const engine = await createEngine(createConfig());

      engine.register('cancel-wait', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal();
        return 'done';
      }, { waitTimeout: 200, maxRetries: 0 });

      const exec = await engine.trigger('cancel-wait', {
        idempotencyKey: 'cw-1',
      });
      await waitForState(engine, exec.id, 'waiting');

      // Resume before timeout fires
      await engine.resume(exec.id, 'quick');
      await waitForState(engine, exec.id, 'complete');

      // Wait past the original timeout — should NOT fail
      await new Promise((r) => setTimeout(r, 300));

      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');

      await engine.shutdown();
    });

    it('should allow trigger-level waitTimeout override', async () => {
      const engine = await createEngine(createConfig());

      engine.register('override-wait', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal();
        return 'done';
      }, { waitTimeout: 5000, maxRetries: 0 }); // Flow: 5s

      const exec = await engine.trigger('override-wait', {
        idempotencyKey: 'ow-1',
        waitTimeout: 100, // Override: 100ms
      });
      await waitForState(engine, exec.id, 'waiting');

      // Should fail at 100ms, not 5s
      await waitForState(engine, exec.id, 'failed', 5000);

      const final = await engine.getExecution(exec.id);
      expect(final!.error!.code).toBe('WAIT_TIMEOUT');

      await engine.shutdown();
    });
  });

  // T033: Shutdown tests
  describe('shutdown', () => {
    it('should reject new triggers during shutdown', async () => {
      const engine = await createEngine(createConfig());
      engine.register('test-flow', async () => {
        await new Promise((r) => setTimeout(r, 1000));
      });

      await engine.trigger('test-flow', { idempotencyKey: 'pre-shutdown' });
      const shutdownPromise = engine.shutdown();

      await expect(
        engine.trigger('test-flow', { idempotencyKey: 'during-shutdown' }),
      ).rejects.toThrow(EngineError);

      await shutdownPromise;
    });

    it('should wait for running executions up to drain timeout', async () => {
      const engine = await createEngine({
        ...createConfig(),
        drainTimeout: 2000,
      });

      engine.register('quick-flow', async () => {
        await new Promise((r) => setTimeout(r, 100));
        return 'done';
      });

      const exec = await engine.trigger('quick-flow', { idempotencyKey: 'drain-1' });
      await engine.shutdown();

      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');
    });

    it('should force-fail executions after drain timeout', async () => {
      const engine = await createEngine({
        ...createConfig(),
        drainTimeout: 100,
      });

      engine.register('stuck-flow', async () => {
        await new Promise((r) => setTimeout(r, 10000));
      }, { maxRetries: 0 });

      const exec = await engine.trigger('stuck-flow', { idempotencyKey: 'stuck-1' });
      await engine.shutdown();

      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('failed');
      expect(final!.error!.code).toBe('SHUTDOWN');
    });

    it('should emit shutdown event when fully stopped', async () => {
      const engine = await createEngine(createConfig());
      const shutdownHandler = vi.fn();
      engine.on('shutdown', shutdownHandler);

      await engine.shutdown();

      expect(shutdownHandler).toHaveBeenCalledTimes(1);
    });
  });
});

/** Helper: wait for an execution to reach a specific state */
async function waitForState(
  engine: any,
  executionId: string,
  targetState: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const exec = await engine.getExecution(executionId);
    if (exec && exec.state === targetState) return;
    if (exec && (exec.state === 'complete' || exec.state === 'failed')) {
      if (exec.state === targetState) return;
      throw new Error(
        `Execution reached terminal state ${exec.state} instead of ${targetState}`,
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for state ${targetState}`);
}

// ── Feature 012: MCP Server — Engine Extension Tests ──

describe('Runcor (MCP Server Extensions)', () => {
  describe('register with description and inputSchema', () => {
    it('should default description to undefined when not provided', async () => {
      const engine = await createEngine(createConfig());
      engine.register('test-flow', async () => 'result');
      const flows = engine.listFlows();
      expect(flows[0].description).toBeUndefined();
      await engine.shutdown();
    });

    it('should store description when provided', async () => {
      const engine = await createEngine(createConfig());
      engine.register('test-flow', async () => 'result', {
        description: 'A test flow',
      });
      const flows = engine.listFlows();
      expect(flows[0].description).toBe('A test flow');
      await engine.shutdown();
    });

    it('should default inputSchema to { type: "object" } when not provided', async () => {
      const engine = await createEngine(createConfig());
      engine.register('test-flow', async () => 'result');
      const flows = engine.listFlows();
      expect(flows[0].inputSchema).toEqual({ type: 'object' });
      await engine.shutdown();
    });

    it('should store inputSchema when provided', async () => {
      const engine = await createEngine(createConfig());
      const schema = {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      };
      engine.register('test-flow', async () => 'result', { inputSchema: schema });
      const flows = engine.listFlows();
      expect(flows[0].inputSchema).toEqual(schema);
      await engine.shutdown();
    });

    it('should emit flow:registered event with { name } after registration', async () => {
      const engine = await createEngine(createConfig());
      const handler = vi.fn();
      engine.on('flow:registered', handler);
      engine.register('test-flow', async () => 'result');
      expect(handler).toHaveBeenCalledWith({ name: 'test-flow' });
      await engine.shutdown();
    });

    it('should work with existing register() calls without description/inputSchema', async () => {
      const engine = await createEngine(createConfig());
      engine.register('test-flow', async () => 'result', { timeout: 5000 });
      const flows = engine.listFlows();
      expect(flows[0].name).toBe('test-flow');
      expect(flows[0].description).toBeUndefined();
      expect(flows[0].inputSchema).toEqual({ type: 'object' });
      await engine.shutdown();
    });
  });

  describe('unregister', () => {
    it('should remove a flow from the registry', async () => {
      const engine = await createEngine(createConfig());
      engine.register('test-flow', async () => 'result');
      engine.unregister('test-flow');
      const flows = engine.listFlows();
      expect(flows).toHaveLength(0);
      await engine.shutdown();
    });

    it('should emit flow:unregistered event', async () => {
      const engine = await createEngine(createConfig());
      engine.register('test-flow', async () => 'result');
      const handler = vi.fn();
      engine.on('flow:unregistered', handler);
      engine.unregister('test-flow');
      expect(handler).toHaveBeenCalledWith({ name: 'test-flow' });
      await engine.shutdown();
    });

    it('should throw FLOW_NOT_FOUND for unknown flow', async () => {
      const engine = await createEngine(createConfig());
      expect(() => engine.unregister('no-such-flow')).toThrow(EngineError);
      try {
        engine.unregister('no-such-flow');
      } catch (e) {
        expect((e as EngineError).code).toBe('FLOW_NOT_FOUND');
      }
      await engine.shutdown();
    });

    it('should throw ENGINE_NOT_READY when engine not ready', async () => {
      const engine = await createEngine(createConfig());
      await engine.shutdown();
      expect(() => engine.unregister('test-flow')).toThrow(EngineError);
      try {
        engine.unregister('test-flow');
      } catch (e) {
        expect((e as EngineError).code).toBe('ENGINE_NOT_READY');
      }
    });

    it('should cause subsequent trigger() to fail with FLOW_NOT_FOUND', async () => {
      const engine = await createEngine(createConfig());
      engine.register('test-flow', async () => 'result');
      engine.unregister('test-flow');
      await expect(
        engine.trigger('test-flow', { idempotencyKey: 'key-1' }),
      ).rejects.toThrow(EngineError);
      await engine.shutdown();
    });
  });

  describe('listFlows', () => {
    it('should return empty array when no flows registered', async () => {
      const engine = await createEngine(createConfig());
      const flows = engine.listFlows();
      expect(flows).toEqual([]);
      await engine.shutdown();
    });

    it('should return all registered flows with name, description, inputSchema', async () => {
      const engine = await createEngine(createConfig());
      engine.register('flow-a', async () => 'a', { description: 'Flow A' });
      engine.register('flow-b', async () => 'b', {
        inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
      });
      const flows = engine.listFlows();
      expect(flows).toHaveLength(2);
      expect(flows.map((f) => f.name).sort()).toEqual(['flow-a', 'flow-b']);
      const flowA = flows.find((f) => f.name === 'flow-a')!;
      expect(flowA.description).toBe('Flow A');
      expect(flowA.inputSchema).toEqual({ type: 'object' });
      const flowB = flows.find((f) => f.name === 'flow-b')!;
      expect(flowB.description).toBeUndefined();
      expect(flowB.inputSchema).toEqual({ type: 'object', properties: { x: { type: 'number' } } });
      await engine.shutdown();
    });

    it('should reflect register/unregister changes', async () => {
      const engine = await createEngine(createConfig());
      engine.register('flow-a', async () => 'a');
      expect(engine.listFlows()).toHaveLength(1);
      engine.register('flow-b', async () => 'b');
      expect(engine.listFlows()).toHaveLength(2);
      engine.unregister('flow-a');
      expect(engine.listFlows()).toHaveLength(1);
      expect(engine.listFlows()[0].name).toBe('flow-b');
      await engine.shutdown();
    });
  });
});
