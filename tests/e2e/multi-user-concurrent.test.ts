// E2E: Multiple users simultaneously (8 tests)
// Currently minimal coverage

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import { createWaitSignal } from '../../src/wait-signal.js';
import { createTestEngine, waitForState, waitForCompletion, createNamedProvider, delay } from './helpers.js';

let engine: Runcor;

afterEach(async () => {
  if (engine) await engine.shutdown();
});

describe('Multi-user concurrent scenarios', { timeout: 30000 }, () => {
  it('5 users trigger same flow concurrently, each gets correct result', async () => {
    engine = await createTestEngine();

    engine.register('echo-flow', async (ctx) => {
      return `echo: ${ctx.input}`;
    }, { maxRetries: 0 });

    const users = ['alice', 'bob', 'charlie', 'diana', 'eve'];
    const executions = await Promise.all(
      users.map((user, i) =>
        engine.trigger('echo-flow', {
          idempotencyKey: `mu-${user}`,
          input: `input-from-${user}`,
          userId: user,
        }),
      ),
    );

    await Promise.all(executions.map((e) => waitForCompletion(engine, e.id)));

    for (let i = 0; i < users.length; i++) {
      const final = await engine.getExecution(executions[i].id);
      expect(final!.state).toBe('complete');
      expect(final!.result).toBe(`echo: input-from-${users[i]}`);
    }
  });

  it('user-scoped memory isolation under concurrency', async () => {
    engine = await createTestEngine();

    engine.register('memory-flow', async (ctx) => {
      const userId = ctx.input as string;
      await ctx.memory.user.set('name', userId);
      // Small delay to interleave
      await new Promise((r) => setTimeout(r, 10));
      const stored = await ctx.memory.user.get<string>('name');
      return stored;
    }, { maxRetries: 0 });

    const users = ['userA', 'userB'];
    const executions = await Promise.all(
      users.map((user) =>
        engine.trigger('memory-flow', {
          idempotencyKey: `mem-${user}`,
          input: user,
          userId: user,
        }),
      ),
    );

    await Promise.all(executions.map((e) => waitForCompletion(engine, e.id)));

    for (let i = 0; i < users.length; i++) {
      const final = await engine.getExecution(executions[i].id);
      expect(final!.state).toBe('complete');
      expect(final!.result).toBe(users[i]); // No cross-contamination
    }
  });

  it('user-scoped rate limits enforced independently', async () => {
    engine = await createTestEngine({
      policy: {
        rateLimits: [
          {
            name: 'per-user-rate',
            scope: 'user',
            limit: 1,
            windowMs: 60000,
            behavior: 'reject',
          },
        ],
      },
    });

    engine.register('rated-flow', async () => 'ok', { maxRetries: 0 });

    // User A first trigger succeeds
    const e1 = await engine.trigger('rated-flow', {
      idempotencyKey: 'ur-a1',
      userId: 'user-a',
    });
    await waitForCompletion(engine, e1.id);

    // User A second trigger fails (rate limited)
    await expect(
      engine.trigger('rated-flow', { idempotencyKey: 'ur-a2', userId: 'user-a' }),
    ).rejects.toThrow(/rate.?limit/i);

    // User B should still work
    const eB = await engine.trigger('rated-flow', {
      idempotencyKey: 'ur-b1',
      userId: 'user-b',
    });
    await waitForCompletion(engine, eB.id);
    const finalB = await engine.getExecution(eB.id);
    expect(finalB!.state).toBe('complete');
  });

  it('user-scoped cost budgets enforced independently', async () => {
    // With prompt=30, maxTokens=10, costPerToken=0.1, response='response' (8 chars):
    //   estimate = (30/4 * 0.1) + (10 * 0.1) = 0.75 + 1.0 = 1.75
    //   actual   = (30 * 0.1) + (8 * 0.1) = 3.0 + 0.8 = 3.8
    // With limit=4: 1st passes (post-check: 3.8 < 4), 2nd fails (pre-check: 3.8+1.75=5.55 > 4)
    const provider = createNamedProvider('cost-user', 'response');
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.1, output: 0.1 } }],
      },
      cost: {
        budgets: {
          perUser: { limit: 4, enforcement: 'hard', window: { type: 'none' } },
        },
      },
    });

    engine.register('user-cost-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'a'.repeat(30), maxTokens: 10 });
      return 'ok';
    }, { maxRetries: 0 });

    // User A first call succeeds (estimate 1.75 < 4, post-reconcile 3.8 < 4)
    const eA1 = await engine.trigger('user-cost-flow', {
      idempotencyKey: 'uc-a1',
      userId: 'user-a',
    });
    await waitForCompletion(engine, eA1.id);
    const fA1 = await engine.getExecution(eA1.id);
    expect(fA1!.state).toBe('complete');

    // User A second attempt exceeds budget (pre-check: 3.8 + 1.75 = 5.55 > 4)
    const eA2 = await engine.trigger('user-cost-flow', {
      idempotencyKey: 'uc-a2',
      userId: 'user-a',
    });
    await waitForCompletion(engine, eA2.id);
    const fA2 = await engine.getExecution(eA2.id);
    expect(fA2!.state).toBe('failed');
    expect(fA2!.error!.message).toContain('Budget exceeded');

    // User B should be unaffected (separate scope)
    const eB1 = await engine.trigger('user-cost-flow', {
      idempotencyKey: 'uc-b1',
      userId: 'user-b',
    });
    await waitForCompletion(engine, eB1.id);
    const fB1 = await engine.getExecution(eB1.id);
    expect(fB1!.state).toBe('complete');
  });

  it('concurrent wait/resume for different users', async () => {
    engine = await createTestEngine();

    engine.register('user-wait-flow', async (ctx) => {
      if (!ctx.resumeData) {
        return createWaitSignal({ reason: `waiting for ${ctx.input}` });
      }
      return { user: ctx.input, data: ctx.resumeData };
    }, { maxRetries: 0 });

    // Both users trigger and wait
    const eA = await engine.trigger('user-wait-flow', {
      idempotencyKey: 'uw-a',
      input: 'alice',
      userId: 'alice',
    });
    const eB = await engine.trigger('user-wait-flow', {
      idempotencyKey: 'uw-b',
      input: 'bob',
      userId: 'bob',
    });

    await waitForState(engine, eA.id, 'waiting');
    await waitForState(engine, eB.id, 'waiting');

    // Resume both independently
    await engine.resume(eA.id, { approval: 'alice-approved' });
    await engine.resume(eB.id, { approval: 'bob-approved' });

    await waitForCompletion(engine, eA.id);
    await waitForCompletion(engine, eB.id);

    const fA = await engine.getExecution(eA.id);
    const fB = await engine.getExecution(eB.id);

    expect(fA!.state).toBe('complete');
    expect(fA!.result).toEqual({ user: 'alice', data: { approval: 'alice-approved' } });

    expect(fB!.state).toBe('complete');
    expect(fB!.result).toEqual({ user: 'bob', data: { approval: 'bob-approved' } });
  });

  it('access control per user under concurrency', async () => {
    engine = await createTestEngine({
      policy: {
        accessPolicies: [
          { identity: 'allowed-user', allowedFlows: ['protected-flow'] },
          { identity: 'denied-user', deniedFlows: ['protected-flow'] },
        ],
      },
    });

    engine.register('protected-flow', async () => 'secret', { maxRetries: 0 });

    // Allowed user succeeds
    const eA = await engine.trigger('protected-flow', {
      idempotencyKey: 'ac-allowed',
      userId: 'allowed-user',
    });
    await waitForCompletion(engine, eA.id);
    const fA = await engine.getExecution(eA.id);
    expect(fA!.state).toBe('complete');

    // Denied user fails
    await expect(
      engine.trigger('protected-flow', {
        idempotencyKey: 'ac-denied',
        userId: 'denied-user',
      }),
    ).rejects.toThrow(/denied|access/i);
  });

  it('different users concurrent, isolated access control', async () => {
    // Test user isolation via access policies (tenantConfig.allowedFlows is not enforced)
    engine = await createTestEngine({
      policy: {
        accessPolicies: [
          { identity: 'user-a', allowedFlows: ['flow-a', 'shared-flow'] },
          { identity: 'user-b', allowedFlows: ['flow-b', 'shared-flow'] },
        ],
      },
    });

    engine.register('flow-a', async () => 'result-a', { maxRetries: 0 });
    engine.register('flow-b', async () => 'result-b', { maxRetries: 0 });
    engine.register('shared-flow', async () => 'shared', { maxRetries: 0 });

    // User A can access flow-a
    const eA = await engine.trigger('flow-a', { idempotencyKey: 'ua-a', userId: 'user-a' });
    await waitForCompletion(engine, eA.id);
    expect((await engine.getExecution(eA.id))!.state).toBe('complete');

    // User A cannot access flow-b
    await expect(
      engine.trigger('flow-b', { idempotencyKey: 'ua-b', userId: 'user-a' }),
    ).rejects.toThrow(/denied|access/i);

    // User B can access flow-b
    const eB = await engine.trigger('flow-b', { idempotencyKey: 'ub-b', userId: 'user-b' });
    await waitForCompletion(engine, eB.id);
    expect((await engine.getExecution(eB.id))!.state).toBe('complete');

    // Both can access shared-flow concurrently
    const eAS = await engine.trigger('shared-flow', { idempotencyKey: 'ua-s', userId: 'user-a' });
    const eBS = await engine.trigger('shared-flow', { idempotencyKey: 'ub-s', userId: 'user-b' });
    await waitForCompletion(engine, eAS.id);
    await waitForCompletion(engine, eBS.id);
    expect((await engine.getExecution(eAS.id))!.state).toBe('complete');
    expect((await engine.getExecution(eBS.id))!.state).toBe('complete');
  });

  it('mixed operations concurrent — trigger, resume, replay', async () => {
    engine = await createTestEngine();

    engine.register('mixed-ops-flow', async (ctx) => {
      if (ctx.input === 'wait-input' && !ctx.resumeData) {
        return createWaitSignal({ reason: 'need resume' });
      }
      if (ctx.resumeData) {
        return `resumed: ${ctx.resumeData}`;
      }
      return `done: ${ctx.input}`;
    }, { maxRetries: 0 });

    // User A triggers (will complete immediately)
    const eA = await engine.trigger('mixed-ops-flow', {
      idempotencyKey: 'mo-a',
      input: 'trigger-input',
      userId: 'user-a',
    });

    // User B triggers (will wait)
    const eB = await engine.trigger('mixed-ops-flow', {
      idempotencyKey: 'mo-b',
      input: 'wait-input',
      userId: 'user-b',
    });

    await waitForCompletion(engine, eA.id);
    await waitForState(engine, eB.id, 'waiting');

    // User C replays user A's execution
    const eC = await engine.replay(eA.id);

    // User B resumes
    await engine.resume(eB.id, 'approved');

    await waitForCompletion(engine, eB.id);
    await waitForCompletion(engine, eC.id);

    const fA = await engine.getExecution(eA.id);
    const fB = await engine.getExecution(eB.id);
    const fC = await engine.getExecution(eC.id);

    expect(fA!.state).toBe('complete');
    expect(fA!.result).toBe('done: trigger-input');

    expect(fB!.state).toBe('complete');
    expect(fB!.result).toBe('resumed: approved');

    expect(fC!.state).toBe('complete');
    expect(fC!.result).toBe('done: trigger-input');
  });
});
