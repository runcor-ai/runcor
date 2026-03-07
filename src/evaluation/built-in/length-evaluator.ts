// Built-in evaluator: output length scoring

import type { Evaluator, EvalResult } from '../../types.js';

export interface LengthEvaluatorOptions {
  name: string;
  minLength?: number;
  maxLength?: number;
  priority?: number;
}

/**
 * Factory function for a length-based evaluator.
 * Scores output length linearly between configured bounds.
 * Scores on the 'relevance' dimension.
 */
export function createLengthEvaluator(options: LengthEvaluatorOptions): Evaluator {
  const { name, minLength, maxLength, priority = 10 } = options;

  return {
    name,
    priority,
    evaluate: async (context): Promise<EvalResult> => {
      const output = context.output;

      if (typeof output !== 'string') {
        return { scores: { relevance: 0.0 } };
      }

      const len = output.length;

      // No bounds specified — any length is fine
      if (minLength === undefined && maxLength === undefined) {
        return { scores: { relevance: 1.0 } };
      }

      // Empty string with minLength > 0
      if (len === 0 && minLength !== undefined && minLength > 0) {
        return { scores: { relevance: 0.0 } };
      }

      let score = 1.0;

      // Too short: linear degradation from minLength to 0
      if (minLength !== undefined && len < minLength) {
        score = Math.max(0, len / minLength);
      }

      // Too long: linear degradation beyond maxLength
      if (maxLength !== undefined && len > maxLength) {
        // Score degrades as length exceeds max — cap at 2x max = score 0
        const excess = len - maxLength;
        score = Math.max(0, 1 - excess / maxLength);
      }

      return { scores: { relevance: score } };
    },
  };
}
