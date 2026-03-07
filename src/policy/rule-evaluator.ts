// Rule evaluator — evaluates PolicyRule[] in priority order

import type { PolicyRule, PolicyContext, PolicyDecision } from '../types.js';

/** Extended decision that includes the denying rule name for event emission */
export interface RuleEvaluationResult extends PolicyDecision {
  /** Name of the rule that caused the decision (set on deny/modify) */
  ruleName?: string;
}

/**
 * Evaluate policy rules against a context.
 *
 * Rules are sorted by priority (lower = first), filtered by operation type,
 * and evaluated sequentially. On deny, evaluation short-circuits.
 * Invalid actions are treated as deny (fail-closed).
 * Rules that throw are treated as deny (fail-closed).
 *
 * Returns the aggregate decision:
 * - 'allow' if all rules allow
 * - 'deny' if any rule denies (with short-circuit)
 * - 'modify' if any rule modifies and none deny (last modify wins)
 */
export function evaluateRules(rules: PolicyRule[], context: PolicyContext): RuleEvaluationResult {
  if (rules.length === 0) {
    return { action: 'allow', reason: null };
  }

  // Filter rules that apply to this operation
  const applicable = rules.filter((r) => r.operations.includes(context.operation));

  if (applicable.length === 0) {
    return { action: 'allow', reason: null };
  }

  // Sort by priority (lower number = higher priority = evaluated first)
  const sorted = [...applicable].sort((a, b) => a.priority - b.priority);

  let lastModify: RuleEvaluationResult | null = null;

  for (const rule of sorted) {
    let decision: PolicyDecision;

    try {
      decision = rule.evaluate(context);
    } catch {
      // Rule threw — treat as deny (fail-closed)
      return {
        action: 'deny',
        reason: `Rule "${rule.name}" threw an error (fail-closed)`,
        ruleName: rule.name,
      };
    }

    // Validate action
    if (decision.action !== 'allow' && decision.action !== 'deny' && decision.action !== 'modify') {
      // Invalid action — treat as deny (fail-closed)
      return {
        action: 'deny',
        reason: `Rule "${rule.name}" returned invalid action (fail-closed)`,
        ruleName: rule.name,
      };
    }

    if (decision.action === 'deny') {
      // Short-circuit on deny
      return { ...decision, ruleName: rule.name };
    }

    if (decision.action === 'modify') {
      lastModify = { ...decision, ruleName: rule.name };
    }
  }

  // If any rule modified, return the last modify decision
  if (lastModify) {
    return lastModify;
  }

  return { action: 'allow', reason: null };
}
