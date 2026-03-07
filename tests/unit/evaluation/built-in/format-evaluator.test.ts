// Unit tests for format evaluator
import { describe, it, expect } from 'vitest';
import { createFormatEvaluator } from '../../../../src/evaluation/built-in/format-evaluator.js';
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

describe('createFormatEvaluator', () => {
  it('should score 1.0 for matching string format', async () => {
    const evaluator = createFormatEvaluator({
      name: 'format-check',
      expectedFormat: 'string',
    });
    const result = await evaluator.evaluate(ctx('hello'));
    expect(result.scores.accuracy).toBe(1.0);
  });

  it('should score 0.0 for non-matching string format', async () => {
    const evaluator = createFormatEvaluator({
      name: 'format-check',
      expectedFormat: 'string',
    });
    const result = await evaluator.evaluate(ctx(42));
    expect(result.scores.accuracy).toBe(0.0);
  });

  it('should score 1.0 for matching json-object format', async () => {
    const evaluator = createFormatEvaluator({
      name: 'format-check',
      expectedFormat: 'json-object',
    });
    const result = await evaluator.evaluate(ctx({ key: 'value' }));
    expect(result.scores.accuracy).toBe(1.0);
  });

  it('should score 0.0 for array when expecting json-object', async () => {
    const evaluator = createFormatEvaluator({
      name: 'format-check',
      expectedFormat: 'json-object',
    });
    const result = await evaluator.evaluate(ctx([1, 2, 3]));
    expect(result.scores.accuracy).toBe(0.0);
  });

  it('should score 1.0 for matching array format', async () => {
    const evaluator = createFormatEvaluator({
      name: 'format-check',
      expectedFormat: 'array',
    });
    const result = await evaluator.evaluate(ctx([1, 2, 3]));
    expect(result.scores.accuracy).toBe(1.0);
  });

  it('should score 0.0 for object when expecting array', async () => {
    const evaluator = createFormatEvaluator({
      name: 'format-check',
      expectedFormat: 'array',
    });
    const result = await evaluator.evaluate(ctx({ key: 'value' }));
    expect(result.scores.accuracy).toBe(0.0);
  });

  it('should score 0.0 for null output', async () => {
    const evaluator = createFormatEvaluator({
      name: 'format-check',
      expectedFormat: 'string',
    });
    const result = await evaluator.evaluate(ctx(null));
    expect(result.scores.accuracy).toBe(0.0);
  });

  it('should score 0.0 for undefined output', async () => {
    const evaluator = createFormatEvaluator({
      name: 'format-check',
      expectedFormat: 'string',
    });
    const result = await evaluator.evaluate(ctx(undefined));
    expect(result.scores.accuracy).toBe(0.0);
  });
});
