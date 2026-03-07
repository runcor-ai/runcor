// Integration tests for evaluation
// End-to-end evaluator execution, scoring, confidence, auto-flagging, hot-reload

import { describe, it, expect, vi } from 'vitest';
import { createEngine } from '../../src/engine.js';
import type { Evaluator, EvalContext } from '../../src/types.js';
import type { ModelProvider } from '../../src/model/provider.js';

function createMockProvider(): ModelProvider {
  return {
    name: 'mock',
    complete: vi.fn().mockResolvedValue({
      content: 'mock response',
      model: 'mock',
      provider: 'mock',
      usage: { promptTokens: 10, completionTokens: 10 },
    }),
  };
}

describe('Evaluation Integration', () => {
  // T009: End-to-end evaluator execution
  describe('T009: End-to-end evaluator execution', () => {
    it('should run evaluator after flow completion with correct context', async () => {
      let capturedContext: EvalContext | null = null;

      const engine = await createEngine({
        model: { provider: createMockProvider() },
      });

      engine.register('echo', async (ctx) => {
        return `echo: ${JSON.stringify(ctx.input)}`;
      });

      const evaluator: Evaluator = {
        name: 'capture-context',
        priority: 1,
        evaluate: async (ctx) => {
          capturedContext = ctx;
          return { scores: { relevance: 0.9 } };
        },
      };

      engine.addEvaluator(evaluator);

      const execution = await engine.trigger('echo', {
        idempotencyKey: 'test-1',
        input: { message: 'hello' },
        userId: 'user-1',
        tenantId: 'tenant-1',
        metadata: { source: 'test' },
      });

      // Wait for async evaluation to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.executionId).toBe(execution.id);
      expect(capturedContext!.flowName).toBe('echo');
      expect(capturedContext!.input).toEqual({ message: 'hello' });
      expect(capturedContext!.output).toBe('echo: {"message":"hello"}');
      expect(capturedContext!.userId).toBe('user-1');
      expect(capturedContext!.tenantId).toBe('tenant-1');
      expect(capturedContext!.state).toBe('complete');
      expect(capturedContext!.error).toBeNull();
      expect(capturedContext!.duration).toBeGreaterThanOrEqual(0);
      expect(capturedContext!.metadata).toEqual({ source: 'test' });
    });

    it('should not block flow result while evaluation runs', async () => {
      const engine = await createEngine({
        model: { provider: createMockProvider() },
      });

      engine.register('echo', async (ctx) => `echo: ${ctx.input}`);

      engine.addEvaluator({
        name: 'slow-eval',
        priority: 1,
        evaluate: async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return { scores: { relevance: 0.5 } };
        },
      });

      const startTime = Date.now();
      const execution = await engine.trigger('echo', {
        idempotencyKey: 'test-2',
        input: 'fast',
      });
      const duration = Date.now() - startTime;

      // Flow should return quickly (well under 500ms evaluator delay)
      expect(duration).toBeLessThan(200);
      expect(execution.state).not.toBe('queued'); // Should have dispatched
    });
  });

  // T017: Scoring integration
  describe('T017: Multi-evaluator scoring', () => {
    it('should aggregate scores from multiple evaluators and store EvalRecord', async () => {
      const engine = await createEngine({
        model: { provider: createMockProvider() },
      });

      engine.register('echo', async (ctx) => `echo: ${ctx.input}`);

      engine.addEvaluator({
        name: 'eval-a',
        priority: 1,
        evaluate: async () => ({
          scores: { relevance: 0.8, coherence: 0.6 },
        }),
      });
      engine.addEvaluator({
        name: 'eval-b',
        priority: 2,
        evaluate: async () => ({
          scores: { relevance: 0.6, accuracy: 0.9 },
        }),
      });

      const execution = await engine.trigger('echo', {
        idempotencyKey: 'score-test',
        input: 'test',
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const record = engine.getEvaluation(execution.id);
      expect(record).not.toBeNull();
      expect(record!.evaluatorResults).toHaveLength(2);

      // relevance: avg(0.8, 0.6) = 0.7
      expect(record!.aggregateScores.relevance).toBeCloseTo(0.7, 5);
      // coherence: 0.6 (only one evaluator)
      expect(record!.aggregateScores.coherence).toBeCloseTo(0.6, 5);
      // accuracy: 0.9 (only one evaluator)
      expect(record!.aggregateScores.accuracy).toBeCloseTo(0.9, 5);

      // overallScore: avg(0.7, 0.6, 0.9) ≈ 0.7333
      expect(record!.overallScore).toBeCloseTo(0.7333, 3);
    });
  });

  // T023: Confidence level integration
  describe('T023: Confidence levels', () => {
    it('should derive correct confidence level with default thresholds', async () => {
      const engine = await createEngine({
        model: { provider: createMockProvider() },
      });

      engine.register('echo', async (ctx) => `echo: ${ctx.input}`);

      engine.addEvaluator({
        name: 'high-scorer',
        priority: 1,
        evaluate: async () => ({ scores: { relevance: 0.95 } }),
      });

      const execution = await engine.trigger('echo', {
        idempotencyKey: 'confidence-test',
        input: 'test',
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const record = engine.getEvaluation(execution.id);
      expect(record).not.toBeNull();
      expect(record!.confidence).toBe('high'); // 0.95 >= 0.8
    });

    it('should derive medium confidence for mid-range scores', async () => {
      const engine = await createEngine({
        model: { provider: createMockProvider() },
      });

      engine.register('echo', async (ctx) => `echo: ${ctx.input}`);

      engine.addEvaluator({
        name: 'mid-scorer',
        priority: 1,
        evaluate: async () => ({ scores: { relevance: 0.6 } }),
      });

      const execution = await engine.trigger('echo', {
        idempotencyKey: 'confidence-mid',
        input: 'test',
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const record = engine.getEvaluation(execution.id);
      expect(record).not.toBeNull();
      expect(record!.confidence).toBe('medium'); // 0.6 >= 0.5
    });

    it('should derive low confidence for low scores', async () => {
      const engine = await createEngine({
        model: { provider: createMockProvider() },
      });

      engine.register('echo', async (ctx) => `echo: ${ctx.input}`);

      engine.addEvaluator({
        name: 'low-scorer',
        priority: 1,
        evaluate: async () => ({ scores: { relevance: 0.3 } }),
      });

      const execution = await engine.trigger('echo', {
        idempotencyKey: 'confidence-low',
        input: 'test',
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const record = engine.getEvaluation(execution.id);
      expect(record).not.toBeNull();
      expect(record!.confidence).toBe('low'); // 0.3 < 0.5
    });

    it('should use evaluator-specific custom thresholds for per-evaluator confidence', async () => {
      const engine = await createEngine({
        model: { provider: createMockProvider() },
      });

      engine.register('echo', async (ctx) => `echo: ${ctx.input}`);

      engine.addEvaluator({
        name: 'custom-thresh',
        priority: 1,
        thresholds: { high: 0.95, medium: 0.7 },
        evaluate: async () => ({ scores: { relevance: 0.85 } }),
      });

      const execution = await engine.trigger('echo', {
        idempotencyKey: 'custom-thresh-test',
        input: 'test',
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const record = engine.getEvaluation(execution.id);
      expect(record).not.toBeNull();
      // Per-evaluator: 0.85 is >= 0.7 (medium) but < 0.95 (high) → medium
      expect(record!.evaluatorResults[0].confidence).toBe('medium');
      // Overall: 0.85 uses default thresholds → 0.85 >= 0.8 → high
      expect(record!.confidence).toBe('high');
    });
  });

  // T027: Auto-flagging integration
  describe('T027: Auto-flagging', () => {
    it('should auto-flag when evaluator produces low score', async () => {
      const engine = await createEngine({
        model: { provider: createMockProvider() },
      });

      engine.register('echo', async (ctx) => `echo: ${ctx.input}`);

      engine.addEvaluator({
        name: 'low-quality',
        priority: 1,
        evaluate: async () => ({ scores: { relevance: 0.2 } }),
      });

      const execution = await engine.trigger('echo', {
        idempotencyKey: 'flag-test',
        input: 'test',
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const flags = engine.listFlags({ status: 'pending' });
      expect(flags.length).toBeGreaterThanOrEqual(1);
      const flag = flags.find((f) => f.executionId === execution.id);
      expect(flag).toBeDefined();
      expect(flag!.source).toBe('auto');
      expect(flag!.reason).toContain('low-quality');
    });
  });

  // T040: Hot-reload integration
  describe('T040: Hot-reload evaluators', () => {
    it('should run newly added evaluators on next execution', async () => {
      const engine = await createEngine({
        model: { provider: createMockProvider() },
      });

      engine.register('echo', async (ctx) => `echo: ${ctx.input}`);

      let evalRan = false;

      // First trigger — no evaluators
      await engine.trigger('echo', {
        idempotencyKey: 'hot-reload-1',
        input: 'first',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Add evaluator
      engine.addEvaluator({
        name: 'hot-added',
        priority: 1,
        evaluate: async () => {
          evalRan = true;
          return { scores: { relevance: 0.9 } };
        },
      });

      // Second trigger — evaluator should run
      await engine.trigger('echo', {
        idempotencyKey: 'hot-reload-2',
        input: 'second',
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(evalRan).toBe(true);
    });

    it('should not run removed evaluators', async () => {
      const engine = await createEngine({
        model: { provider: createMockProvider() },
      });

      engine.register('echo', async (ctx) => `echo: ${ctx.input}`);

      let evalRan = false;

      engine.addEvaluator({
        name: 'to-remove',
        priority: 1,
        evaluate: async () => {
          evalRan = true;
          return { scores: { relevance: 0.9 } };
        },
      });

      // Remove before triggering
      engine.removeEvaluator('to-remove');

      await engine.trigger('echo', {
        idempotencyKey: 'hot-reload-3',
        input: 'third',
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(evalRan).toBe(false);
    });
  });

  // Zero-evaluator fast path
  describe('Zero-evaluator behavior', () => {
    it('should produce no evaluation when no evaluators registered', async () => {
      const engine = await createEngine({
        model: { provider: createMockProvider() },
      });

      engine.register('echo', async (ctx) => `echo: ${ctx.input}`);

      const execution = await engine.trigger('echo', {
        idempotencyKey: 'zero-eval',
        input: 'test',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const record = engine.getEvaluation(execution.id);
      expect(record).toBeNull();
    });
  });
});
