// Guardrail runner — runs Guardrail[] for input/output phases

import type { Guardrail, GuardrailContext, GuardrailResult } from '../types.js';
import { EngineError } from '../errors.js';

/** Warning emitted when a guardrail returns action 'warn' */
export interface GuardrailWarning {
  guardrailName: string;
  reason: string | null;
  phase: 'input' | 'output';
}

/**
 * Run guardrails sequentially for a given phase and flow.
 *
 * Guardrails are filtered by phase and flowName, sorted by priority (lower first),
 * and executed sequentially so each handler sees the output of the previous one.
 *
 * Result actions:
 * - 'pass':      continue to next guardrail with unchanged content
 * - 'block':     throw EngineError with code GUARDRAIL_BLOCKED
 * - 'warn':      record warning, continue with unchanged content
 * - 'transform': continue with transformedContent as the new content
 *
 * failureMode (when handler throws):
 * - 'block' (default): re-throw as EngineError GUARDRAIL_BLOCKED
 * - 'pass':            log and continue (skip this guardrail)
 */
export async function runGuardrails(
  guardrails: Guardrail[],
  content: unknown,
  context: GuardrailContext,
): Promise<{ content: unknown; warnings: GuardrailWarning[] }> {
  const warnings: GuardrailWarning[] = [];

  // Filter by phase
  const phaseFiltered = guardrails.filter((g) => g.phase === context.phase);

  // Filter by flowName: include guardrails where flowName is null/undefined (applies to all)
  // or where flowName matches the current flow
  const applicable = phaseFiltered.filter(
    (g) => g.flowName == null || g.flowName === context.flowName,
  );

  // Sort by priority (lower number = higher priority = evaluated first)
  const sorted = [...applicable].sort((a, b) => a.priority - b.priority);

  let currentContent = content;

  for (const guardrail of sorted) {
    let result: GuardrailResult;

    try {
      result = await guardrail.handler(currentContent, context);
    } catch (error) {
      const failureMode = guardrail.failureMode ?? 'block';

      if (failureMode === 'pass') {
        // Skip this guardrail — continue with current content
        continue;
      }

      // failureMode 'block' (default): re-throw as GUARDRAIL_BLOCKED
      const message =
        error instanceof Error ? error.message : 'Unknown guardrail error';
      throw new EngineError(
        `Guardrail "${guardrail.name}" failed: ${message}`,
        'GUARDRAIL_BLOCKED',
      );
    }

    switch (result.action) {
      case 'pass':
        // Continue with unchanged content
        break;

      case 'block':
        throw new EngineError(
          `Guardrail "${guardrail.name}" blocked: ${result.reason ?? 'content blocked'}`,
          'GUARDRAIL_BLOCKED',
        );

      case 'warn':
        warnings.push({
          guardrailName: guardrail.name,
          reason: result.reason,
          phase: context.phase,
        });
        // Continue with unchanged content
        break;

      case 'transform':
        currentContent = result.transformedContent;
        break;

      default:
        // Unknown action — treat as block (fail-closed)
        throw new EngineError(
          `Guardrail "${guardrail.name}" returned invalid action (fail-closed)`,
          'GUARDRAIL_BLOCKED',
        );
    }
  }

  return { content: currentContent, warnings };
}
