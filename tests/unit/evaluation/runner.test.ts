// Unit tests for evaluator runner
// Tests: single evaluator execution, EvalContext fields, timeout, error isolation, parallel execution

import { describe, it, expect, vi } from 'vitest';
import { runEvaluators } from '../../../src/evaluation/runner.js';
import type { Evaluator, EvalContext } from '../../../src/types.js';

function createTestContext(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    executionId: 'exec-1',
    flowName: 'test-flow',
    input: { prompt: 'hello' },
    output: 'world',
    userId: 'user-1',
    tenantId: 'tenant-1',
    duration: 150,
    state: 'complete',
    error: null,
    metadata: { key: 'value' },
    ...overrides,
  };
}

function createTestEvaluator(overrides: Partial<Evaluator> = {}): Evaluator {
  return {
    name: 'test-evaluator',
    priority: 1,
    evaluate: async () => ({ scores: { relevance: 0.9 } }),
    ...overrides,
  };
}

describe('runEvaluators', () => {
  it('should run a single evaluator and return its result', async () => {
    const evaluator = createTestEvaluator({
      evaluate: async () => ({
        scores: { relevance: 0.85, coherence: 0.9 },
        labels: ['good'],
        feedback: 'Looks great',
      }),
    });
    const ctx = createTestContext();

    const { results, errors } = await runEvaluators([evaluator], ctx, 30000);

    expect(results).toHaveLength(1);
    expect(results[0].evaluatorName).toBe('test-evaluator');
    expect(results[0].scores).toEqual({ relevance: 0.85, coherence: 0.9 });
    expect(results[0].labels).toEqual(['good']);
    expect(results[0].feedback).toBe('Looks great');
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(errors).toHaveLength(0);
  });

  it('should pass correct EvalContext fields to evaluator', async () => {
    const receivedContext = vi.fn();
    const evaluator = createTestEvaluator({
      evaluate: async (ctx) => {
        receivedContext(ctx);
        return { scores: { accuracy: 1.0 } };
      },
    });

    const ctx = createTestContext({
      executionId: 'exec-42',
      flowName: 'my-flow',
      input: { data: 'test-input' },
      output: 'test-output',
      userId: 'user-abc',
      tenantId: 'tenant-xyz',
      duration: 250,
      state: 'complete',
      error: null,
      metadata: { foo: 'bar' },
    });

    await runEvaluators([evaluator], ctx, 30000);

    expect(receivedContext).toHaveBeenCalledWith(ctx);
    const passedCtx = receivedContext.mock.calls[0][0] as EvalContext;
    expect(passedCtx.executionId).toBe('exec-42');
    expect(passedCtx.flowName).toBe('my-flow');
    expect(passedCtx.input).toEqual({ data: 'test-input' });
    expect(passedCtx.output).toBe('test-output');
    expect(passedCtx.userId).toBe('user-abc');
    expect(passedCtx.tenantId).toBe('tenant-xyz');
    expect(passedCtx.duration).toBe(250);
    expect(passedCtx.state).toBe('complete');
    expect(passedCtx.error).toBeNull();
    expect(passedCtx.metadata).toEqual({ foo: 'bar' });
  });

  it('should timeout an evaluator with Promise.race', async () => {
    const evaluator = createTestEvaluator({
      name: 'slow-evaluator',
      evaluate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { scores: { relevance: 1.0 } };
      },
      timeoutMs: 50, // Short timeout
    });
    const ctx = createTestContext();

    const { results, errors } = await runEvaluators([evaluator], ctx, 30000);

    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].evaluatorName).toBe('slow-evaluator');
    expect(errors[0].timedOut).toBe(true);
    expect(errors[0].error).toContain('timed out');
  });

  it('should use default timeout when evaluator has no timeoutMs', async () => {
    const evaluator = createTestEvaluator({
      name: 'slow-evaluator',
      evaluate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { scores: { relevance: 1.0 } };
      },
      // No timeoutMs — uses defaultTimeout
    });
    const ctx = createTestContext();

    const { results, errors } = await runEvaluators([evaluator], ctx, 50); // Short default

    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].timedOut).toBe(true);
  });

  it('should isolate evaluator errors (error captured, does not propagate)', async () => {
    const failEval = createTestEvaluator({
      name: 'fail-evaluator',
      evaluate: async () => {
        throw new Error('Evaluator exploded');
      },
    });
    const successEval = createTestEvaluator({
      name: 'success-evaluator',
      evaluate: async () => ({
        scores: { relevance: 0.8 },
      }),
    });
    const ctx = createTestContext();

    const { results, errors } = await runEvaluators(
      [failEval, successEval],
      ctx,
      30000,
    );

    // Error is captured, not thrown
    expect(errors).toHaveLength(1);
    expect(errors[0].evaluatorName).toBe('fail-evaluator');
    expect(errors[0].error).toBe('Evaluator exploded');
    expect(errors[0].timedOut).toBe(false);

    // Other evaluator still succeeds
    expect(results).toHaveLength(1);
    expect(results[0].evaluatorName).toBe('success-evaluator');
  });

  it('should run multiple evaluators via Promise.allSettled', async () => {
    const callOrder: string[] = [];
    const eval1 = createTestEvaluator({
      name: 'eval-1',
      evaluate: async () => {
        callOrder.push('eval-1-start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        callOrder.push('eval-1-end');
        return { scores: { relevance: 0.7 } };
      },
    });
    const eval2 = createTestEvaluator({
      name: 'eval-2',
      evaluate: async () => {
        callOrder.push('eval-2-start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        callOrder.push('eval-2-end');
        return { scores: { accuracy: 0.9 } };
      },
    });
    const ctx = createTestContext();

    const { results, errors } = await runEvaluators([eval1, eval2], ctx, 30000);

    expect(results).toHaveLength(2);
    expect(errors).toHaveLength(0);

    // Both started before either ended (parallel execution)
    expect(callOrder[0]).toBe('eval-1-start');
    expect(callOrder[1]).toBe('eval-2-start');
  });

  it('should handle sync evaluators', async () => {
    const evaluator = createTestEvaluator({
      evaluate: () => ({ scores: { accuracy: 1.0 } }) as any,
    });
    const ctx = createTestContext();

    const { results, errors } = await runEvaluators([evaluator], ctx, 30000);

    expect(results).toHaveLength(1);
    expect(results[0].scores).toEqual({ accuracy: 1.0 });
    expect(errors).toHaveLength(0);
  });

  it('should handle evaluator with no labels or feedback', async () => {
    const evaluator = createTestEvaluator({
      evaluate: async () => ({ scores: { relevance: 0.5 } }),
    });
    const ctx = createTestContext();

    const { results } = await runEvaluators([evaluator], ctx, 30000);

    expect(results[0].labels).toEqual([]);
    expect(results[0].feedback).toBeNull();
  });

  it('should handle empty evaluators array', async () => {
    const ctx = createTestContext();
    const { results, errors } = await runEvaluators([], ctx, 30000);

    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});
