// Integration test for concurrency isolation (SC-002)
import { describe, it, expect } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';

describe('Concurrency Isolation (SC-002)', () => {
  it('should run 100 concurrent executions with unique results and no state leakage', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 100,
    });

    engine.register('unique-result', async (ctx) => {
      return `result-${ctx.input}`;
    }, { maxRetries: 0, timeout: 0 });

    // Track completions
    let completed = 0;
    const allDone = new Promise<void>((resolve) => {
      engine.on('execution:complete', () => {
        completed++;
        if (completed >= 100) resolve();
      });
    });

    const executions = [];
    for (let i = 0; i < 100; i++) {
      const exec = await engine.trigger('unique-result', {
        idempotencyKey: `conc-${i}`,
        input: i,
      });
      executions.push(exec);
    }

    // Wait for all to complete
    await allDone;

    // Small delay for state to settle
    await new Promise((r) => setTimeout(r, 100));

    // Verify all 100 results are distinct and correct
    const results = new Set<string>();
    for (const exec of executions) {
      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');

      const result = final!.result as string;
      expect(result).toMatch(/^result-\d+$/);
      results.add(result);
    }

    // All 100 results must be distinct
    expect(results.size).toBe(100);

    await engine.shutdown();
  }, 30000);
});
