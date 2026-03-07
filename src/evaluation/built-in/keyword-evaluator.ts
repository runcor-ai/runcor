// Built-in evaluator: keyword presence detection

import type { Evaluator, EvalResult } from '../../types.js';

export interface KeywordEvaluatorOptions {
  name: string;
  required?: string[];
  forbidden?: string[];
  caseSensitive?: boolean;
  priority?: number;
}

/**
 * Factory function for a keyword-based evaluator.
 * Scores based on presence/absence of required/forbidden keywords.
 * Scores on the 'safety' dimension.
 */
export function createKeywordEvaluator(options: KeywordEvaluatorOptions): Evaluator {
  const {
    name,
    required = [],
    forbidden = [],
    caseSensitive = false,
    priority = 10,
  } = options;

  return {
    name,
    priority,
    evaluate: async (context): Promise<EvalResult> => {
      const output = context.output;

      if (typeof output !== 'string') {
        return { scores: { safety: 0.0 } };
      }

      const text = caseSensitive ? output : output.toLowerCase();

      // No keywords specified — any content is fine
      if (required.length === 0 && forbidden.length === 0) {
        return { scores: { safety: 1.0 } };
      }

      let score = 1.0;

      // Required keywords: score proportional to how many are present
      if (required.length > 0) {
        const found = required.filter((kw) => {
          const keyword = caseSensitive ? kw : kw.toLowerCase();
          return text.includes(keyword);
        });
        score = found.length / required.length;
      }

      // Forbidden keywords: degrade score for each forbidden keyword found
      if (forbidden.length > 0) {
        const foundForbidden = forbidden.filter((kw) => {
          const keyword = caseSensitive ? kw : kw.toLowerCase();
          return text.includes(keyword);
        });
        if (foundForbidden.length > 0) {
          const penalty = foundForbidden.length / forbidden.length;
          score = Math.max(0, score - penalty);
        }
      }

      return { scores: { safety: score } };
    },
  };
}
