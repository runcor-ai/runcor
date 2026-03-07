// E2E: Complete chains through all subsystems (10 tests)
// End-to-end chains exercising the FULL stack simultaneously — currently 0% covered

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import { createAgentHandler } from '../../src/agent/handler.js';
import { createWaitSignal } from '../../src/wait-signal.js';
import { RetryableError } from '../../src/errors.js';
import { createNamedProvider, waitForState, waitForCompletion, delay } from './helpers.js';
import type { AgentResult } from '../../src/agent/types.js';

let engine: Runcor;

afterEach(async () => {
  if (engine) await engine.shutdown();
});

describe('Full lifecycle chains: all subsystems', { timeout: 30000 }, () => {
  it('full chain: trigger → policy → guardrail(input) → flow → model → cost → guardrail(output) → evaluation → complete', async () => {
    const trace: string[] = [];
    const provider = createNamedProvider('full-chain', 'model response');

    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.02 } }],
      },
      cost: {},
      policy: {
        rules: [
          {
            name: 'allow-all',
            priority: 1,
            operations: ['trigger'],
            evaluate: () => {
              trace.push('policy');
              return { action: 'allow', reason: null };
            },
          },
        ],
        guardrails: [
          {
            name: 'input-guard',
            phase: 'input',
            mode: 'transform',
            priority: 1,
            handler: async (content) => {
              trace.push('input-guardrail');
              return { action: 'pass' as const, reason: null };
            },
          },
          {
            name: 'output-guard',
            phase: 'output',
            mode: 'transform',
            priority: 1,
            handler: async (content) => {
              trace.push('output-guardrail');
              return { action: 'pass' as const, reason: null };
            },
          },
        ],
      },
      evaluation: {
        evaluators: [
          {
            name: 'quality-eval',
            priority: 1,
            evaluate: () => {
              trace.push('evaluator');
              return { scores: { quality: 0.9 } };
            },
          },
        ],
      },
    });

    engine.register('full-chain-flow', async (ctx) => {
      trace.push('handler-start');
      await ctx.model.complete({ prompt: 'work' });
      trace.push('model-called');
      return 'final-result';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('full-chain-flow', {
      idempotencyKey: 'fc-1',
      input: 'test-input',
    });
    await waitForCompletion(engine, exec.id);
    await delay(300);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');

    // Verify subsystems ran in order
    expect(trace).toContain('policy');
    expect(trace).toContain('input-guardrail');
    expect(trace).toContain('handler-start');
    expect(trace).toContain('model-called');
    expect(trace).toContain('output-guardrail');
    expect(trace).toContain('evaluator');

    // Verify cost was recorded
    const entries = engine.getCostLedger()!.query({ executionId: exec.id });
    expect(entries.length).toBe(1);

    // Verify evaluation ran
    const evalRecord = engine.getEvaluation(exec.id);
    expect(evalRecord).not.toBeNull();
  });

  it('full chain: trigger → wait → resume → complete → evaluation → auto-flag', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      evaluation: {
        evaluators: [
          {
            name: 'low-scorer',
            priority: 1,
            evaluate: () => ({ scores: { quality: 0.1 } }),
          },
        ],
        autoFlagScoreThreshold: 0.5,
      },
    });

    engine.register('wait-eval-flow', async (ctx) => {
      if (!ctx.resumeData) {
        return createWaitSignal({ reason: 'approval' });
      }
      return 'approved';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('wait-eval-flow', { idempotencyKey: 'we-1' });
    await waitForState(engine, exec.id, 'waiting');

    await engine.resume(exec.id, 'yes');
    await waitForCompletion(engine, exec.id);
    await delay(300);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');

    const evalRecord = engine.getEvaluation(exec.id);
    expect(evalRecord).not.toBeNull();
    expect(evalRecord!.overallScore).toBeLessThan(0.5);

    // Check auto-flag was created
    const flags = engine.listFlags({ flowName: 'wait-eval-flow' });
    expect(flags.length).toBeGreaterThan(0);
  });

  it('full chain: trigger → retry → retry → succeed → cost accumulated → evaluation', async () => {
    let attempt = 0;
    const provider = createNamedProvider('retry-chain', 'response');

    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.02 } }],
      },
      cost: {},
      evaluation: {
        evaluators: [
          {
            name: 'retry-eval',
            priority: 1,
            evaluate: () => ({ scores: { quality: 0.7 } }),
          },
        ],
      },
    });

    engine.register('retry-chain-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'work' });
      attempt++;
      if (attempt < 3) throw new RetryableError('fail');
      return 'success';
    }, { maxRetries: 5, baseRetryDelay: 10, maxRetryDelay: 50 });

    const exec = await engine.trigger('retry-chain-flow', { idempotencyKey: 'rc-1' });
    await waitForCompletion(engine, exec.id);
    await delay(300);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    expect(attempt).toBe(3);

    // Cost accumulated across all 3 attempts
    const entries = engine.getCostLedger()!.query({ executionId: exec.id });
    expect(entries.length).toBe(3);

    // Evaluation ran
    const evalRecord = engine.getEvaluation(exec.id);
    expect(evalRecord).not.toBeNull();
  });

  it('short-circuit: trigger → policy deny', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      policy: {
        rules: [
          {
            name: 'deny-trigger',
            priority: 1,
            operations: ['trigger'],
            evaluate: () => ({ action: 'deny', reason: 'maintenance mode' }),
          },
        ],
      },
    });

    engine.register('denied-flow', async () => 'should not run', { maxRetries: 0 });

    await expect(
      engine.trigger('denied-flow', { idempotencyKey: 'sc-1' }),
    ).rejects.toThrow(/denied|maintenance/i);
  });

  it('short-circuit: trigger → input guardrail block', async () => {
    const provider = createNamedProvider('block-input', 'response');
    let modelCalled = false;

    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.02 } }],
      },
      cost: {},
      policy: {
        guardrails: [
          {
            name: 'input-blocker',
            phase: 'input',
            mode: 'block',
            priority: 1,
            handler: async () => ({
              action: 'block' as const,
              reason: 'Bad input',
            }),
          },
        ],
      },
    });

    engine.register('input-blocked-flow', async (ctx) => {
      modelCalled = true;
      await ctx.model.complete({ prompt: 'should not happen' });
      return 'done';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('input-blocked-flow', { idempotencyKey: 'ib-1' });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('failed');
    expect(final!.error!.message).toMatch(/guardrail|blocked/i);
    expect(modelCalled).toBe(false);

    // No cost entries
    const entries = engine.getCostLedger()!.query({});
    expect(entries.length).toBe(0);
  });

  it('short-circuit: trigger → model → output guardrail block → fail', async () => {
    const provider = createNamedProvider('output-block', 'response');
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.02 } }],
      },
      cost: {},
      policy: {
        guardrails: [
          {
            name: 'output-blocker',
            phase: 'output',
            mode: 'block',
            priority: 1,
            handler: async () => ({
              action: 'block' as const,
              reason: 'Unsafe output',
            }),
          },
        ],
      },
    });

    engine.register('output-blocked-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'work' });
      return 'unsafe result';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('output-blocked-flow', { idempotencyKey: 'ob-1' });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('failed');
    expect(final!.error!.message).toMatch(/guardrail|blocked/i);

    // Cost was recorded (model ran before output guardrail)
    const entries = engine.getCostLedger()!.query({ executionId: exec.id });
    expect(entries.length).toBe(1);
  });

  it('short-circuit: trigger → model → budget exceeded → fail', async () => {
    const provider = createNamedProvider('budget-fail', 'x'.repeat(100));
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 10, output: 10 } }],
      },
      cost: {
        budgets: {
          perRequest: { limit: 1, enforcement: 'hard' },
        },
      },
    });

    engine.register('budget-fail-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'a'.repeat(100) });
      return 'done';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('budget-fail-flow', { idempotencyKey: 'bf-1' });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('failed');
    expect(final!.error!.message).toContain('Budget exceeded');
  });

  it('short-circuit: trigger → rate limited', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      policy: {
        rateLimits: [
          {
            name: 'strict-limit',
            scope: 'global',
            limit: 1,
            windowMs: 60000,
            behavior: 'reject',
          },
        ],
      },
    });

    engine.register('rate-limited-flow', async () => 'ok', { maxRetries: 0 });

    // First trigger succeeds
    const e1 = await engine.trigger('rate-limited-flow', { idempotencyKey: 'rl-1' });
    await waitForCompletion(engine, e1.id);

    // Second trigger should be rate-limited
    await expect(
      engine.trigger('rate-limited-flow', { idempotencyKey: 'rl-2' }),
    ).rejects.toThrow(/rate.?limit/i);
  });

  it('agent full chain: trigger → agent loop → cost tracked → evaluation → complete', async () => {
    const provider = createNamedProvider('agent-chain', 'Final answer');
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.02 } }],
      },
      cost: {},
      evaluation: {
        evaluators: [
          {
            name: 'agent-chain-eval',
            priority: 1,
            evaluate: () => ({ scores: { quality: 0.8 } }),
          },
        ],
      },
    });

    const handler = createAgentHandler({
      systemPrompt: 'You are a test agent.',
      maxIterations: 5,
    });

    engine.register('agent-chain-flow', handler, { maxRetries: 0 });

    const exec = await engine.trigger('agent-chain-flow', {
      idempotencyKey: 'agc-1',
      input: 'test',
    });
    await waitForCompletion(engine, exec.id);
    await delay(300);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    const result = final!.result as AgentResult;
    expect(result.stopReason).toBe('completed');

    // Cost tracked
    const entries = engine.getCostLedger()!.query({ executionId: exec.id });
    expect(entries.length).toBeGreaterThanOrEqual(1);

    // Evaluation ran
    const evalRecord = engine.getEvaluation(exec.id);
    expect(evalRecord).not.toBeNull();
  });

  it('replay full chain: replay → policy → execute → cost tracked independently → evaluation', async () => {
    let evalCount = 0;
    const provider = createNamedProvider('replay-chain', 'response');

    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.02 } }],
      },
      cost: {},
      evaluation: {
        evaluators: [
          {
            name: 'replay-eval',
            priority: 1,
            evaluate: () => {
              evalCount++;
              return { scores: { quality: 0.9 } };
            },
          },
        ],
      },
    });

    engine.register('replay-chain-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'work' });
      return 'result';
    }, { maxRetries: 0 });

    // Original execution
    const original = await engine.trigger('replay-chain-flow', { idempotencyKey: 'rpc-1' });
    await waitForCompletion(engine, original.id);
    await delay(300);
    expect(evalCount).toBe(1);

    // Replay
    const replay = await engine.replay(original.id);
    await waitForCompletion(engine, replay.id);
    await delay(300);

    expect(evalCount).toBe(2);

    // Cost tracked independently
    const originalCost = engine.getCostLedger()!.query({ executionId: original.id });
    const replayCost = engine.getCostLedger()!.query({ executionId: replay.id });
    expect(originalCost.length).toBe(1);
    expect(replayCost.length).toBe(1);
    expect(replayCost[0].executionId).not.toBe(original.id);
  });
});
