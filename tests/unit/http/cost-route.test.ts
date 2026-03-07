// Unit tests for GET /v1/cost/summary

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../../src/engine.js';
import { MockProvider } from '../../../src/model/mock.js';

describe('Cost Summary Route Logic', () => {
  let engine: Runcor;

  afterEach(async () => {
    if (engine) await engine.shutdown();
  });

  it('returns zeroed summary when cost tracking disabled', async () => {
    engine = await createEngine({
      model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
    });
    const ledger = engine.getCostLedger();
    expect(ledger).toBeNull();
  });

  it('returns empty arrays when cost tracking enabled but no entries', async () => {
    engine = await createEngine({
      model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
      cost: {},
    });
    const ledger = engine.getCostLedger();
    expect(ledger).not.toBeNull();
    const entries = ledger!.query({});
    expect(entries).toEqual([]);
    expect(ledger!.getTotal({})).toBe(0);
  });

  it('cost ledger records entries after model calls', async () => {
    const provider = new MockProvider();
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.001, output: 0.002 } }],
      },
      cost: {},
    });

    engine.register('test-flow', async (ctx) => {
      const result = await ctx.model.complete({ prompt: 'hello' });
      return result.text;
    });

    await engine.trigger('test-flow', { idempotencyKey: 'cost-test-1' });

    // Wait for execution to complete
    await new Promise<void>((resolve) => {
      engine.on('execution:complete', () => resolve());
    });

    const ledger = engine.getCostLedger()!;
    const entries = ledger.query({});
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].flowName).toBe('test-flow');
    expect(entries[0].provider).toBeDefined();
  });
});
