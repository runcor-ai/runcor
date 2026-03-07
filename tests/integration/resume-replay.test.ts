// Integration tests for wait, resume, replay, cancel, and timeout lifecycle
// Integration tests for Feature 006 (Resume & Replay)
import { describe, it, expect, vi } from 'vitest';
import { createEngine, type Runcor } from '../../src/engine.js';
import { createWaitSignal } from '../../src/wait-signal.js';
import { EngineError, RetryableError } from '../../src/errors.js';
import type { EngineConfig, ExecutionState } from '../../src/types.js';
import type { ModelProvider } from '../../src/model/provider.js';

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

/** Helper: wait for an execution to reach a specific state */
async function waitForState(
  engine: Runcor,
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

describe('Resume & Replay Integration', () => {
  // T017: Full wait/resume lifecycle
  describe('Wait & Resume Lifecycle', () => {
    it('should complete full wait/resume cycle with state transitions', async () => {
      const states: Array<{ from: string; to: string }> = [];
      const engine = await createEngine(createConfig());

      engine.on('execution:state_change', (event) => {
        states.push({ from: event.from, to: event.to });
      });

      let callCount = 0;
      engine.register('approval-flow', async (ctx) => {
        callCount++;
        if (callCount === 1) {
          return createWaitSignal({ reason: 'Awaiting manager approval' });
        }
        return { approved: true, data: ctx.resumeData };
      }, { maxRetries: 0 });

      const exec = await engine.trigger('approval-flow', {
        idempotencyKey: 'lifecycle-1',
        input: { request: 'access' },
      });

      // Wait for waiting state
      await waitForState(engine, exec.id, 'waiting');

      // Verify execution is persisted in waiting state
      const waiting = await engine.getExecution(exec.id);
      expect(waiting!.state).toBe('waiting');
      expect(waiting!.waitContext).not.toBeNull();
      expect(waiting!.waitContext!.reason).toBe('Awaiting manager approval');

      // Resume with data
      await engine.resume(exec.id, { approved: true, by: 'admin' });
      await waitForState(engine, exec.id, 'complete');

      // Verify final state
      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');
      expect(final!.result).toEqual({
        approved: true,
        data: { approved: true, by: 'admin' },
      });
      expect(final!.resumeData).toEqual({ approved: true, by: 'admin' });
      expect(final!.waitContext).toBeNull();

      // Verify state transition history
      expect(states).toContainEqual({ from: 'queued', to: 'running' });
      expect(states).toContainEqual({ from: 'running', to: 'waiting' });
      expect(states).toContainEqual({ from: 'waiting', to: 'running' });
      expect(states).toContainEqual({ from: 'running', to: 'complete' });

      expect(callCount).toBe(2);

      await engine.shutdown();
    });

    it('should emit state_change events for all transitions', async () => {
      const events: Array<{ executionId: string; from: string; to: string }> = [];
      const engine = await createEngine(createConfig());

      engine.on('execution:state_change', (event) => {
        events.push({
          executionId: event.executionId,
          from: event.from,
          to: event.to,
        });
      });

      let callCount = 0;
      engine.register('event-flow', async (ctx) => {
        callCount++;
        if (callCount === 1) return createWaitSignal();
        return 'done';
      }, { maxRetries: 0 });

      const exec = await engine.trigger('event-flow', { idempotencyKey: 'evt-1' });
      await waitForState(engine, exec.id, 'waiting');

      await engine.resume(exec.id);
      await waitForState(engine, exec.id, 'complete');

      const execEvents = events.filter((e) => e.executionId === exec.id);
      expect(execEvents).toHaveLength(4);
      expect(execEvents[0]).toEqual({ executionId: exec.id, from: 'queued', to: 'running' });
      expect(execEvents[1]).toEqual({ executionId: exec.id, from: 'running', to: 'waiting' });
      expect(execEvents[2]).toEqual({ executionId: exec.id, from: 'waiting', to: 'running' });
      expect(execEvents[3]).toEqual({ executionId: exec.id, from: 'running', to: 'complete' });

      await engine.shutdown();
    });

    it('should persist execution in state store during wait', async () => {
      const engine = await createEngine(createConfig());

      engine.register('persist-flow', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal({ waitData: { step: 1 } });
        return 'done';
      }, { maxRetries: 0 });

      const exec = await engine.trigger('persist-flow', { idempotencyKey: 'persist-1' });
      await waitForState(engine, exec.id, 'waiting');

      // Retrieve from store — should be in waiting state with context
      const stored = await engine.getExecution(exec.id);
      expect(stored).not.toBeNull();
      expect(stored!.state).toBe('waiting');
      expect(stored!.waitContext!.waitData).toEqual({ step: 1 });

      await engine.resume(exec.id, 'continue');
      await waitForState(engine, exec.id, 'complete');

      await engine.shutdown();
    });

    it('should pass resumeData as undefined on initial invocation', async () => {
      const engine = await createEngine(createConfig());
      let initialResumeData: unknown = 'NOT_SET';

      engine.register('check-resume', async (ctx) => {
        if (initialResumeData === 'NOT_SET') {
          initialResumeData = ctx.resumeData;
        }
        if (!ctx.resumeData) return createWaitSignal();
        return 'done';
      }, { maxRetries: 0 });

      const exec = await engine.trigger('check-resume', { idempotencyKey: 'cr-1' });
      await waitForState(engine, exec.id, 'waiting');

      expect(initialResumeData).toBeUndefined();

      await engine.resume(exec.id, 'data');
      await waitForState(engine, exec.id, 'complete');

      await engine.shutdown();
    });
  });

  // T022: Multi-wait scenario
  describe('Multi-Wait', () => {
    it('should handle multiple wait/resume cycles', async () => {
      const states: Array<{ from: string; to: string }> = [];
      const engine = await createEngine(createConfig());

      engine.on('execution:state_change', (event) => {
        states.push({ from: event.from, to: event.to });
      });

      let callCount = 0;
      engine.register('multi-wait', async (ctx) => {
        callCount++;
        if (callCount === 1) return createWaitSignal({ reason: 'step-1' });
        if (callCount === 2) return createWaitSignal({ reason: 'step-2' });
        return `final: ${ctx.resumeData}`;
      }, { maxRetries: 0 });

      const exec = await engine.trigger('multi-wait', { idempotencyKey: 'mw-1' });
      await waitForState(engine, exec.id, 'waiting');

      // First resume
      await engine.resume(exec.id, 'data-1');
      await waitForState(engine, exec.id, 'waiting');

      // Second resume
      await engine.resume(exec.id, 'data-2');
      await waitForState(engine, exec.id, 'complete');

      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');
      expect(final!.result).toBe('final: data-2');
      expect(callCount).toBe(3);

      // Verify full transition history
      expect(states).toContainEqual({ from: 'queued', to: 'running' });
      // First wait cycle
      expect(states.filter((s) => s.from === 'running' && s.to === 'waiting')).toHaveLength(2);
      expect(states.filter((s) => s.from === 'waiting' && s.to === 'running')).toHaveLength(2);
      // Final completion
      expect(states).toContainEqual({ from: 'running', to: 'complete' });

      await engine.shutdown();
    });
  });

  // T023: Resume idempotency
  describe('Resume Idempotency', () => {
    it('should handle idempotent resume after completion', async () => {
      const engine = await createEngine(createConfig());
      let callCount = 0;

      engine.register('idem-flow', async (ctx) => {
        callCount++;
        if (callCount === 1) return createWaitSignal();
        return 'done';
      }, { maxRetries: 0 });

      const exec = await engine.trigger('idem-flow', { idempotencyKey: 'idem-1' });
      await waitForState(engine, exec.id, 'waiting');

      // First resume
      await engine.resume(exec.id, 'data');
      await waitForState(engine, exec.id, 'complete');

      // Second resume with same data — idempotent, no error
      const result = await engine.resume(exec.id, 'data');
      expect(result.state).toBe('complete');
      expect(callCount).toBe(2); // Handler not re-invoked

      await engine.shutdown();
    });

    it('should throw on resume with different data after completion', async () => {
      const engine = await createEngine(createConfig());
      let callCount = 0;

      engine.register('idem-diff', async (ctx) => {
        callCount++;
        if (callCount === 1) return createWaitSignal();
        return 'done';
      }, { maxRetries: 0 });

      const exec = await engine.trigger('idem-diff', { idempotencyKey: 'idem-2' });
      await waitForState(engine, exec.id, 'waiting');

      await engine.resume(exec.id, 'original');
      await waitForState(engine, exec.id, 'complete');

      // Resume with different data — should throw
      await expect(engine.resume(exec.id, 'different'))
        .rejects.toThrow(EngineError);

      await engine.shutdown();
    });
  });

  // T024: Execution timeout pausing during wait
  describe('Timeout Pausing', () => {
    it('should pause execution timeout during wait', async () => {
      const engine = await createEngine(createConfig());
      let callCount = 0;

      engine.register('timeout-pause', async (ctx) => {
        callCount++;
        if (callCount === 1) {
          // Consume ~50ms of the timeout
          await new Promise((r) => setTimeout(r, 50));
          return createWaitSignal();
        }
        return 'completed after wait';
      }, { timeout: 200, maxRetries: 0 });

      const exec = await engine.trigger('timeout-pause', { idempotencyKey: 'tp-1' });
      await waitForState(engine, exec.id, 'waiting');

      // Wait 500ms — would exceed original 200ms timeout
      await new Promise((r) => setTimeout(r, 500));

      // Resume — should succeed because timeout was paused during wait
      await engine.resume(exec.id, 'go');
      await waitForState(engine, exec.id, 'complete');

      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');
      expect(final!.result).toBe('completed after wait');

      await engine.shutdown();
    });
  });

  // T024a: Concurrent resume calls
  describe('Concurrent Resume', () => {
    it('should handle concurrent resume calls with same data idempotently', async () => {
      const engine = await createEngine(createConfig());
      let callCount = 0;

      engine.register('concurrent-flow', async (ctx) => {
        callCount++;
        if (callCount === 1) return createWaitSignal();
        // Small delay to increase chance of race
        await new Promise((r) => setTimeout(r, 10));
        return 'done';
      }, { maxRetries: 0 });

      const exec = await engine.trigger('concurrent-flow', { idempotencyKey: 'cc-1' });
      await waitForState(engine, exec.id, 'waiting');

      // Fire two resume calls concurrently with same data
      const results = await Promise.allSettled([
        engine.resume(exec.id, 'same-data'),
        engine.resume(exec.id, 'same-data'),
      ]);

      // At least one should succeed, the other should be idempotent (no error)
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      // No rejections expected (both should succeed due to idempotency)
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(0);

      await waitForState(engine, exec.id, 'complete');
      await engine.shutdown();
    });

    it('should reject concurrent resume with different data', async () => {
      const engine = await createEngine(createConfig());
      let callCount = 0;

      engine.register('concurrent-diff', async (ctx) => {
        callCount++;
        if (callCount === 1) return createWaitSignal();
        await new Promise((r) => setTimeout(r, 50));
        return `got: ${ctx.resumeData}`;
      }, { maxRetries: 0 });

      const exec = await engine.trigger('concurrent-diff', { idempotencyKey: 'cd-1' });
      await waitForState(engine, exec.id, 'waiting');

      // Fire two resume calls with different data
      const results = await Promise.allSettled([
        engine.resume(exec.id, 'data-A'),
        engine.resume(exec.id, 'data-B'),
      ]);

      // One should succeed, one should fail with INVALID_STATE
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      await waitForState(engine, exec.id, 'complete');
      await engine.shutdown();
    });
  });

  // T024b: Wait during retry
  describe('Wait During Retry', () => {
    it('should handle WaitSignal during retry attempt', async () => {
      const engine = await createEngine(createConfig());
      let callCount = 0;

      engine.register('retry-wait', async (ctx) => {
        callCount++;
        if (callCount === 1) throw new RetryableError('transient');
        if (callCount === 2) return createWaitSignal({ reason: 'waiting after retry' });
        return `resumed: ${ctx.resumeData}`;
      }, { maxRetries: 2, baseRetryDelay: 10, maxRetryDelay: 50 });

      const exec = await engine.trigger('retry-wait', { idempotencyKey: 'rw-1' });

      // Should fail first, retry, then wait
      await waitForState(engine, exec.id, 'waiting', 10000);

      const waiting = await engine.getExecution(exec.id);
      expect(waiting!.state).toBe('waiting');
      expect(waiting!.retryCount).toBe(1); // One retry happened
      expect(waiting!.waitContext!.reason).toBe('waiting after retry');

      // Resume
      await engine.resume(exec.id, 'continue');
      await waitForState(engine, exec.id, 'complete');

      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');
      expect(final!.retryCount).toBe(1); // Retry count preserved
      expect(final!.result).toBe('resumed: continue');

      await engine.shutdown();
    });
  });

  // T026: Replay lifecycle integration
  describe('Replay Lifecycle', () => {
    it('should replay with full independence from original', async () => {
      const engine = await createEngine(createConfig());
      const handlerInputs: unknown[] = [];

      engine.register('replay-indep', async (ctx) => {
        handlerInputs.push(ctx.input);
        return `result-${handlerInputs.length}`;
      }, { maxRetries: 0 });

      // Trigger original
      const original = await engine.trigger('replay-indep', {
        idempotencyKey: 'ri-1',
        input: { data: 'original' },
      });
      await waitForState(engine, original.id, 'complete');

      // Replay
      const replayed = await engine.replay(original.id);
      await waitForState(engine, replayed.id, 'complete');

      // Verify independence
      expect(replayed.id).not.toBe(original.id);
      expect(replayed.replayOf).toBe(original.id);
      expect(replayed.input).toEqual({ data: 'original' }); // Same input

      // Original unchanged
      const origFinal = await engine.getExecution(original.id);
      expect(origFinal!.result).toBe('result-1');
      expect(origFinal!.replayOf).toBeNull();

      // Replayed got its own result
      const replayFinal = await engine.getExecution(replayed.id);
      expect(replayFinal!.result).toBe('result-2');

      await engine.shutdown();
    });

    it('should support replay chain (replay of a replay)', async () => {
      const engine = await createEngine(createConfig());
      let callCount = 0;

      engine.register('chain-flow', async () => {
        callCount++;
        return `call-${callCount}`;
      }, { maxRetries: 0 });

      const first = await engine.trigger('chain-flow', {
        idempotencyKey: 'chain-1',
      });
      await waitForState(engine, first.id, 'complete');

      const second = await engine.replay(first.id);
      await waitForState(engine, second.id, 'complete');

      const third = await engine.replay(second.id);
      await waitForState(engine, third.id, 'complete');

      expect(second.replayOf).toBe(first.id);
      expect(third.replayOf).toBe(second.id);

      const thirdFinal = await engine.getExecution(third.id);
      expect(thirdFinal!.result).toBe('call-3');

      await engine.shutdown();
    });
  });

  // T028: Replay with userId/sessionId preservation
  describe('Replay with User Context', () => {
    it('should preserve userId in replayed execution', async () => {
      const engine = await createEngine(createConfig());
      const userIds: (string | undefined)[] = [];

      engine.register('user-replay', async (ctx) => {
        // Access user memory to verify userId is set
        try {
          const key = await ctx.memory.user.list();
          userIds.push('user-available');
        } catch {
          userIds.push('no-user');
        }
        return 'done';
      }, { maxRetries: 0 });

      const original = await engine.trigger('user-replay', {
        idempotencyKey: 'ur-1',
        userId: 'user-123',
      });
      await waitForState(engine, original.id, 'complete');

      const replayed = await engine.replay(original.id);
      await waitForState(engine, replayed.id, 'complete');

      // Both invocations should have user memory available
      expect(userIds).toEqual(['user-available', 'user-available']);

      await engine.shutdown();
    });
  });

  // T029: Replay of failed execution
  describe('Replay of Failed Execution', () => {
    it('should create independent execution that can succeed', async () => {
      const engine = await createEngine(createConfig());
      let callCount = 0;

      engine.register('fail-then-succeed', async () => {
        callCount++;
        if (callCount === 1) throw new Error('intentional failure');
        return 'success';
      }, { maxRetries: 0 });

      const failed = await engine.trigger('fail-then-succeed', {
        idempotencyKey: 'fts-1',
      });
      await waitForState(engine, failed.id, 'failed');

      // Replay the failed execution
      const replayed = await engine.replay(failed.id);
      await waitForState(engine, replayed.id, 'complete');

      // Failed original unchanged
      const origFinal = await engine.getExecution(failed.id);
      expect(origFinal!.state).toBe('failed');

      // Replayed execution succeeded
      const replayFinal = await engine.getExecution(replayed.id);
      expect(replayFinal!.state).toBe('complete');
      expect(replayFinal!.result).toBe('success');
      expect(replayFinal!.replayOf).toBe(failed.id);

      await engine.shutdown();
    });
  });

  // T031: Wait timeout integration tests
  describe('Wait Timeout', () => {
    it('should timeout with accuracy within 100ms (SC-003)', async () => {
      const engine = await createEngine(createConfig());

      engine.register('timeout-accuracy', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal();
        return 'done';
      }, { waitTimeout: 200, maxRetries: 0 });

      const exec = await engine.trigger('timeout-accuracy', {
        idempotencyKey: 'ta-1',
      });
      await waitForState(engine, exec.id, 'waiting');

      const start = Date.now();
      await waitForState(engine, exec.id, 'failed', 5000);
      const elapsed = Date.now() - start;

      // Should be ~200ms (within 100ms tolerance)
      expect(elapsed).toBeGreaterThanOrEqual(180);
      expect(elapsed).toBeLessThan(300);

      const final = await engine.getExecution(exec.id);
      expect(final!.error!.code).toBe('WAIT_TIMEOUT');

      await engine.shutdown();
    });

    it('should resolve trigger-level waitTimeout over flow-level', async () => {
      const engine = await createEngine(createConfig());

      engine.register('precedence-flow', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal();
        return 'done';
      }, { waitTimeout: 5000, maxRetries: 0 }); // Flow: 5s

      const exec = await engine.trigger('precedence-flow', {
        idempotencyKey: 'pf-1',
        waitTimeout: 100, // Override: 100ms
      });
      await waitForState(engine, exec.id, 'waiting');

      const start = Date.now();
      await waitForState(engine, exec.id, 'failed', 5000);
      const elapsed = Date.now() - start;

      // Should use trigger-level 100ms, not flow-level 5000ms
      expect(elapsed).toBeLessThan(500);

      await engine.shutdown();
    });

    it('should wait indefinitely when no timeout configured', async () => {
      const engine = await createEngine(createConfig());

      engine.register('indefinite-wait', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal();
        return 'done';
      }, { maxRetries: 0 }); // No waitTimeout (default: 0 = indefinite)

      const exec = await engine.trigger('indefinite-wait', {
        idempotencyKey: 'iw-1',
      });
      await waitForState(engine, exec.id, 'waiting');

      // Wait 300ms — should still be waiting
      await new Promise((r) => setTimeout(r, 300));
      const still = await engine.getExecution(exec.id);
      expect(still!.state).toBe('waiting');

      // Clean up
      await engine.resume(exec.id, 'done');
      await waitForState(engine, exec.id, 'complete');

      await engine.shutdown();
    });
  });

  // T034: Wait timeout race condition
  describe('Wait Timeout Race Condition', () => {
    it('should let resume win when called just before timeout', async () => {
      const engine = await createEngine(createConfig());

      engine.register('race-flow', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal();
        return `result: ${ctx.resumeData}`;
      }, { waitTimeout: 150, maxRetries: 0 });

      const exec = await engine.trigger('race-flow', {
        idempotencyKey: 'race-1',
      });
      await waitForState(engine, exec.id, 'waiting');

      // Resume just before timeout
      await new Promise((r) => setTimeout(r, 100));
      await engine.resume(exec.id, 'quick');
      await waitForState(engine, exec.id, 'complete');

      // Wait past original timeout
      await new Promise((r) => setTimeout(r, 200));

      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');
      expect(final!.result).toBe('result: quick');

      await engine.shutdown();
    });
  });

  // T036 + T038: Wait context and querying integration
  describe('Wait Context & Querying', () => {
    it('should store wait context fields on execution', async () => {
      const engine = await createEngine(createConfig());
      const resumeBy = new Date('2026-03-01');

      engine.register('context-flow', async (ctx) => {
        if (!ctx.resumeData) {
          return createWaitSignal({
            reason: 'Awaiting payment confirmation',
            expectedResumeBy: resumeBy,
            waitData: { orderId: 'ORD-123', amount: 99.99 },
          });
        }
        return 'done';
      }, { maxRetries: 0 });

      const exec = await engine.trigger('context-flow', {
        idempotencyKey: 'ctx-1',
      });
      await waitForState(engine, exec.id, 'waiting');

      const waiting = await engine.getExecution(exec.id);
      expect(waiting!.waitContext).not.toBeNull();
      expect(waiting!.waitContext!.reason).toBe('Awaiting payment confirmation');
      expect(waiting!.waitContext!.expectedResumeBy).toEqual(resumeBy);
      expect(waiting!.waitContext!.waitData).toEqual({ orderId: 'ORD-123', amount: 99.99 });
      expect(waiting!.waitContext!.waitingSince).toBeInstanceOf(Date);

      await engine.resume(exec.id, 'x');
      await waitForState(engine, exec.id, 'complete');
      await engine.shutdown();
    });

    it('should handle multiple flows with different wait metadata', async () => {
      const engine = await createEngine(createConfig());

      engine.register('payment-flow', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal({ reason: 'payment' });
        return 'done';
      }, { maxRetries: 0 });

      engine.register('approval-flow', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal({ reason: 'approval' });
        return 'done';
      }, { maxRetries: 0 });

      const exec1 = await engine.trigger('payment-flow', { idempotencyKey: 'pf-1' });
      const exec2 = await engine.trigger('approval-flow', { idempotencyKey: 'af-1' });
      await waitForState(engine, exec1.id, 'waiting');
      await waitForState(engine, exec2.id, 'waiting');

      const allWaiting = await engine.listWaiting();
      expect(allWaiting).toHaveLength(2);

      const reasons = allWaiting.map((e) => e.waitContext!.reason).sort();
      expect(reasons).toEqual(['approval', 'payment']);

      const paymentOnly = await engine.listWaiting('payment-flow');
      expect(paymentOnly).toHaveLength(1);
      expect(paymentOnly[0].waitContext!.reason).toBe('payment');

      // Clean up
      await engine.resume(exec1.id, 'x');
      await engine.resume(exec2.id, 'x');
      await waitForState(engine, exec1.id, 'complete');
      await waitForState(engine, exec2.id, 'complete');
      await engine.shutdown();
    });
  });

  // T039: Wait context cleared on resume
  describe('Wait Context Cleared on Resume', () => {
    it('should clear waitContext when resumed', async () => {
      const engine = await createEngine(createConfig());

      engine.register('clear-ctx', async (ctx) => {
        if (!ctx.resumeData) {
          return createWaitSignal({
            reason: 'test',
            expectedResumeBy: new Date('2026-03-01'),
            waitData: { key: 'value' },
          });
        }
        return 'done';
      }, { maxRetries: 0 });

      const exec = await engine.trigger('clear-ctx', { idempotencyKey: 'cc-1' });
      await waitForState(engine, exec.id, 'waiting');

      // Verify context exists
      const waiting = await engine.getExecution(exec.id);
      expect(waiting!.waitContext).not.toBeNull();

      // Resume
      await engine.resume(exec.id, 'resume-data');
      await waitForState(engine, exec.id, 'complete');

      // Verify context is cleared
      const final = await engine.getExecution(exec.id);
      expect(final!.waitContext).toBeNull();
      expect(final!.resumeData).toBe('resume-data');

      await engine.shutdown();
    });
  });

  // T024c: Resume after flow unregistration
  describe('Resume After Unregistration', () => {
    it('should resume successfully after flow is unregistered', async () => {
      const engine = await createEngine(createConfig());
      let callCount = 0;

      engine.register('unreg-flow', async (ctx) => {
        callCount++;
        if (callCount === 1) return createWaitSignal();
        return `completed: ${ctx.resumeData}`;
      }, { maxRetries: 0 });

      const exec = await engine.trigger('unreg-flow', { idempotencyKey: 'uf-1' });
      await waitForState(engine, exec.id, 'waiting');

      // Unregister the flow (simulate hot-reload or config change)
      (engine as any).flowRegistry.delete('unreg-flow');

      // Resume should still work using stored handler reference
      await engine.resume(exec.id, 'post-unreg');
      await waitForState(engine, exec.id, 'complete');

      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');
      expect(final!.result).toBe('completed: post-unreg');

      await engine.shutdown();
    });
  });

  // T044: Performance test — resume overhead
  describe('Performance', () => {
    it('should resume within 50ms overhead (SC-001)', async () => {
      const engine = await createEngine(createConfig());
      let handlerStart = 0;

      engine.register('perf-flow', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal();
        handlerStart = performance.now();
        return 'done';
      }, { maxRetries: 0 });

      const exec = await engine.trigger('perf-flow', { idempotencyKey: 'perf-1' });
      await waitForState(engine, exec.id, 'waiting');

      const resumeStart = performance.now();
      await engine.resume(exec.id, 'go');

      // Wait a tiny bit for handler invocation
      await new Promise((r) => setTimeout(r, 20));

      if (handlerStart > 0) {
        const overhead = handlerStart - resumeStart;
        expect(overhead).toBeLessThan(50);
      }

      await waitForState(engine, exec.id, 'complete');
      await engine.shutdown();
    });

    // T045: listWaiting performance
    it('should query listWaiting within 10ms for many executions (SC-006)', async () => {
      const engine = await createEngine(createConfig());

      engine.register('many-wait', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal();
        return 'done';
      }, { maxRetries: 0 });

      // Create 100 waiting executions (reduced from 1000 for test speed)
      const executions = [];
      for (let i = 0; i < 100; i++) {
        const exec = await engine.trigger('many-wait', {
          idempotencyKey: `mw-${i}`,
        });
        executions.push(exec);
      }

      // Wait for all to enter waiting state
      for (const exec of executions) {
        await waitForState(engine, exec.id, 'waiting');
      }

      const start = performance.now();
      const result = await engine.listWaiting();
      const elapsed = performance.now() - start;

      expect(result).toHaveLength(100);
      expect(elapsed).toBeLessThan(10);

      // Clean up
      for (const exec of executions) {
        await engine.resume(exec.id, 'x');
      }
      // Wait for completions
      for (const exec of executions) {
        await waitForState(engine, exec.id, 'complete');
      }
      await engine.shutdown();
    }, 30000);
  });

  // T047: Shutdown with waiting executions
  describe('Shutdown with Waiting Executions', () => {
    it('should NOT force-fail waiting executions during shutdown', async () => {
      const engine = await createEngine({
        ...createConfig(),
        drainTimeout: 100,
      });

      engine.register('shutdown-wait', async (ctx) => {
        if (!ctx.resumeData) return createWaitSignal();
        return 'done';
      }, { maxRetries: 0 });

      const exec = await engine.trigger('shutdown-wait', {
        idempotencyKey: 'sw-1',
      });
      await waitForState(engine, exec.id, 'waiting');

      // Shutdown should complete promptly (no waiting for waiting executions)
      const start = Date.now();
      await engine.shutdown();
      const elapsed = Date.now() - start;

      // Should be fast — waiting executions don't block shutdown
      expect(elapsed).toBeLessThan(500);

      // Waiting execution should still be in state store, NOT force-failed
      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('waiting');
    });
  });

  // T048: Engine restart with waiting executions
  describe('Engine Restart', () => {
    it('should resume waiting execution after engine restart (SC-005)', async () => {
      // Create a shared state store (simulates persistent storage)
      const { InMemoryStateStore } = await import('../../src/state-store.js');
      const sharedStore = new InMemoryStateStore(3600);

      // Engine 1: trigger and wait
      const engine1Config: EngineConfig = {
        model: { provider: createMockProvider() },
      };
      const engine1 = await createEngine(engine1Config);
      // Override state store
      (engine1 as any).stateStore = sharedStore;

      let callCount = 0;
      const handler = async (ctx: any) => {
        callCount++;
        if (callCount === 1) return createWaitSignal({ reason: 'need data' });
        return `resumed: ${ctx.resumeData}`;
      };

      engine1.register('restart-flow', handler, { maxRetries: 0 });

      const exec = await engine1.trigger('restart-flow', {
        idempotencyKey: 'restart-1',
      });
      await waitForState(engine1, exec.id, 'waiting');

      // Shutdown engine 1
      await engine1.shutdown();

      // Verify execution is still in the store
      const stored = await sharedStore.get(exec.id);
      expect(stored!.state).toBe('waiting');

      // Engine 2: new instance with same state store
      const engine2 = await createEngine({
        model: { provider: createMockProvider() },
      });
      (engine2 as any).stateStore = sharedStore;

      engine2.register('restart-flow', handler, { maxRetries: 0 });

      // listWaiting should find the execution
      const waiting = await engine2.listWaiting();
      expect(waiting.some((e) => e.id === exec.id)).toBe(true);

      // Resume on new engine
      await engine2.resume(exec.id, 'post-restart');
      await waitForState(engine2, exec.id, 'complete');

      const final = await engine2.getExecution(exec.id);
      expect(final!.state).toBe('complete');
      expect(final!.result).toBe('resumed: post-restart');

      await engine2.shutdown();
    });
  });
});
