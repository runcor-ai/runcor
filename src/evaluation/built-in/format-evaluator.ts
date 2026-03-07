// Built-in evaluator: format/type validation

import type { Evaluator, EvalResult } from '../../types.js';

export type ExpectedFormat = 'string' | 'json-object' | 'array';

export interface FormatEvaluatorOptions {
  name: string;
  expectedFormat: ExpectedFormat;
  priority?: number;
}

/**
 * Factory function for a format-based evaluator.
 * Scores 1.0 for matching format, 0.0 for mismatch.
 * Scores on the 'accuracy' dimension.
 */
export function createFormatEvaluator(options: FormatEvaluatorOptions): Evaluator {
  const { name, expectedFormat, priority = 10 } = options;

  return {
    name,
    priority,
    evaluate: async (context): Promise<EvalResult> => {
      const output = context.output;

      if (output === null || output === undefined) {
        return { scores: { accuracy: 0.0 } };
      }

      let matches = false;

      switch (expectedFormat) {
        case 'string':
          matches = typeof output === 'string';
          break;
        case 'json-object':
          matches = typeof output === 'object' && !Array.isArray(output);
          break;
        case 'array':
          matches = Array.isArray(output);
          break;
      }

      return { scores: { accuracy: matches ? 1.0 : 0.0 } };
    },
  };
}
