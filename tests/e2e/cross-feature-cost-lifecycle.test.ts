// E2E: Cost tracking across wait/resume/retry/replay/agent (9 tests)
// Verifies cost accumulation across lifecycle phases — currently 0% covered

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import { createWaitSignal } from '../../src/wait-signal.js';
import { RetryableError, BudgetExceededError } from '../../src/errors.js';
import { createAgentHandler } from '../../src/agent/handler.js';
import { createTestEngine, waitForState, waitForCompletion, createNamedProvider, delay } from './helpers.js';
import type { EngineConfig, CostEntry } from '../../src/types.js';

let engine: Runcor;

afterEach(async () => {
  if (engine) await engine.shutdown();
});

describe('Cross-feature: Cost × Wait/Resume/Retry/Agent', { timeout: 30000 }, () => {
  it('cost accumulates before wait, pauses, continues after resume', async () => {
    const provider = createNamedProvider('test-provider', 'response');
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.02 } }],
      },
      cost: {},
    });

    let callCount = 0;
    engine.register('wait-flow', async (ctx) => {
      callCount++;
      await ctx.model.complete({ prompt: 'before-or-after' });
      if (!ctx.resumeData) {
        return createWaitSignal({ reason: 'need approval' });
      }
      return 'done';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('wait-flow', { idempotencyKey: 'wf-1' });
    await waitForState(engine, exec.id, 'waiting');

    const ledger = engine.getCostLedger()!;
    const costBeforeResume = ledger.getTotal({ executionId: exec.id });
    expect(costBeforeResume).toBeGreaterThan(0);

    await engine.resume(exec.id, { approved: true });
    await waitForCompletion(engine, exec.id);

    const costAfterResume = ledger.getTotal({ executionId: exec.id });
    expect(costAfterResume).toBeGreaterThan(costBeforeResume);
    expect(callCount).toBe(2);
  });

  it('budget exceeded after resume', async () => {
    // With maxTokens=10, prompt=20, costPerToken=0.1, response=10 chars:
    //   estimate = (20/4 * 0.1) + (10 * 0.1) = 0.5 + 1.0 = 1.5
    //   actual   = (20 * 0.1) + (10 * 0.1) = 2.0 + 1.0 = 3.0
    // Call 1 (before wait): currentSpend=0, passes (1.5<7), post-reconcile=3.0
    // Call 2 (resume, 1st): currentSpend=3.0, passes (4.5<7), post-reconcile=6.0
    // Call 3 (resume, 2nd): currentSpend=6.0, FAILS (7.5>7)
    const provider = createNamedProvider('test-provider', 'x'.repeat(10));
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.1, output: 0.1 } }],
      },
      cost: {
        budgets: {
          perFlow: { limit: 7, enforcement: 'hard' },
        },
      },
    });

    engine.register('budget-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'a'.repeat(20), maxTokens: 10 });
      if (!ctx.resumeData) {
        return createWaitSignal({ reason: 'pause' });
      }
      // Second model call should push over budget (cumulative > limit)
      await ctx.model.complete({ prompt: 'b'.repeat(20), maxTokens: 10 });
      return 'done';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('budget-flow', { idempotencyKey: 'bf-1' });
    await waitForState(engine, exec.id, 'waiting');

    await engine.resume(exec.id, 'go');
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('failed');
    expect(final!.error!.message).toContain('Budget exceeded');
  });

  it('cost ledger entries span wait with same executionId', async () => {
    const provider = createNamedProvider('test-provider', 'response');
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.02 } }],
      },
      cost: {},
    });

    engine.register('ledger-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'phase-1' });
      if (!ctx.resumeData) {
        return createWaitSignal({ reason: 'external' });
      }
      await ctx.model.complete({ prompt: 'phase-2' });
      return 'done';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('ledger-flow', { idempotencyKey: 'lf-1' });
    await waitForState(engine, exec.id, 'waiting');
    await engine.resume(exec.id, 'continue');
    await waitForCompletion(engine, exec.id);

    const entries = engine.getCostLedger()!.query({ executionId: exec.id });
    // 1 call before wait + 2 calls after resume (handler re-runs from start: phase-1 + phase-2)
    expect(entries.length).toBe(3);
    expect(entries.every((e: CostEntry) => e.executionId === exec.id)).toBe(true);
  });

  it('cost accumulates across retries', async () => {
    let attempt = 0;
    const provider = createNamedProvider('test-provider', 'response');
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.02 } }],
      },
      cost: {},
    });

    engine.register('retry-cost-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'attempt' });
      attempt++;
      if (attempt < 2) {
        throw new RetryableError('transient fail');
      }
      return 'success';
    }, { maxRetries: 3, baseRetryDelay: 10, maxRetryDelay: 50 });

    const exec = await engine.trigger('retry-cost-flow', { idempotencyKey: 'rc-1' });
    await waitForCompletion(engine, exec.id);

    const entries = engine.getCostLedger()!.query({ executionId: exec.id });
    expect(entries.length).toBe(2); // one per attempt
    expect(attempt).toBe(2);
  });

  it('budget exceeded mid-retry cycle', async () => {
    const provider = createNamedProvider('test-provider', 'x'.repeat(100));
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 1, output: 1 } }],
      },
      cost: {
        budgets: {
          perFlow: { limit: 250, enforcement: 'hard' },
        },
      },
    });

    engine.register('retry-budget-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'a'.repeat(100) });
      throw new RetryableError('keep retrying');
    }, { maxRetries: 10, baseRetryDelay: 10, maxRetryDelay: 50 });

    const exec = await engine.trigger('retry-budget-flow', { idempotencyKey: 'rb-1' });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('failed');
    // Should fail with budget exceeded
    expect(final!.error!.message).toContain('Budget exceeded');
  });

  it('replay tracks cost independently', async () => {
    const provider = createNamedProvider('test-provider', 'response');
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.02 } }],
      },
      cost: {},
    });

    engine.register('replay-cost-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'work' });
      return 'done';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('replay-cost-flow', { idempotencyKey: 'rpc-1' });
    await waitForCompletion(engine, exec.id);

    const originalEntries = engine.getCostLedger()!.query({ executionId: exec.id });
    expect(originalEntries.length).toBe(1);

    const replay = await engine.replay(exec.id);
    await waitForCompletion(engine, replay.id);

    const replayEntries = engine.getCostLedger()!.query({ executionId: replay.id });
    expect(replayEntries.length).toBe(1);
    expect(replayEntries[0].executionId).toBe(replay.id);
    expect(replayEntries[0].executionId).not.toBe(exec.id);
  });

  it('per-user budget enforced across multiple executions', async () => {
    // With prompt=40, maxTokens=10, costPerToken=0.1, response='response' (8 chars):
    //   estimate = (40/4 * 0.1) + (10 * 0.1) = 1.0 + 1.0 = 2.0
    //   actual   = (40 * 0.1) + (8 * 0.1) = 4.0 + 0.8 = 4.8
    // Post-reconciliation budget check (step 9 in CostTracker) checks currentSpend+0 > limit.
    // After exec 1: currentSpend=4.8. Post-check: 4.8 < 10 → OK
    // After exec 2: currentSpend=9.6. Post-check: 9.6 < 10 → OK
    // Exec 3 pre-check: 9.6 + 2.0 = 11.6 > 10 → FAILS
    const provider = createNamedProvider('test-provider', 'response');
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.1, output: 0.1 } }],
      },
      cost: {
        budgets: {
          perUser: { limit: 10, enforcement: 'hard', window: { type: 'none' } },
        },
      },
    });

    engine.register('user-budget-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'a'.repeat(40), maxTokens: 10 });
      return 'ok';
    }, { maxRetries: 0 });

    // First execution should succeed
    const e1 = await engine.trigger('user-budget-flow', { idempotencyKey: 'ub-1', userId: 'user-a' });
    await waitForCompletion(engine, e1.id);
    const f1 = await engine.getExecution(e1.id);
    expect(f1!.state).toBe('complete');

    // Second execution should succeed (post-reconcile: 9.6 < 10)
    const e2 = await engine.trigger('user-budget-flow', { idempotencyKey: 'ub-2', userId: 'user-a' });
    await waitForCompletion(engine, e2.id);
    const f2 = await engine.getExecution(e2.id);
    expect(f2!.state).toBe('complete');

    // Third should hit budget (pre-check: 9.6 + 2.0 = 11.6 > 10)
    const e3 = await engine.trigger('user-budget-flow', { idempotencyKey: 'ub-3', userId: 'user-a' });
    await waitForCompletion(engine, e3.id);
    const f3 = await engine.getExecution(e3.id);
    expect(f3!.state).toBe('failed');
    expect(f3!.error!.message).toContain('Budget exceeded');
  });

  it('per-flow budget with hourly window', async () => {
    // With prompt=30, maxTokens=10, costPerToken=0.1, response='response' (8 chars):
    //   estimate = (30/4 * 0.1) + (10 * 0.1) = 0.75 + 1.0 = 1.75
    //   actual   = (30 * 0.1) + (8 * 0.1) = 3.0 + 0.8 = 3.8
    // After exec 1: currentSpend=3.8. Post-check: 3.8 < 8 → OK
    // After exec 2: currentSpend=7.6. Post-check: 7.6 < 8 → OK
    // Exec 3 pre-check: 7.6 + 1.75 = 9.35 > 8 → FAILS
    const provider = createNamedProvider('test-provider', 'response');
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.1, output: 0.1 } }],
      },
      cost: {
        budgets: {
          perFlow: { limit: 8, enforcement: 'hard', window: { type: 'hourly' } },
        },
      },
    });

    engine.register('hourly-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'a'.repeat(30), maxTokens: 10 });
      return 'ok';
    }, { maxRetries: 0 });

    const e1 = await engine.trigger('hourly-flow', { idempotencyKey: 'hf-1' });
    await waitForCompletion(engine, e1.id);
    const f1 = await engine.getExecution(e1.id);
    expect(f1!.state).toBe('complete');

    const e2 = await engine.trigger('hourly-flow', { idempotencyKey: 'hf-2' });
    await waitForCompletion(engine, e2.id);
    const f2 = await engine.getExecution(e2.id);
    expect(f2!.state).toBe('complete');

    const e3 = await engine.trigger('hourly-flow', { idempotencyKey: 'hf-3' });
    await waitForCompletion(engine, e3.id);
    const f3 = await engine.getExecution(e3.id);
    expect(f3!.state).toBe('failed');
    expect(f3!.error!.message).toContain('Budget exceeded');
  });

  it('cost events fire for agent model calls', async () => {
    const provider = createNamedProvider('agent-provider', 'Final answer');
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.02 } }],
      },
      cost: {},
    });

    const handler = createAgentHandler({
      systemPrompt: 'You are a test agent.',
      maxIterations: 3,
    });

    engine.register('agent-cost-flow', handler, { maxRetries: 0 });

    const costEvents: unknown[] = [];
    engine.on('cost:request', (e) => costEvents.push(e));

    const exec = await engine.trigger('agent-cost-flow', {
      idempotencyKey: 'ac-1',
      input: 'test query',
    });
    await waitForCompletion(engine, exec.id);

    // Agent with no tools completes in 1 iteration → 1 model call → 1 cost event
    expect(costEvents.length).toBeGreaterThanOrEqual(1);
  });
});
