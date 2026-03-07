// E2E: Flows triggering other flows (7 tests)
// Currently 0% covered

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import { createTestEngine, waitForCompletion, createNamedProvider, delay } from './helpers.js';

let engine: Runcor;

afterEach(async () => {
  if (engine) await engine.shutdown();
});

describe('Flow composition: flows triggering flows', { timeout: 30000 }, () => {
  it('flow triggers child flow via engine reference', async () => {
    engine = await createTestEngine();
    let engineRef: Runcor;

    // Capture engine reference — flows can access it via closure
    engineRef = engine;

    engine.register('child-flow', async (ctx) => {
      return `child processed: ${ctx.input}`;
    }, { maxRetries: 0 });

    engine.register('parent-flow', async (ctx) => {
      const childExec = await engineRef.trigger('child-flow', {
        idempotencyKey: `child-${ctx.executionId}`,
        input: 'child-data',
      });
      // Poll for child completion
      let child = await engineRef.getExecution(childExec.id);
      const start = Date.now();
      while (child && child.state !== 'complete' && child.state !== 'failed' && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 10));
        child = await engineRef.getExecution(childExec.id);
      }
      return { parentResult: 'done', childResult: child?.result };
    }, { maxRetries: 0 });

    const exec = await engine.trigger('parent-flow', { idempotencyKey: 'pf-1' });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    expect((final!.result as any).parentResult).toBe('done');
    expect((final!.result as any).childResult).toBe('child processed: child-data');
  });

  it('nested flow results returned to parent', async () => {
    engine = await createTestEngine();

    engine.register('math-flow', async (ctx) => {
      const input = ctx.input as { a: number; b: number };
      return { sum: input.a + input.b };
    }, { maxRetries: 0 });

    engine.register('orchestrator-flow', async (ctx) => {
      const childExec = await engine.trigger('math-flow', {
        idempotencyKey: `math-${ctx.executionId}`,
        input: { a: 10, b: 20 },
      });

      let child = await engine.getExecution(childExec.id);
      const start = Date.now();
      while (child && child.state !== 'complete' && child.state !== 'failed' && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 10));
        child = await engine.getExecution(childExec.id);
      }

      return { childSum: (child?.result as any).sum, status: 'combined' };
    }, { maxRetries: 0 });

    const exec = await engine.trigger('orchestrator-flow', { idempotencyKey: 'orch-1' });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    expect(final!.result).toEqual({ childSum: 30, status: 'combined' });
  });

  it('child failure does not crash parent', async () => {
    engine = await createTestEngine();

    engine.register('failing-child', async () => {
      throw new Error('child broke');
    }, { maxRetries: 0 });

    engine.register('resilient-parent', async (ctx) => {
      const childExec = await engine.trigger('failing-child', {
        idempotencyKey: `fail-${ctx.executionId}`,
      });

      let child = await engine.getExecution(childExec.id);
      const start = Date.now();
      while (child && child.state !== 'complete' && child.state !== 'failed' && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 10));
        child = await engine.getExecution(childExec.id);
      }

      if (child?.state === 'failed') {
        return { status: 'child-failed', error: child.error?.message };
      }
      return { status: 'ok' };
    }, { maxRetries: 0 });

    const exec = await engine.trigger('resilient-parent', { idempotencyKey: 'rp-1' });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    expect((final!.result as any).status).toBe('child-failed');
    expect((final!.result as any).error).toContain('child broke');
  });

  it('fan-out: parent triggers multiple children concurrently', async () => {
    engine = await createTestEngine();

    engine.register('worker-flow', async (ctx) => {
      await new Promise((r) => setTimeout(r, 10));
      return `result-${ctx.input}`;
    }, { maxRetries: 0 });

    engine.register('fanout-parent', async (ctx) => {
      const children = await Promise.all([
        engine.trigger('worker-flow', { idempotencyKey: `w-1-${ctx.executionId}`, input: 'A' }),
        engine.trigger('worker-flow', { idempotencyKey: `w-2-${ctx.executionId}`, input: 'B' }),
        engine.trigger('worker-flow', { idempotencyKey: `w-3-${ctx.executionId}`, input: 'C' }),
      ]);

      // Wait for all children
      const results: unknown[] = [];
      for (const childExec of children) {
        let child = await engine.getExecution(childExec.id);
        const start = Date.now();
        while (child && child.state !== 'complete' && child.state !== 'failed' && Date.now() - start < 5000) {
          await new Promise((r) => setTimeout(r, 10));
          child = await engine.getExecution(childExec.id);
        }
        results.push(child?.result);
      }

      return results;
    }, { maxRetries: 0 });

    const exec = await engine.trigger('fanout-parent', { idempotencyKey: 'fo-1' });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    const results = final!.result as string[];
    expect(results).toContain('result-A');
    expect(results).toContain('result-B');
    expect(results).toContain('result-C');
  });

  it('concurrency slots consumed by nested flows', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 2,
    });

    const childStarted = new Promise<void>((resolve) => {
      engine.register('blocking-child', async () => {
        resolve();
        await new Promise((r) => setTimeout(r, 200));
        return 'blocked-done';
      }, { maxRetries: 0 });
    });

    engine.register('slot-parent', async (ctx) => {
      // This parent occupies slot 1, child occupies slot 2
      const childExec = await engine.trigger('blocking-child', {
        idempotencyKey: `sc-child-${ctx.executionId}`,
      });

      let child = await engine.getExecution(childExec.id);
      const start = Date.now();
      while (child && child.state !== 'complete' && child.state !== 'failed' && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 10));
        child = await engine.getExecution(childExec.id);
      }

      return 'parent-done';
    }, { maxRetries: 0 });

    // Trigger parent (slot 1) → triggers child (slot 2) → 3rd should be queued
    const parentExec = await engine.trigger('slot-parent', { idempotencyKey: 'sp-1' });

    // Give parent time to trigger child
    await childStarted;

    // Third trigger should be queued since concurrency=2
    engine.register('third-flow', async () => 'third-done', { maxRetries: 0 });
    const thirdExec = await engine.trigger('third-flow', { idempotencyKey: 'tf-1' });
    const thirdState = await engine.getExecution(thirdExec.id);
    expect(thirdState!.state).toBe('queued');

    // Wait for everything to finish
    await waitForCompletion(engine, parentExec.id);
    await waitForCompletion(engine, thirdExec.id);
  });

  it('cost accumulation across nested flows', async () => {
    const provider = createNamedProvider('nested-cost', 'response');
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.02 } }],
      },
      cost: {},
    });

    engine.register('cost-child', async (ctx) => {
      await ctx.model.complete({ prompt: 'child work' });
      return 'child-done';
    }, { maxRetries: 0 });

    engine.register('cost-parent', async (ctx) => {
      await ctx.model.complete({ prompt: 'parent work' });
      const childExec = await engine.trigger('cost-child', {
        idempotencyKey: `cc-${ctx.executionId}`,
      });

      let child = await engine.getExecution(childExec.id);
      const start = Date.now();
      while (child && child.state !== 'complete' && child.state !== 'failed' && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 10));
        child = await engine.getExecution(childExec.id);
      }

      return 'parent-done';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('cost-parent', { idempotencyKey: 'cp-1' });
    await waitForCompletion(engine, exec.id);

    const ledger = engine.getCostLedger()!;
    const allEntries = ledger.query({});
    expect(allEntries.length).toBe(2); // 1 parent + 1 child

    // Tracked as separate executions
    const parentEntries = ledger.query({ executionId: exec.id });
    expect(parentEntries.length).toBe(1);

    const childEntries = allEntries.filter((e: any) => e.executionId !== exec.id);
    expect(childEntries.length).toBe(1);
  });

  it('policy applies to nested triggers', async () => {
    engine = await createTestEngine({
      policy: {
        rules: [
          {
            name: 'deny-blocked-child',
            priority: 1,
            operations: ['trigger'],
            evaluate: (ctx) => {
              if (ctx.flowName === 'blocked-child') {
                return { action: 'deny', reason: 'child flow not allowed' };
              }
              return { action: 'allow', reason: null };
            },
          },
        ],
      },
    });

    engine.register('blocked-child', async () => 'should not run', { maxRetries: 0 });

    engine.register('policy-parent', async (ctx) => {
      try {
        await engine.trigger('blocked-child', {
          idempotencyKey: `bc-${ctx.executionId}`,
        });
        return 'child-triggered';
      } catch (err: any) {
        return { error: err.message };
      }
    }, { maxRetries: 0 });

    const exec = await engine.trigger('policy-parent', { idempotencyKey: 'pp-1' });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    expect((final!.result as any).error).toMatch(/denied|not allowed/i);
  });
});
