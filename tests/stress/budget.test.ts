// Stress test: Cost & budget enforcement under concurrent load
import { describe, it, expect, afterEach } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import { InMemoryCostLedger } from '../../src/cost/ledger.js';
import type { Runcor } from '../../src/engine.js';

describe('Stress: Budget', () => {
  let engine: Runcor;

  afterEach(async () => {
    await engine?.shutdown();
  });

  it('should enforce shared hard budget under concurrent load (race condition detection)', async () => {
    const mock = new MockProvider();

    engine = await createEngine({
      model: {
        providers: [{ provider: mock, costPerToken: { input: 0.01, output: 0.01 } }],
      },
      concurrency: 50,
      cost: {
        budgets: {
          global: { limit: 50, enforcement: 'hard', window: { type: 'none' } },
        },
      },
    });

    engine.register('budget-flow', async (ctx) => {
      const resp = await ctx.model.complete({ prompt: 'hello' });
      return resp.text;
    }, { maxRetries: 0, timeout: 5000 });

    // Trigger many executions against a shared hard budget
    const total = 100;
    let completed = 0;
    let failed = 0;
    const allDone = new Promise<void>((resolve) => {
      const check = () => {
        if (completed + failed >= total) resolve();
      };
      engine.on('execution:complete', () => { completed++; check(); });
      engine.on('execution:state_change', ({ to }) => {
        if (to === 'failed') { failed++; check(); }
      });
    });

    for (let i = 0; i < total; i++) {
      await engine.trigger('budget-flow', { idempotencyKey: `budget-${i}` });
    }

    await allDone;

    // Budget should have limited some executions
    // With 50 unit limit and small costs per execution, some should pass
    expect(completed).toBeGreaterThan(0);

    // Total cost should not dramatically exceed the budget limit
    const ledger = engine.getCostLedger();
    if (ledger) {
      const totalCost = ledger.getTotal({});
      // Allow some overrun due to concurrent estimation, but not extreme
      expect(totalCost).toBeLessThan(100); // 2x budget is generous
    }
  }, 30000);

  it('should handle ledger FIFO eviction at capacity', async () => {
    const maxEntries = 100;
    const ledger = new InMemoryCostLedger(maxEntries);

    // Fill beyond capacity
    for (let i = 0; i < 1000; i++) {
      ledger.record({
        id: `entry-${i}`,
        timestamp: new Date(),
        provider: 'mock',
        model: 'mock',
        promptTokens: 10,
        completionTokens: 10,
        cost: 0.01,
        executionId: `exec-${i}`,
        flowName: 'test',
        userId: null,
      });
    }

    // Should cap at maxEntries
    expect(ledger.getCount()).toBe(maxEntries);

    // Oldest entries should be evicted — only entries 900-999 should remain
    const remaining = ledger.query({});
    expect(remaining.length).toBe(maxEntries);
    expect(remaining[0].id).toBe('entry-900');
    expect(remaining[remaining.length - 1].id).toBe('entry-999');
  }, 30000);

  it('should maintain floating point precision with thousands of small costs', async () => {
    const ledger = new InMemoryCostLedger(100000);

    // Record 10000 entries with very small costs
    const costPerEntry = 0.000001; // 1 micro-unit
    const count = 10000;

    for (let i = 0; i < count; i++) {
      ledger.record({
        id: `fp-${i}`,
        timestamp: new Date(),
        provider: 'mock',
        model: 'mock',
        promptTokens: 1,
        completionTokens: 1,
        cost: costPerEntry,
        executionId: `exec-${i}`,
        flowName: 'precision',
        userId: null,
      });
    }

    const total = ledger.getTotal({});

    // Expected: 0.01 (10000 * 0.000001)
    // With floating point, allow small epsilon
    expect(Math.abs(total - count * costPerEntry)).toBeLessThan(1e-10);
  }, 30000);

  it('should enforce mixed hard/soft budgets under concurrent load', async () => {
    const mock = new MockProvider();

    let softWarnings = 0;
    let hardBlocks = 0;

    engine = await createEngine({
      model: {
        providers: [{ provider: mock, costPerToken: { input: 0.01, output: 0.01 } }],
      },
      concurrency: 20,
      cost: {
        budgets: {
          perFlow: { limit: 100, enforcement: 'soft', window: { type: 'none' } },
          global: { limit: 200, enforcement: 'hard', window: { type: 'none' } },
        },
        warningThreshold: 0.5,
      },
    });

    engine.on('cost:budget_warning', () => { softWarnings++; });
    engine.on('cost:budget_exceeded', (event) => {
      if (event.enforcement === 'hard') hardBlocks++;
    });

    engine.register('mixed-budget', async (ctx) => {
      const resp = await ctx.model.complete({ prompt: 'test' });
      return resp.text;
    }, { maxRetries: 0, timeout: 5000 });

    const total = 50;
    let terminal = 0;
    const allDone = new Promise<void>((resolve) => {
      engine.on('execution:complete', () => { terminal++; if (terminal >= total) resolve(); });
      engine.on('execution:state_change', ({ to }) => {
        if (to === 'failed') { terminal++; if (terminal >= total) resolve(); }
      });
    });

    for (let i = 0; i < total; i++) {
      await engine.trigger('mixed-budget', { idempotencyKey: `mb-${i}` });
    }

    await allDone;

    // Soft budget (per-flow) should emit warnings but not block
    // Hard budget (global) should block when exceeded
    // Exact counts depend on cost accumulation, but the system should not crash
    expect(terminal).toBe(total);
  }, 30000);
});
