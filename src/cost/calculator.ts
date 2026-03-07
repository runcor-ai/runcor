// CostCalculator — pure cost calculation functions

import type { CostPerToken } from '../types.js';

/**
 * Calculate actual cost from token usage and provider rates.
 * Returns 0 when costPerToken is null (no cost configured).
 * Missing/zero rates are treated as zero.
 */
export function calculateCost(
  promptTokens: number,
  completionTokens: number,
  costPerToken: CostPerToken | null,
): number {
  if (!costPerToken) return 0;
  const input = Math.max(0, costPerToken.input);
  const output = Math.max(0, costPerToken.output);
  return (Math.max(0, promptTokens) * input) + (Math.max(0, completionTokens) * output);
}

/**
 * Estimate cost before a request is sent (pre-request budget check).
 * Uses prompt length / 4 as rough tokenizer approximation.
 * Uses defaultTokenEstimate when maxTokens is not specified.
 * Returns 0 when costPerToken is null.
 */
export function estimateCost(
  promptLength: number,
  maxTokens: number | undefined,
  costPerToken: CostPerToken | null,
  defaultTokenEstimate: number,
): number {
  if (!costPerToken) return 0;
  const promptEstimate = promptLength / 4;
  const completionEstimate = maxTokens ?? defaultTokenEstimate;
  return (promptEstimate * costPerToken.input) + (completionEstimate * costPerToken.output);
}
