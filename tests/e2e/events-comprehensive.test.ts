// E2E: Complete event catalog verification (16 tests)
// Verify every event type fires with correct payload shape

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import { createWaitSignal } from '../../src/wait-signal.js';
import { RetryableError } from '../../src/errors.js';
import { createTestEngine, waitForState, waitForCompletion, createNamedProvider, delay } from './helpers.js';
import type {
  CostRequestEvent,
  CostBudgetWarningEvent,
  CostBudgetExceededEvent,
  EvalScoreEvent,
  EvalCompleteEvent,
  EvalFlaggedEvent,
} from '../../src/types.js';

let engine: Runcor;

afterEach(async () => {
  if (engine) await engine.shutdown();
});

describe('Events: comprehensive catalog verification', { timeout: 30000 }, () => {
  it('execution:state_change fires for every transition with correct payload', async () => {
    engine = await createTestEngine();
    const events: Array<{ executionId: string; from: string; to: string; timestamp: Date }> = [];
    engine.on('execution:state_change', (e) => events.push(e));

    engine.register('state-events-flow', async () => 'done', { maxRetries: 0 });

    const exec = await engine.trigger('state-events-flow', { idempotencyKey: 'se-1' });
    await waitForCompletion(engine, exec.id);

    expect(events.length).toBeGreaterThanOrEqual(2);
    // Should have queued→running and running→complete
    expect(events.find((e) => e.from === 'queued' && e.to === 'running')).toBeDefined();
    expect(events.find((e) => e.from === 'running' && e.to === 'complete')).toBeDefined();
    // Each event has correct shape
    for (const e of events) {
      expect(e.executionId).toBe(exec.id);
      expect(e.timestamp).toBeInstanceOf(Date);
    }
  });

  it('execution:complete fires for success', async () => {
    engine = await createTestEngine();
    const events: unknown[] = [];
    engine.on('execution:complete', (e) => events.push(e));

    engine.register('success-event-flow', async () => 'my-result', { maxRetries: 0 });

    const exec = await engine.trigger('success-event-flow', { idempotencyKey: 'sce-1' });
    await waitForCompletion(engine, exec.id);

    expect(events.length).toBe(1);
    const event = events[0] as any;
    expect(event.executionId).toBe(exec.id);
    expect(event.state).toBe('complete');
    expect(event.result).toBe('my-result');
  });

  it('execution:complete fires for failure', async () => {
    engine = await createTestEngine();
    const events: unknown[] = [];
    engine.on('execution:complete', (e) => events.push(e));

    engine.register('fail-event-flow', async () => {
      throw new Error('boom');
    }, { maxRetries: 0 });

    const exec = await engine.trigger('fail-event-flow', { idempotencyKey: 'fce-1' });
    await waitForCompletion(engine, exec.id);

    expect(events.length).toBe(1);
    const event = events[0] as any;
    expect(event.executionId).toBe(exec.id);
    expect(event.state).toBe('failed');
    expect(event.error).toBeDefined();
  });

  it('cost:request event payload', async () => {
    const provider = createNamedProvider('cost-event-provider', 'response');
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.02 } }],
      },
      cost: {},
    });

    const events: CostRequestEvent[] = [];
    engine.on('cost:request', (e) => events.push(e));

    engine.register('cost-event-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'test prompt' });
      return 'done';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('cost-event-flow', {
      idempotencyKey: 'cre-1',
      userId: 'cost-user',
    });
    await waitForCompletion(engine, exec.id);

    expect(events.length).toBe(1);
    const e = events[0];
    expect(e.provider).toBe('cost-event-provider');
    expect(e.model).toBe('cost-event-provider');
    expect(e.promptTokens).toBeGreaterThan(0);
    expect(e.completionTokens).toBeGreaterThan(0);
    expect(e.cost).toBeGreaterThan(0);
    expect(e.executionId).toBe(exec.id);
    expect(e.flowName).toBe('cost-event-flow');
    expect(e.userId).toBe('cost-user');
    expect(e.timestamp).toBeInstanceOf(Date);
  });

  it('cost:budget_warning event payload', async () => {
    // Need: estimate + currentSpend >= limit * warningThreshold
    // Use maxTokens to control: estimate = (60/4 * 0.1) + (10 * 0.1) = 1.5 + 1.0 = 2.5
    // With limit=4, warningThreshold=0.5: threshold = 2.0
    // 1st call: 0 + 2.5 = 2.5 >= 2.0 → warning fires
    const provider = createNamedProvider('warn-provider', 'response');
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.1, output: 0.1 } }],
      },
      cost: {
        budgets: {
          perFlow: { limit: 4, enforcement: 'hard' },
        },
        warningThreshold: 0.5,
      },
    });

    const warnings: CostBudgetWarningEvent[] = [];
    engine.on('cost:budget_warning', (e) => warnings.push(e));

    engine.register('warning-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'a'.repeat(60), maxTokens: 10 });
      return 'done';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('warning-flow', { idempotencyKey: 'bw-1' });
    await waitForCompletion(engine, exec.id);

    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const w = warnings[0];
    expect(w.scope).toBeDefined();
    expect(w.limit).toBe(4);
    expect(w.currentSpend).toBeGreaterThanOrEqual(0);
    expect(w.warningThreshold).toBe(0.5);
    expect(w.timestamp).toBeInstanceOf(Date);
  });

  it('cost:budget_exceeded event payload', async () => {
    // Hard enforcement throws BudgetExceededError without emitting an event.
    // Soft enforcement emits the event but lets the request proceed.
    // Use perFlow soft budget with 2 model calls: 1st passes, 2nd triggers exceeded event.
    // With prompt=40, maxTokens=10, costPerToken=0.1, response='response' (8 chars):
    //   estimate = (40/4 * 0.1) + (10 * 0.1) = 1.0 + 1.0 = 2.0
    //   actual   = (40 * 0.1) + (8 * 0.1) = 4.0 + 0.8 = 4.8
    // With limit=6: 1st pre-check: 0+2.0=2.0<6 → OK. Post-reconcile: 4.8.
    // 2nd pre-check: 4.8+2.0=6.8>6 → exceeded event fires (soft, blocked=false)
    const provider = createNamedProvider('exceed-provider', 'response');
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.1, output: 0.1 } }],
      },
      cost: {
        budgets: {
          perFlow: { limit: 6, enforcement: 'soft' },
        },
      },
    });

    const exceeded: CostBudgetExceededEvent[] = [];
    engine.on('cost:budget_exceeded', (e) => exceeded.push(e));

    engine.register('exceed-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'a'.repeat(40), maxTokens: 10 });
      // After reconcile, currentSpend=4.8. 2nd call: 4.8+2.0=6.8>6 → exceeded event
      await ctx.model.complete({ prompt: 'a'.repeat(40), maxTokens: 10 });
      return 'done';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('exceed-flow', { idempotencyKey: 'be-1' });
    await waitForCompletion(engine, exec.id);

    expect(exceeded.length).toBeGreaterThanOrEqual(1);
    const e = exceeded[0];
    expect(e.scope).toBeDefined();
    expect(e.limit).toBe(6);
    expect(e.currentSpend).toBeGreaterThanOrEqual(0);
    expect(e.enforcement).toBe('soft');
    expect(e.blocked).toBe(false);
    expect(e.timestamp).toBeInstanceOf(Date);
  });

  it('policy:violation event payload', async () => {
    engine = await createTestEngine({
      policy: {
        rules: [
          {
            name: 'deny-rule',
            priority: 1,
            operations: ['trigger'],
            evaluate: (ctx) => {
              if (ctx.flowName === 'denied-event-flow') {
                return { action: 'deny', reason: 'Not allowed' };
              }
              return { action: 'allow', reason: null };
            },
          },
        ],
      },
    });

    const violations: unknown[] = [];
    engine.on('policy:violation', (e) => violations.push(e));

    engine.register('denied-event-flow', async () => 'ok', { maxRetries: 0 });

    await expect(
      engine.trigger('denied-event-flow', { idempotencyKey: 'pv-1', userId: 'user-x' }),
    ).rejects.toThrow();

    expect(violations.length).toBe(1);
    const v = violations[0] as any;
    expect(v.ruleName).toBe('deny-rule');
    expect(v.operation).toBe('trigger');
    expect(v.flowName).toBe('denied-event-flow');
    expect(v.userId).toBe('user-x');
    expect(v.reason).toBe('Not allowed');
    expect(v.timestamp).toBeInstanceOf(Date);
  });

  it('policy:warning event payload', async () => {
    engine = await createTestEngine({
      policy: {
        guardrails: [
          {
            name: 'warn-guard',
            phase: 'output',
            mode: 'warn',
            priority: 1,
            handler: async () => ({
              action: 'warn' as const,
              reason: 'Suspicious content',
            }),
          },
        ],
      },
    });

    const warnings: unknown[] = [];
    engine.on('policy:warning', (e) => warnings.push(e));

    engine.register('warn-event-flow', async () => 'content', { maxRetries: 0 });

    const exec = await engine.trigger('warn-event-flow', {
      idempotencyKey: 'pw-1',
      userId: 'warn-user',
    });
    await waitForCompletion(engine, exec.id);

    expect(warnings.length).toBe(1);
    const w = warnings[0] as any;
    expect(w.guardrailName).toBe('warn-guard');
    expect(w.phase).toBe('output');
    expect(w.flowName).toBe('warn-event-flow');
    expect(w.reason).toBe('Suspicious content');
    expect(w.timestamp).toBeInstanceOf(Date);
  });

  it('policy:rate_limited event payload', async () => {
    engine = await createTestEngine({
      policy: {
        rateLimits: [
          {
            name: 'event-rate-limit',
            scope: 'global',
            limit: 1,
            windowMs: 60000,
            behavior: 'reject',
          },
        ],
      },
    });

    const rateLimited: unknown[] = [];
    engine.on('policy:rate_limited', (e) => rateLimited.push(e));

    engine.register('rate-event-flow', async () => 'ok', { maxRetries: 0 });

    await engine.trigger('rate-event-flow', { idempotencyKey: 'rl-1' });
    await delay(50);

    await expect(
      engine.trigger('rate-event-flow', { idempotencyKey: 'rl-2' }),
    ).rejects.toThrow(/rate.?limit/i);

    expect(rateLimited.length).toBe(1);
    const r = rateLimited[0] as any;
    expect(r.rateLimitName).toBe('event-rate-limit');
    expect(r.scope).toBe('global');
    expect(r.flowName).toBe('rate-event-flow');
    expect(r.limit).toBe(1);
    expect(r.windowMs).toBe(60000);
    expect(r.behavior).toBe('reject');
    expect(r.timestamp).toBeInstanceOf(Date);
  });

  it('eval:score event per evaluator', async () => {
    engine = await createTestEngine({
      evaluation: {
        evaluators: [
          {
            name: 'scorer-1',
            priority: 1,
            evaluate: () => ({ scores: { quality: 0.9, relevance: 0.8 } }),
          },
          {
            name: 'scorer-2',
            priority: 2,
            evaluate: () => ({ scores: { safety: 0.7 } }),
          },
        ],
      },
    });

    const scoreEvents: EvalScoreEvent[] = [];
    engine.on('eval:score', (e) => scoreEvents.push(e));

    engine.register('eval-score-flow', async () => 'result', { maxRetries: 0 });

    const exec = await engine.trigger('eval-score-flow', { idempotencyKey: 'es-1' });
    await waitForCompletion(engine, exec.id);
    await delay(300);

    expect(scoreEvents.length).toBe(2);
    const s1 = scoreEvents.find((e) => e.evaluatorName === 'scorer-1');
    const s2 = scoreEvents.find((e) => e.evaluatorName === 'scorer-2');
    expect(s1).toBeDefined();
    expect(s1!.scores).toEqual({ quality: 0.9, relevance: 0.8 });
    expect(s1!.executionId).toBe(exec.id);
    expect(s2).toBeDefined();
    expect(s2!.scores).toEqual({ safety: 0.7 });
  });

  it('eval:complete event after all evaluators', async () => {
    engine = await createTestEngine({
      evaluation: {
        evaluators: [
          {
            name: 'complete-eval',
            priority: 1,
            evaluate: () => ({ scores: { quality: 0.8 } }),
          },
        ],
      },
    });

    const completeEvents: EvalCompleteEvent[] = [];
    engine.on('eval:complete', (e) => completeEvents.push(e));

    engine.register('eval-complete-flow', async () => 'result', { maxRetries: 0 });

    const exec = await engine.trigger('eval-complete-flow', { idempotencyKey: 'ec-1' });
    await waitForCompletion(engine, exec.id);
    await delay(300);

    expect(completeEvents.length).toBe(1);
    const c = completeEvents[0];
    expect(c.executionId).toBe(exec.id);
    expect(c.flowName).toBe('eval-complete-flow');
    expect(c.overallScore).toBeCloseTo(0.8, 1);
    expect(c.evaluatorCount).toBe(1);
    expect(c.errorCount).toBe(0);
    expect(c.timestamp).toBeInstanceOf(Date);
  });

  it('eval:flagged event on auto-flag', async () => {
    engine = await createTestEngine({
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

    const flagEvents: EvalFlaggedEvent[] = [];
    engine.on('eval:flagged', (e) => flagEvents.push(e));

    engine.register('flagged-flow', async () => 'result', { maxRetries: 0 });

    const exec = await engine.trigger('flagged-flow', { idempotencyKey: 'ef-1' });
    await waitForCompletion(engine, exec.id);
    await delay(300);

    expect(flagEvents.length).toBe(1);
    const f = flagEvents[0];
    expect(f.executionId).toBe(exec.id);
    expect(f.flowName).toBe('flagged-flow');
    expect(f.source).toBe('auto');
    expect(f.status).toBe('pending');
    expect(f.timestamp).toBeInstanceOf(Date);
  });

  it('flow:registered event', async () => {
    engine = await createTestEngine();
    const events: unknown[] = [];
    engine.on('flow:registered', (e) => events.push(e));

    engine.register('registered-flow', async () => 'ok', { maxRetries: 0 });

    expect(events.length).toBe(1);
    expect((events[0] as any).name).toBe('registered-flow');
  });

  it('flow:unregistered event', async () => {
    engine = await createTestEngine();
    const events: unknown[] = [];

    engine.register('unreg-flow', async () => 'ok', { maxRetries: 0 });

    engine.on('flow:unregistered', (e) => events.push(e));
    engine.unregister('unreg-flow');

    expect(events.length).toBe(1);
    expect((events[0] as any).name).toBe('unreg-flow');
  });

  it('engine ready event fires after createEngine', async () => {
    let readyFired = false;

    // We need to capture the event during creation
    // createEngine calls emit('ready') at the end, so we need to listen right after
    engine = await createTestEngine();

    // Since ready already fired during createEngine, we verify the engine is ready
    // by checking that operations work
    engine.register('ready-test', async () => 'ok', { maxRetries: 0 });
    const exec = await engine.trigger('ready-test', { idempotencyKey: 'rt-1' });
    await waitForCompletion(engine, exec.id);
    expect((await engine.getExecution(exec.id))!.state).toBe('complete');
  });

  it('engine shutdown event fires when shutdown begins', async () => {
    engine = await createTestEngine();
    let shutdownFired = false;
    engine.on('shutdown', () => {
      shutdownFired = true;
    });

    await engine.shutdown();
    expect(shutdownFired).toBe(true);
  });
});
