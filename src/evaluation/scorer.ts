// Score aggregation and confidence derivation

import type {
  EvaluatorResultEntry,
  ConfidenceLevel,
  ConfidenceThresholds,
} from '../types.js';

/** Default confidence thresholds per spec */
const DEFAULT_THRESHOLDS: ConfidenceThresholds = {
  high: 0.8,
  medium: 0.5,
};

/**
 * Aggregate scores from multiple evaluator results.
 * For each dimension, computes the mean across all evaluators that scored it.
 * Scores are clamped to 0.0-1.0 range.
 */
export function aggregateScores(
  results: EvaluatorResultEntry[],
): Record<string, number> {
  if (results.length === 0) {
    return {};
  }

  // Collect all scores per dimension
  const dimensionScores = new Map<string, number[]>();

  for (const result of results) {
    for (const [dim, score] of Object.entries(result.scores)) {
      const clamped = Math.max(0, Math.min(1, score));
      const existing = dimensionScores.get(dim);
      if (existing) {
        existing.push(clamped);
      } else {
        dimensionScores.set(dim, [clamped]);
      }
    }
  }

  // Average per dimension
  const aggregated: Record<string, number> = {};
  for (const [dim, scores] of dimensionScores) {
    aggregated[dim] = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  }

  return aggregated;
}

/**
 * Derive confidence level from an aggregate score against thresholds.
 * Uses default thresholds { high: 0.8, medium: 0.5 } when none provided.
 */
export function deriveConfidence(
  overallScore: number,
  thresholds: ConfidenceThresholds | null | undefined,
): ConfidenceLevel {
  const t = thresholds ?? DEFAULT_THRESHOLDS;
  if (overallScore >= t.high) return 'high';
  if (overallScore >= t.medium) return 'medium';
  return 'low';
}
