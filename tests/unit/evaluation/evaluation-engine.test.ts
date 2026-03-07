// Unit tests for EvaluationEngine evaluator management
// Tests: addEvaluator, removeEvaluator, DUPLICATE_EVALUATOR, INVALID_EVALUATOR_CONFIG

import { describe, it, expect } from 'vitest';
import { EvaluationEngine } from '../../../src/evaluation/evaluation-engine.js';
import type { Evaluator, EvaluationConfig } from '../../../src/types.js';
import { EngineInstrumentation } from '../../../src/telemetry/instrumentation.js';

function createInstrumentation(): EngineInstrumentation {
  return new EngineInstrumentation({});
}

const noopEmit = () => {};

function createTestEvaluator(overrides: Partial<Evaluator> = {}): Evaluator {
  return {
    name: 'test-evaluator',
    priority: 1,
    evaluate: async () => ({ scores: { relevance: 0.9 } }),
    ...overrides,
  };
}

describe('EvaluationEngine', () => {
  describe('constructor', () => {
    it('should initialize with no evaluators by default', () => {
      const engine = new EvaluationEngine(undefined, createInstrumentation(), noopEmit);
      expect(engine.hasEvaluators()).toBe(false);
    });

    it('should initialize evaluators from config', () => {
      const config: EvaluationConfig = {
        evaluators: [
          createTestEvaluator({ name: 'eval-1' }),
          createTestEvaluator({ name: 'eval-2' }),
        ],
      };
      const engine = new EvaluationEngine(config, createInstrumentation(), noopEmit);
      expect(engine.hasEvaluators()).toBe(true);
      expect(engine.getEvaluators().size).toBe(2);
    });
  });

  describe('addEvaluator', () => {
    it('should store an evaluator', () => {
      const engine = new EvaluationEngine(undefined, createInstrumentation(), noopEmit);
      const evaluator = createTestEvaluator({ name: 'my-eval' });

      engine.addEvaluator(evaluator);

      expect(engine.hasEvaluators()).toBe(true);
      expect(engine.getEvaluators().has('my-eval')).toBe(true);
    });

    it('should throw DUPLICATE_EVALUATOR on duplicate name', () => {
      const engine = new EvaluationEngine(undefined, createInstrumentation(), noopEmit);
      engine.addEvaluator(createTestEvaluator({ name: 'dup' }));

      expect(() => engine.addEvaluator(createTestEvaluator({ name: 'dup' }))).toThrow(
        /already exists/,
      );
      try {
        engine.addEvaluator(createTestEvaluator({ name: 'dup' }));
      } catch (err: any) {
        expect(err.code).toBe('DUPLICATE_EVALUATOR');
      }
    });

    it('should throw INVALID_EVALUATOR_CONFIG for priority <= 0', () => {
      const engine = new EvaluationEngine(undefined, createInstrumentation(), noopEmit);

      expect(() =>
        engine.addEvaluator(createTestEvaluator({ name: 'bad', priority: 0 })),
      ).toThrow(/priority > 0/);

      expect(() =>
        engine.addEvaluator(createTestEvaluator({ name: 'bad2', priority: -1 })),
      ).toThrow(/priority > 0/);

      try {
        engine.addEvaluator(createTestEvaluator({ name: 'bad3', priority: 0 }));
      } catch (err: any) {
        expect(err.code).toBe('INVALID_EVALUATOR_CONFIG');
      }
    });

    it('should throw INVALID_EVALUATOR_CONFIG for timeoutMs <= 0', () => {
      const engine = new EvaluationEngine(undefined, createInstrumentation(), noopEmit);

      expect(() =>
        engine.addEvaluator(createTestEvaluator({ name: 'bad', timeoutMs: 0 })),
      ).toThrow(/timeoutMs > 0/);

      expect(() =>
        engine.addEvaluator(createTestEvaluator({ name: 'bad2', timeoutMs: -100 })),
      ).toThrow(/timeoutMs > 0/);
    });

    it('should throw INVALID_EVALUATOR_CONFIG when thresholds.high <= thresholds.medium', () => {
      const engine = new EvaluationEngine(undefined, createInstrumentation(), noopEmit);

      expect(() =>
        engine.addEvaluator(
          createTestEvaluator({
            name: 'bad',
            thresholds: { high: 0.5, medium: 0.5 },
          }),
        ),
      ).toThrow(/thresholds.high > thresholds.medium/);

      expect(() =>
        engine.addEvaluator(
          createTestEvaluator({
            name: 'bad2',
            thresholds: { high: 0.3, medium: 0.5 },
          }),
        ),
      ).toThrow(/thresholds.high > thresholds.medium/);
    });

    it('should accept valid thresholds', () => {
      const engine = new EvaluationEngine(undefined, createInstrumentation(), noopEmit);

      engine.addEvaluator(
        createTestEvaluator({
          name: 'good',
          thresholds: { high: 0.9, medium: 0.6 },
        }),
      );

      expect(engine.getEvaluators().has('good')).toBe(true);
    });
  });

  describe('removeEvaluator', () => {
    it('should remove an evaluator by name', () => {
      const engine = new EvaluationEngine(undefined, createInstrumentation(), noopEmit);
      engine.addEvaluator(createTestEvaluator({ name: 'remove-me' }));

      expect(engine.hasEvaluators()).toBe(true);
      engine.removeEvaluator('remove-me');
      expect(engine.hasEvaluators()).toBe(false);
    });

    it('should no-op when removing non-existent evaluator', () => {
      const engine = new EvaluationEngine(undefined, createInstrumentation(), noopEmit);
      // Should not throw
      engine.removeEvaluator('does-not-exist');
      expect(engine.hasEvaluators()).toBe(false);
    });
  });

  describe('hasEvaluators', () => {
    it('should return false when no evaluators registered', () => {
      const engine = new EvaluationEngine(undefined, createInstrumentation(), noopEmit);
      expect(engine.hasEvaluators()).toBe(false);
    });

    it('should return true when evaluators are registered', () => {
      const engine = new EvaluationEngine(undefined, createInstrumentation(), noopEmit);
      engine.addEvaluator(createTestEvaluator());
      expect(engine.hasEvaluators()).toBe(true);
    });

    it('should return false after all evaluators are removed', () => {
      const engine = new EvaluationEngine(undefined, createInstrumentation(), noopEmit);
      engine.addEvaluator(createTestEvaluator({ name: 'a' }));
      engine.addEvaluator(createTestEvaluator({ name: 'b' }));
      engine.removeEvaluator('a');
      engine.removeEvaluator('b');
      expect(engine.hasEvaluators()).toBe(false);
    });
  });
});
