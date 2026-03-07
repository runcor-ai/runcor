// Unit tests for scorer — aggregation, confidence derivation, performance

import { describe, it, expect } from 'vitest';
import { aggregateScores, deriveConfidence } from '../../../src/evaluation/scorer.js';
import type { EvaluatorResultEntry } from '../../../src/types.js';

function createResult(overrides: Partial<EvaluatorResultEntry> = {}): EvaluatorResultEntry {
  return {
    evaluatorName: 'test',
    scores: { relevance: 0.8 },
    labels: [],
    feedback: null,
    confidence: 'high',
    durationMs: 5,
    ...overrides,
  };
}

describe('aggregateScores', () => {
  it('should validate scores by clamping to 0.0-1.0', () => {
    const results = [
      createResult({ scores: { relevance: 1.5, accuracy: -0.3 } }),
    ];

    const agg = aggregateScores(results);
    expect(agg.relevance).toBe(1.0);
    expect(agg.accuracy).toBe(0.0);
  });

  it('should aggregate by averaging across evaluators for same dimension', () => {
    const results = [
      createResult({ evaluatorName: 'a', scores: { relevance: 0.8 } }),
      createResult({ evaluatorName: 'b', scores: { relevance: 0.6 } }),
    ];

    const agg = aggregateScores(results);
    expect(agg.relevance).toBeCloseTo(0.7, 5);
  });

  it('should compute overall score as mean of dimension averages', () => {
    const results = [
      createResult({ scores: { relevance: 0.8, coherence: 0.6 } }),
      createResult({ scores: { relevance: 0.6, accuracy: 0.9 } }),
    ];

    const agg = aggregateScores(results);
    // relevance: avg(0.8, 0.6) = 0.7
    // coherence: 0.6
    // accuracy: 0.9
    expect(agg.relevance).toBeCloseTo(0.7, 5);
    expect(agg.coherence).toBeCloseTo(0.6, 5);
    expect(agg.accuracy).toBeCloseTo(0.9, 5);

    // overall = avg(0.7, 0.6, 0.9) = 0.7333...
    const dims = Object.values(agg);
    const overall = dims.reduce((s, v) => s + v, 0) / dims.length;
    expect(overall).toBeCloseTo(0.7333, 3);
  });

  it('should handle empty scores object as valid', () => {
    const results = [createResult({ scores: {} })];
    const agg = aggregateScores(results);
    expect(Object.keys(agg)).toHaveLength(0);
  });

  it('should pass through single evaluator scores as aggregate', () => {
    const results = [
      createResult({ scores: { relevance: 0.85, safety: 0.95 } }),
    ];

    const agg = aggregateScores(results);
    expect(agg.relevance).toBeCloseTo(0.85, 5);
    expect(agg.safety).toBeCloseTo(0.95, 5);
  });

  it('should recognize five built-in dimension names', () => {
    const builtInDims = ['relevance', 'coherence', 'accuracy', 'helpfulness', 'safety'];
    const scores: Record<string, number> = {};
    for (const dim of builtInDims) {
      scores[dim] = 0.8;
    }

    const results = [createResult({ scores })];
    const agg = aggregateScores(results);

    for (const dim of builtInDims) {
      expect(agg[dim]).toBeDefined();
      expect(agg[dim]).toBeCloseTo(0.8, 5);
    }
  });

  it('should accept and aggregate custom dimension names', () => {
    const results = [
      createResult({ evaluatorName: 'a', scores: { 'custom-tone': 0.7 } }),
      createResult({ evaluatorName: 'b', scores: { 'custom-tone': 0.9 } }),
    ];

    const agg = aggregateScores(results);
    expect(agg['custom-tone']).toBeCloseTo(0.8, 5);
  });

  it('should return empty object for empty results array', () => {
    const agg = aggregateScores([]);
    expect(Object.keys(agg)).toHaveLength(0);
  });
});

describe('deriveConfidence', () => {
  it('should derive high confidence with default thresholds (>= 0.8)', () => {
    expect(deriveConfidence(0.8, null)).toBe('high');
    expect(deriveConfidence(0.9, null)).toBe('high');
    expect(deriveConfidence(1.0, null)).toBe('high');
  });

  it('should derive medium confidence with default thresholds (>= 0.5)', () => {
    expect(deriveConfidence(0.5, null)).toBe('medium');
    expect(deriveConfidence(0.6, null)).toBe('medium');
    expect(deriveConfidence(0.79, null)).toBe('medium');
  });

  it('should derive low confidence with default thresholds (< 0.5)', () => {
    expect(deriveConfidence(0.0, null)).toBe('low');
    expect(deriveConfidence(0.3, null)).toBe('low');
    expect(deriveConfidence(0.49, null)).toBe('low');
  });

  it('should use custom thresholds when provided', () => {
    const custom = { high: 0.95, medium: 0.7 };
    expect(deriveConfidence(0.95, custom)).toBe('high');
    expect(deriveConfidence(0.85, custom)).toBe('medium');
    expect(deriveConfidence(0.5, custom)).toBe('low');
  });

  it('should handle boundary values exactly', () => {
    expect(deriveConfidence(0.8, null)).toBe('high');  // exactly high threshold
    expect(deriveConfidence(0.5, null)).toBe('medium'); // exactly medium threshold
  });

  it('should derive confidence from 0.0 as low', () => {
    expect(deriveConfidence(0.0, null)).toBe('low');
  });

  it('should derive confidence from 1.0 as high', () => {
    expect(deriveConfidence(1.0, null)).toBe('high');
  });
});

// Performance benchmark
describe('Performance', () => {
  it('should complete built-in evaluator scoring in <10ms p95 over 1000 evaluations (SC-001)', () => {
    const durations: number[] = [];

    for (let i = 0; i < 1000; i++) {
      const results = [
        createResult({ scores: { relevance: Math.random(), coherence: Math.random(), accuracy: Math.random() } }),
        createResult({ evaluatorName: 'b', scores: { relevance: Math.random(), safety: Math.random() } }),
      ];

      const start = performance.now();
      const agg = aggregateScores(results);
      const dims = Object.values(agg);
      const overall = dims.length > 0 ? dims.reduce((s, v) => s + v, 0) / dims.length : 0;
      deriveConfidence(overall, null);
      const elapsed = performance.now() - start;
      durations.push(elapsed);
    }

    durations.sort((a, b) => a - b);
    const p95Index = Math.floor(durations.length * 0.95);
    const p95 = durations[p95Index];
    expect(p95).toBeLessThan(10); // SC-001: < 10ms p95
  });
});
