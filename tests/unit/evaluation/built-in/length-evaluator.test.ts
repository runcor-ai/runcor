// Unit tests for length evaluator
import { describe, it, expect } from 'vitest';
import { createLengthEvaluator } from '../../../../src/evaluation/built-in/length-evaluator.js';
import type { EvalContext } from '../../../../src/types.js';

function ctx(output: unknown): EvalContext {
  return {
    executionId: 'e1',
    flowName: 'test',
    input: 'test',
    output,
    userId: null,
    tenantId: null,
    duration: 100,
    state: 'complete',
    error: null,
    metadata: {},
  };
}

describe('createLengthEvaluator', () => {
  it('should score 1.0 when output is within bounds', async () => {
    const evaluator = createLengthEvaluator({
      name: 'length-check',
      minLength: 5,
      maxLength: 100,
    });
    const result = await evaluator.evaluate(ctx('Hello, this is a test response'));
    expect(result.scores.relevance).toBe(1.0);
  });

  it('should degrade score for too-short output', async () => {
    const evaluator = createLengthEvaluator({
      name: 'length-check',
      minLength: 20,
      maxLength: 100,
    });
    const result = await evaluator.evaluate(ctx('Hi')); // length 2, min 20
    expect(result.scores.relevance).toBeLessThan(1.0);
    expect(result.scores.relevance).toBeGreaterThanOrEqual(0);
  });

  it('should degrade score for too-long output', async () => {
    const evaluator = createLengthEvaluator({
      name: 'length-check',
      minLength: 5,
      maxLength: 10,
    });
    const result = await evaluator.evaluate(ctx('This is way too long for the limit'));
    expect(result.scores.relevance).toBeLessThan(1.0);
    expect(result.scores.relevance).toBeGreaterThanOrEqual(0);
  });

  it('should score 0.0 for empty output when minLength > 0', async () => {
    const evaluator = createLengthEvaluator({
      name: 'length-check',
      minLength: 10,
      maxLength: 100,
    });
    const result = await evaluator.evaluate(ctx(''));
    expect(result.scores.relevance).toBe(0.0);
  });

  it('should score 0.0 for non-string output', async () => {
    const evaluator = createLengthEvaluator({
      name: 'length-check',
      minLength: 5,
      maxLength: 100,
    });
    const result = await evaluator.evaluate(ctx(42));
    expect(result.scores.relevance).toBe(0.0);
  });

  it('should use default priority of 10', () => {
    const evaluator = createLengthEvaluator({ name: 'len' });
    expect(evaluator.priority).toBe(10);
  });

  it('should accept custom priority', () => {
    const evaluator = createLengthEvaluator({ name: 'len', priority: 5 });
    expect(evaluator.priority).toBe(5);
  });

  it('should score 1.0 when no bounds specified', async () => {
    const evaluator = createLengthEvaluator({ name: 'len' });
    const result = await evaluator.evaluate(ctx('any text'));
    expect(result.scores.relevance).toBe(1.0);
  });
});
