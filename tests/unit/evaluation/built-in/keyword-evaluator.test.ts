// Unit tests for keyword evaluator
import { describe, it, expect } from 'vitest';
import { createKeywordEvaluator } from '../../../../src/evaluation/built-in/keyword-evaluator.js';
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

describe('createKeywordEvaluator', () => {
  it('should score 1.0 when all required keywords are present', async () => {
    const evaluator = createKeywordEvaluator({
      name: 'kw-check',
      required: ['hello', 'world'],
    });
    const result = await evaluator.evaluate(ctx('hello, world!'));
    expect(result.scores.safety).toBe(1.0);
  });

  it('should degrade score proportionally for missing required keywords', async () => {
    const evaluator = createKeywordEvaluator({
      name: 'kw-check',
      required: ['hello', 'world', 'foo', 'bar'],
    });
    // Only 'hello' and 'world' present — 2/4 = 0.5
    const result = await evaluator.evaluate(ctx('hello world'));
    expect(result.scores.safety).toBeCloseTo(0.5, 5);
  });

  it('should degrade score when forbidden keywords are present', async () => {
    const evaluator = createKeywordEvaluator({
      name: 'kw-check',
      forbidden: ['bad', 'wrong'],
    });
    const result = await evaluator.evaluate(ctx('this is bad and wrong'));
    expect(result.scores.safety).toBe(0.0);
  });

  it('should score 1.0 when no forbidden keywords are present', async () => {
    const evaluator = createKeywordEvaluator({
      name: 'kw-check',
      forbidden: ['bad', 'wrong'],
    });
    const result = await evaluator.evaluate(ctx('this is good'));
    expect(result.scores.safety).toBe(1.0);
  });

  it('should match case-insensitively by default', async () => {
    const evaluator = createKeywordEvaluator({
      name: 'kw-check',
      required: ['hello'],
    });
    const result = await evaluator.evaluate(ctx('HELLO World'));
    expect(result.scores.safety).toBe(1.0);
  });

  it('should match case-sensitively when configured', async () => {
    const evaluator = createKeywordEvaluator({
      name: 'kw-check',
      required: ['hello'],
      caseSensitive: true,
    });
    const result = await evaluator.evaluate(ctx('HELLO World'));
    expect(result.scores.safety).toBe(0.0); // 'hello' not found case-sensitively
  });

  it('should score 0.0 for non-string output', async () => {
    const evaluator = createKeywordEvaluator({
      name: 'kw-check',
      required: ['hello'],
    });
    const result = await evaluator.evaluate(ctx(42));
    expect(result.scores.safety).toBe(0.0);
  });

  it('should combine required and forbidden scoring', async () => {
    const evaluator = createKeywordEvaluator({
      name: 'kw-check',
      required: ['good', 'great'],
      forbidden: ['bad'],
    });
    // All required present, no forbidden
    const result = await evaluator.evaluate(ctx('this is good and great'));
    expect(result.scores.safety).toBe(1.0);
  });

  it('should score 1.0 when no keywords specified', async () => {
    const evaluator = createKeywordEvaluator({ name: 'kw' });
    const result = await evaluator.evaluate(ctx('anything'));
    expect(result.scores.safety).toBe(1.0);
  });
});
