// E2E: Policy interactions with wait/resume/eval/cost (12 tests)
// Verifies policy enforcement across lifecycle phases — currently 0% covered

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import { createWaitSignal } from '../../src/wait-signal.js';
import { EngineError } from '../../src/errors.js';
import { createTestEngine, waitForState, waitForCompletion, createNamedProvider, delay } from './helpers.js';
import type { EngineConfig, PolicyRule, Guardrail, GuardrailResult } from '../../src/types.js';

let engine: Runcor;

afterEach(async () => {
  if (engine) await engine.shutdown();
});

describe('Cross-feature: Policy × Wait/Resume/Eval/Cost', { timeout: 30000 }, () => {
  it('policy deny on resume', async () => {
    engine = await createTestEngine();

    engine.register('deny-resume-flow', async (ctx) => {
      if (!ctx.resumeData) {
        return createWaitSignal({ reason: 'waiting' });
      }
      return ctx.resumeData;
    }, { maxRetries: 0 });

    const exec = await engine.trigger('deny-resume-flow', {
      idempotencyKey: 'dr-1',
      userId: 'user-1',
    });
    await waitForState(engine, exec.id, 'waiting');

    // Add deny rule before resume
    engine.addPolicy({
      name: 'block-resume',
      priority: 1,
      operations: ['resume'],
      evaluate: () => ({ action: 'deny', reason: 'Resumptions suspended' }),
    });

    await expect(
      engine.resume(exec.id, 'data'),
    ).rejects.toThrow(/denied|Resumptions suspended/i);
  });

  it('policy deny on replay', async () => {
    engine = await createTestEngine();

    engine.register('deny-replay-flow', async () => 'result', { maxRetries: 0 });

    const exec = await engine.trigger('deny-replay-flow', { idempotencyKey: 'drp-1' });
    await waitForCompletion(engine, exec.id);

    engine.addPolicy({
      name: 'block-replay',
      priority: 1,
      operations: ['replay'],
      evaluate: () => ({ action: 'deny', reason: 'Replays disabled' }),
    });

    await expect(
      engine.replay(exec.id),
    ).rejects.toThrow(/denied|Replays disabled/i);
  });

  it('access control: user can trigger but not resume', async () => {
    engine = await createTestEngine({
      policy: {
        accessPolicies: [
          { identity: 'limited-user', allowedOperations: ['trigger'] },
        ],
      },
    });

    engine.register('ac-flow', async (ctx) => {
      if (!ctx.resumeData) {
        return createWaitSignal({ reason: 'waiting' });
      }
      return 'resumed';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('ac-flow', {
      idempotencyKey: 'ac-1',
      userId: 'limited-user',
    });
    await waitForState(engine, exec.id, 'waiting');

    await expect(
      engine.resume(exec.id, 'data'),
    ).rejects.toThrow(/denied|access/i);
  });

  it('access control: user can trigger but not replay', async () => {
    engine = await createTestEngine({
      policy: {
        accessPolicies: [
          { identity: 'trigger-only', allowedOperations: ['trigger'] },
        ],
      },
    });

    engine.register('ac-replay-flow', async () => 'done', { maxRetries: 0 });

    const exec = await engine.trigger('ac-replay-flow', {
      idempotencyKey: 'acr-1',
      userId: 'trigger-only',
    });
    await waitForCompletion(engine, exec.id);

    await expect(
      engine.replay(exec.id),
    ).rejects.toThrow(/denied|access/i);
  });

  it('guardrails apply to resumed execution output — transform mode', async () => {
    engine = await createTestEngine({
      policy: {
        guardrails: [
          {
            name: 'output-transform',
            phase: 'output',
            mode: 'transform',
            priority: 1,
            handler: async (content) => ({
              action: 'transform' as const,
              reason: 'sanitized',
              transformedContent: { original: content, sanitized: true },
            }),
          },
        ],
      },
    });

    engine.register('gr-transform-flow', async (ctx) => {
      if (!ctx.resumeData) {
        return createWaitSignal({ reason: 'waiting' });
      }
      return 'raw-output';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('gr-transform-flow', { idempotencyKey: 'gt-1' });
    await waitForState(engine, exec.id, 'waiting');

    await engine.resume(exec.id, 'approve');
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    expect(final!.result).toEqual({ original: 'raw-output', sanitized: true });
  });

  it('guardrail blocks output after resume', async () => {
    engine = await createTestEngine({
      policy: {
        guardrails: [
          {
            name: 'output-blocker',
            phase: 'output',
            mode: 'block',
            priority: 1,
            handler: async () => ({
              action: 'block' as const,
              reason: 'Blocked for safety',
            }),
          },
        ],
      },
    });

    engine.register('gr-block-flow', async (ctx) => {
      if (!ctx.resumeData) {
        return createWaitSignal({ reason: 'waiting' });
      }
      return 'unsafe output';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('gr-block-flow', { idempotencyKey: 'gb-1' });
    await waitForState(engine, exec.id, 'waiting');

    await engine.resume(exec.id, 'go');
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('failed');
    expect(final!.error!.message).toMatch(/guardrail|blocked/i);
  });

  it('rate limit applies to resume operations', async () => {
    engine = await createTestEngine({
      policy: {
        rateLimits: [
          {
            name: 'global-limit',
            scope: 'global',
            limit: 2,
            windowMs: 60000,
            behavior: 'reject',
          },
        ],
      },
    });

    engine.register('rl-flow', async (ctx) => {
      if (!ctx.resumeData) {
        return createWaitSignal({ reason: 'waiting' });
      }
      return 'resumed';
    }, { maxRetries: 0 });

    // Use up the rate limit with triggers
    const e1 = await engine.trigger('rl-flow', { idempotencyKey: 'rl-1' });
    await waitForState(engine, e1.id, 'waiting');

    const e2 = await engine.trigger('rl-flow', { idempotencyKey: 'rl-2' });
    await waitForState(engine, e2.id, 'waiting');

    // Resume should also be rate-limited
    await expect(
      engine.resume(e1.id, 'data'),
    ).rejects.toThrow(/rate.?limit/i);
  });

  it('policy-modified input reaches evaluation', async () => {
    const evalInputs: unknown[] = [];
    engine = await createTestEngine({
      policy: {
        rules: [
          {
            name: 'modify-input',
            priority: 1,
            operations: ['trigger'],
            evaluate: (ctx) => ({
              action: 'modify' as const,
              reason: 'enriched',
              modifiedInput: { original: ctx.input, enriched: true },
            }),
          },
        ],
      },
      evaluation: {
        evaluators: [
          {
            name: 'input-checker',
            priority: 1,
            evaluate: (evalCtx) => {
              evalInputs.push(evalCtx.input);
              return { scores: { quality: 0.9 } };
            },
          },
        ],
      },
    });

    engine.register('mod-eval-flow', async (ctx) => ctx.input, { maxRetries: 0 });

    const exec = await engine.trigger('mod-eval-flow', {
      idempotencyKey: 'me-1',
      input: 'original-input',
    });
    await waitForCompletion(engine, exec.id);
    await delay(200); // Allow async evaluation to complete

    expect(evalInputs.length).toBe(1);
    expect(evalInputs[0]).toEqual({ original: 'original-input', enriched: true });
  });

  it('guardrail-transformed output reaches evaluation', async () => {
    const evalOutputs: unknown[] = [];
    engine = await createTestEngine({
      policy: {
        guardrails: [
          {
            name: 'transform-output',
            phase: 'output',
            mode: 'transform',
            priority: 1,
            handler: async (content) => ({
              action: 'transform' as const,
              reason: 'filtered',
              transformedContent: `[FILTERED] ${content}`,
            }),
          },
        ],
      },
      evaluation: {
        evaluators: [
          {
            name: 'output-checker',
            priority: 1,
            evaluate: (evalCtx) => {
              evalOutputs.push(evalCtx.output);
              return { scores: { quality: 0.8 } };
            },
          },
        ],
      },
    });

    engine.register('gt-eval-flow', async () => 'raw result', { maxRetries: 0 });

    const exec = await engine.trigger('gt-eval-flow', { idempotencyKey: 'ge-1' });
    await waitForCompletion(engine, exec.id);
    await delay(200);

    expect(evalOutputs.length).toBe(1);
    expect(evalOutputs[0]).toBe('[FILTERED] raw result');
  });

  it('guardrail blocks output → evaluation does NOT run', async () => {
    let evalRan = false;
    engine = await createTestEngine({
      policy: {
        guardrails: [
          {
            name: 'blocker',
            phase: 'output',
            mode: 'block',
            priority: 1,
            handler: async () => ({
              action: 'block' as const,
              reason: 'unsafe',
            }),
          },
        ],
      },
      evaluation: {
        evaluators: [
          {
            name: 'should-not-run',
            priority: 1,
            evaluate: () => {
              evalRan = true;
              return { scores: { quality: 1.0 } };
            },
          },
        ],
      },
    });

    engine.register('blocked-eval-flow', async () => 'unsafe', { maxRetries: 0 });

    const exec = await engine.trigger('blocked-eval-flow', { idempotencyKey: 'be-1' });
    await waitForCompletion(engine, exec.id);
    await delay(200);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('failed');
    // Evaluation should not run on blocked/failed executions
    expect(evalRan).toBe(false);
  });

  it('tenant-specific access policies control flow access', async () => {
    // Use accessPolicies to control per-user flow access (tenantConfig.allowedFlows is not enforced)
    engine = await createTestEngine({
      policy: {
        accessPolicies: [
          { identity: 'allowed-user', allowedFlows: ['restricted-flow'] },
          { identity: 'blocked-user', deniedFlows: ['restricted-flow'] },
        ],
      },
    });

    engine.register('restricted-flow', async () => 'content', { maxRetries: 0 });

    // Allowed user can trigger restricted-flow
    const e1 = await engine.trigger('restricted-flow', {
      idempotencyKey: 'tg-1',
      userId: 'allowed-user',
    });
    await waitForCompletion(engine, e1.id);
    const f1 = await engine.getExecution(e1.id);
    expect(f1!.state).toBe('complete');

    // Blocked user cannot trigger restricted-flow
    await expect(
      engine.trigger('restricted-flow', {
        idempotencyKey: 'tg-2',
        userId: 'blocked-user',
      }),
    ).rejects.toThrow(/denied|access/i);
  });

  it('policy deny prevents cost accumulation', async () => {
    const provider = createNamedProvider('test-provider', 'response');
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.02 } }],
      },
      cost: {},
      policy: {
        rules: [
          {
            name: 'deny-all',
            priority: 1,
            operations: ['trigger'],
            evaluate: () => ({ action: 'deny', reason: 'denied' }),
          },
        ],
      },
    });

    engine.register('denied-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'should not run' });
      return 'done';
    }, { maxRetries: 0 });

    await expect(
      engine.trigger('denied-flow', { idempotencyKey: 'pdc-1' }),
    ).rejects.toThrow(/denied/i);

    const entries = engine.getCostLedger()!.query({});
    expect(entries.length).toBe(0);
  });
});
