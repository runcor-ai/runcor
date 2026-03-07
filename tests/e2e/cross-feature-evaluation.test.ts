// E2E: Evaluation combined with other subsystems (8 tests)
// Verifies evaluation interacting with cost, policy, agents — currently 0% covered

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../src/engine.js';
import { createAgentHandler } from '../../src/agent/handler.js';
import { RetryableError } from '../../src/errors.js';
import { createTestEngine, waitForCompletion, createNamedProvider, delay } from './helpers.js';
import type { EvalContext } from '../../src/types.js';

let engine: Runcor;

afterEach(async () => {
  if (engine) await engine.shutdown();
});

describe('Cross-feature: Evaluation × Cost/Agent/Policy', { timeout: 30000 }, () => {
  it('evaluator receives full context from cost-tracked execution', async () => {
    let capturedCtx: EvalContext | null = null;
    const provider = createNamedProvider('test-provider', 'response');

    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.02 } }],
      },
      cost: {},
      evaluation: {
        evaluators: [
          {
            name: 'context-checker',
            priority: 1,
            evaluate: (ctx) => {
              capturedCtx = ctx;
              return { scores: { quality: 0.9 } };
            },
          },
        ],
      },
    });

    engine.register('eval-ctx-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'work' });
      return 'result-value';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('eval-ctx-flow', {
      idempotencyKey: 'ec-1',
      userId: 'eval-user',
      input: 'test-input',
    });
    await waitForCompletion(engine, exec.id);
    await delay(300);

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.executionId).toBe(exec.id);
    expect(capturedCtx!.flowName).toBe('eval-ctx-flow');
    expect(capturedCtx!.output).toBe('result-value');
    expect(capturedCtx!.input).toBe('test-input');
    expect(capturedCtx!.userId).toBe('eval-user');
    expect(capturedCtx!.state).toBe('complete');
    expect(capturedCtx!.duration).toBeGreaterThanOrEqual(0);
  });

  it('evaluation does not add cost entries', async () => {
    const provider = createNamedProvider('test-provider', 'response');
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.02 } }],
      },
      cost: {},
      evaluation: {
        evaluators: [
          {
            name: 'no-cost-eval',
            priority: 1,
            evaluate: () => ({ scores: { quality: 0.8 } }),
          },
        ],
      },
    });

    engine.register('no-cost-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'work' });
      return 'done';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('no-cost-flow', { idempotencyKey: 'nc-1' });
    await waitForCompletion(engine, exec.id);

    const entriesBefore = engine.getCostLedger()!.query({}).length;
    await delay(300); // Wait for eval to complete
    const entriesAfter = engine.getCostLedger()!.query({}).length;

    expect(entriesAfter).toBe(entriesBefore);
  });

  it('multiple evaluators with different flowNames filters', async () => {
    const evalACalls: string[] = [];
    const evalBCalls: string[] = [];

    engine = await createTestEngine({
      evaluation: {
        evaluators: [
          {
            name: 'eval-A',
            priority: 1,
            flowNames: ['flow-x'],
            evaluate: (ctx) => {
              evalACalls.push(ctx.flowName);
              return { scores: { quality: 0.9 } };
            },
          },
          {
            name: 'eval-B',
            priority: 2,
            flowNames: ['flow-y'],
            evaluate: (ctx) => {
              evalBCalls.push(ctx.flowName);
              return { scores: { quality: 0.7 } };
            },
          },
        ],
      },
    });

    engine.register('flow-x', async () => 'result-x', { maxRetries: 0 });
    engine.register('flow-y', async () => 'result-y', { maxRetries: 0 });

    const ex = await engine.trigger('flow-x', { idempotencyKey: 'fx-1' });
    const ey = await engine.trigger('flow-y', { idempotencyKey: 'fy-1' });
    await waitForCompletion(engine, ex.id);
    await waitForCompletion(engine, ey.id);
    await delay(300);

    expect(evalACalls).toEqual(['flow-x']);
    expect(evalBCalls).toEqual(['flow-y']);
  });

  it('evaluator error does not crash engine', async () => {
    engine = await createTestEngine({
      evaluation: {
        evaluators: [
          {
            name: 'crashing-eval',
            priority: 1,
            evaluate: () => {
              throw new Error('eval internal error');
            },
          },
        ],
      },
    });

    engine.register('crash-eval-flow', async () => 'done', { maxRetries: 0 });

    const exec = await engine.trigger('crash-eval-flow', { idempotencyKey: 'ce-1' });
    await waitForCompletion(engine, exec.id);
    await delay(300);

    // Engine should still be operational
    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');

    const evalRecord = engine.getEvaluation(exec.id);
    expect(evalRecord).not.toBeNull();
    expect(evalRecord!.errors.length).toBe(1);
    expect(evalRecord!.errors[0].evaluatorName).toBe('crashing-eval');
    expect(evalRecord!.errors[0].error).toContain('eval internal error');
  });

  it('evaluator timeout captured in EvalRecord', async () => {
    engine = await createTestEngine({
      evaluation: {
        evaluators: [
          {
            name: 'slow-eval',
            priority: 1,
            timeoutMs: 100,
            evaluate: async () => {
              await new Promise((r) => setTimeout(r, 5000));
              return { scores: { quality: 1.0 } };
            },
          },
        ],
      },
    });

    engine.register('timeout-eval-flow', async () => 'done', { maxRetries: 0 });

    const exec = await engine.trigger('timeout-eval-flow', { idempotencyKey: 'te-1' });
    await waitForCompletion(engine, exec.id);
    await delay(500);

    const evalRecord = engine.getEvaluation(exec.id);
    expect(evalRecord).not.toBeNull();
    expect(evalRecord!.errors.length).toBe(1);
    expect(evalRecord!.errors[0].evaluatorName).toBe('slow-eval');
    expect(evalRecord!.errors[0].timedOut).toBe(true);
  });

  it('evaluation after retry success', async () => {
    let evalCalled = false;
    let attempt = 0;

    engine = await createTestEngine({
      evaluation: {
        evaluators: [
          {
            name: 'retry-eval',
            priority: 1,
            evaluate: (ctx) => {
              evalCalled = true;
              expect(ctx.state).toBe('complete');
              expect(ctx.output).toBe('success-after-retry');
              return { scores: { quality: 0.8 } };
            },
          },
        ],
      },
    });

    engine.register('retry-eval-flow', async () => {
      attempt++;
      if (attempt < 2) throw new RetryableError('transient');
      return 'success-after-retry';
    }, { maxRetries: 3, baseRetryDelay: 10, maxRetryDelay: 50 });

    const exec = await engine.trigger('retry-eval-flow', { idempotencyKey: 're-1' });
    await waitForCompletion(engine, exec.id);
    await delay(300);

    expect(evalCalled).toBe(true);
  });

  it('evaluation runs only on complete, not on failed', async () => {
    const evalFlows: string[] = [];

    engine = await createTestEngine({
      evaluation: {
        evaluators: [
          {
            name: 'state-eval',
            priority: 1,
            evaluate: (ctx) => {
              evalFlows.push(ctx.flowName);
              return { scores: { quality: 0.5 } };
            },
          },
        ],
      },
    });

    engine.register('success-flow', async () => 'ok', { maxRetries: 0 });
    engine.register('fail-flow', async () => {
      throw new Error('permanent failure');
    }, { maxRetries: 0 });

    const e1 = await engine.trigger('success-flow', { idempotencyKey: 'sf-1' });
    const e2 = await engine.trigger('fail-flow', { idempotencyKey: 'ff-1' });
    await waitForCompletion(engine, e1.id);
    await waitForCompletion(engine, e2.id);
    await delay(300);

    // Only success-flow should have been evaluated
    expect(evalFlows).toContain('success-flow');
    expect(evalFlows).not.toContain('fail-flow');
  });
});
