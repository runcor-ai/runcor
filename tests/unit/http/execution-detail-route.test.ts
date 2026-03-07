// Unit tests for GET /v1/executions/:id/detail

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../../src/engine.js';
import { MockProvider } from '../../../src/model/mock.js';

describe('Execution Detail Route Logic', () => {
  let engine: Runcor;

  afterEach(async () => {
    if (engine) await engine.shutdown();
  });

  it('getExecution returns null for non-existent execution', async () => {
    engine = await createEngine({
      model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
    });
    const ex = await engine.getExecution('nonexistent');
    expect(ex).toBeNull();
  });

  it('getEvaluation returns null when no evaluators ran', async () => {
    engine = await createEngine({
      model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
    });
    const ev = engine.getEvaluation('any-id');
    expect(ev).toBeNull();
  });

  it('getCostLedger returns null when cost tracking disabled', async () => {
    engine = await createEngine({
      model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
    });
    expect(engine.getCostLedger()).toBeNull();
  });

  it('returns execution with cost and eval data after flow completes', async () => {
    const provider = new MockProvider();
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.001, output: 0.002 } }],
      },
      cost: {},
    });

    engine.register('detail-test', async (ctx) => {
      const result = await ctx.model.complete({ prompt: 'test' });
      return result.text;
    });

    const execution = await engine.trigger('detail-test', { idempotencyKey: 'detail-1' });

    // Wait for completion
    await new Promise<void>((resolve) => {
      engine.on('execution:complete', (e) => {
        if (e.executionId === execution.id) resolve();
      });
    });

    // Verify execution exists
    const ex = await engine.getExecution(execution.id);
    expect(ex).not.toBeNull();
    expect(ex!.state).toBe('complete');

    // Verify cost entries exist
    const ledger = engine.getCostLedger()!;
    const costEntries = ledger.query({ executionId: execution.id });
    expect(costEntries.length).toBeGreaterThanOrEqual(1);

    // Verify eval is null (no evaluators registered)
    const ev = engine.getEvaluation(execution.id);
    expect(ev).toBeNull();
  });
});
