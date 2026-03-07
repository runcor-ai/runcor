// EvaluationEngine — orchestrates post-execution quality evaluation

import type {
  Evaluator,
  EvalContext,
  EvalRecord,
  EvaluationConfig,
  HumanReviewFlag,
  FlagStatus,
  FlagFilter,
  ConfidenceLevel,
  EvalScoreEvent,
  EvalCompleteEvent,
  EvalFlaggedEvent,
} from '../types.js';
import { EngineError } from '../errors.js';
import type { EngineInstrumentation } from '../telemetry/instrumentation.js';
import { runEvaluators } from './runner.js';
import { aggregateScores, deriveConfidence } from './scorer.js';
import { FlagManager } from './flag-manager.js';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_EVAL_RECORDS = 10000;

/**
 * Internal evaluation engine that orchestrates post-execution quality scoring.
 * Instantiated 1:1 with the Runcor engine.
 *
 * Zero-evaluator default: all methods return immediately when no evaluators
 * are registered, creating no telemetry spans and emitting no events.
 */
export class EvaluationEngine {
  private readonly evaluators = new Map<string, Evaluator>();
  private readonly evalRecords = new Map<string, EvalRecord>();
  private readonly flagManager = new FlagManager();

  private readonly instrumentation: EngineInstrumentation;
  private readonly emitEvent: (type: string, payload: unknown) => void;
  private readonly autoFlagScoreThreshold: number | null;

  constructor(
    config: EvaluationConfig | undefined,
    instrumentation: EngineInstrumentation,
    emitEvent: (type: string, payload: unknown) => void,
  ) {
    this.instrumentation = instrumentation;
    this.emitEvent = emitEvent;
    this.autoFlagScoreThreshold = config?.autoFlagScoreThreshold ?? null;

    // Initialize evaluators from config if provided
    if (config?.evaluators) {
      for (const evaluator of config.evaluators) {
        this.evaluators.set(evaluator.name, evaluator);
      }
    }
  }

  /** Check if any evaluators are registered (zero-evaluator fast-path) */
  hasEvaluators(): boolean {
    return this.evaluators.size > 0;
  }

  /** Register an evaluator. Throws DUPLICATE_EVALUATOR if name already exists. */
  addEvaluator(evaluator: Evaluator): void {
    if (this.evaluators.has(evaluator.name)) {
      throw new EngineError(
        `Evaluator "${evaluator.name}" already exists.`,
        'DUPLICATE_EVALUATOR',
      );
    }
    if (evaluator.priority <= 0) {
      throw new EngineError(
        `Evaluator "${evaluator.name}" must have priority > 0.`,
        'INVALID_EVALUATOR_CONFIG',
      );
    }
    if (evaluator.timeoutMs !== undefined && evaluator.timeoutMs !== null && evaluator.timeoutMs <= 0) {
      throw new EngineError(
        `Evaluator "${evaluator.name}" must have timeoutMs > 0.`,
        'INVALID_EVALUATOR_CONFIG',
      );
    }
    if (evaluator.thresholds) {
      if (evaluator.thresholds.high <= evaluator.thresholds.medium) {
        throw new EngineError(
          `Evaluator "${evaluator.name}" must have thresholds.high > thresholds.medium.`,
          'INVALID_EVALUATOR_CONFIG',
        );
      }
    }
    this.evaluators.set(evaluator.name, evaluator);
  }

  /** Remove an evaluator by name. No-op if not found. */
  removeEvaluator(name: string): void {
    this.evaluators.delete(name);
  }

  /** Get all registered evaluators (for testing/inspection) */
  getEvaluators(): ReadonlyMap<string, Evaluator> {
    return this.evaluators;
  }

  /**
   * Run evaluation on a completed execution.
   * Zero-evaluator fast-path: returns immediately when no evaluators registered.
   * Filters evaluators by flowName, sorts by priority, runs with timeout/error isolation.
   */
  async runEvaluation(context: EvalContext): Promise<void> {
    // Zero-evaluator fast-path
    if (!this.hasEvaluators()) {
      return;
    }

    // Filter evaluators applicable to this flow
    const applicable = Array.from(this.evaluators.values()).filter((e) => {
      if (!e.flowNames || e.flowNames.length === 0) return true; // null/empty = all flows
      return e.flowNames.includes(context.flowName);
    });

    if (applicable.length === 0) {
      return;
    }

    // Sort by priority (lower number first)
    applicable.sort((a, b) => a.priority - b.priority);

    // Run all evaluators with timeout and error isolation
    const { results, errors } = await runEvaluators(applicable, context, DEFAULT_TIMEOUT_MS);

    // Emit eval:score for each successful evaluator result
    for (const result of results) {
      const scoreEvent: EvalScoreEvent = {
        executionId: context.executionId,
        flowName: context.flowName,
        evaluatorName: result.evaluatorName,
        scores: result.scores,
        confidence: result.confidence,
        labels: result.labels,
        durationMs: result.durationMs,
      };
      this.emitEvent('eval:score', scoreEvent);
    }

    // Compute aggregate scores and confidence
    const aggScores = aggregateScores(results);
    const dimensionNames = Object.keys(aggScores);
    const overallScore = dimensionNames.length > 0
      ? dimensionNames.reduce((sum, dim) => sum + aggScores[dim], 0) / dimensionNames.length
      : 0;

    // Derive per-evaluator confidence using evaluator-specific or default thresholds
    for (const result of results) {
      const evaluator = this.evaluators.get(result.evaluatorName);
      const evalScores = Object.values(result.scores);
      const evalAvg = evalScores.length > 0
        ? evalScores.reduce((s, v) => s + v, 0) / evalScores.length
        : 0;
      result.confidence = deriveConfidence(evalAvg, evaluator?.thresholds ?? null);
    }

    const overallConfidence = deriveConfidence(overallScore, null);

    // Collect all labels
    const allLabels = results.flatMap((r) => r.labels);

    // Build and store EvalRecord
    const record: EvalRecord = {
      executionId: context.executionId,
      flowName: context.flowName,
      timestamp: new Date(),
      evaluatorResults: results,
      aggregateScores: aggScores,
      overallScore,
      confidence: overallConfidence,
      labels: allLabels,
      errors,
    };

    // Evict oldest record if over limit
    if (this.evalRecords.size >= MAX_EVAL_RECORDS) {
      const firstKey = this.evalRecords.keys().next().value;
      if (firstKey !== undefined) this.evalRecords.delete(firstKey);
    }
    this.evalRecords.set(context.executionId, record);

    // Auto-flag on low confidence
    const hasLowConfidence = results.some((r) => r.confidence === 'low');
    if (hasLowConfidence) {
      const lowEvaluators = results
        .filter((r) => r.confidence === 'low')
        .map((r) => r.evaluatorName);
      try {
        this.flagManager.createFlag(
          context.executionId,
          context.flowName,
          `Low confidence from evaluator(s): ${lowEvaluators.join(', ')}`,
          'auto',
        );
        const flag = this.flagManager.getFlag(context.executionId);
        if (flag) {
          const flagEvent: EvalFlaggedEvent = {
            executionId: context.executionId,
            flowName: context.flowName,
            reason: flag.reason,
            source: 'auto',
            status: 'pending',
            timestamp: flag.createdAt,
          };
          this.emitEvent('eval:flagged', flagEvent);
        }
      } catch {
        // Already flagged — ignore
      }
    }

    // Auto-flag on dimension score below threshold
    if (this.autoFlagScoreThreshold !== null) {
      for (const [dim, score] of Object.entries(aggScores)) {
        if (score < this.autoFlagScoreThreshold) {
          try {
            this.flagManager.createFlag(
              context.executionId,
              context.flowName,
              `Dimension "${dim}" score ${score.toFixed(2)} below threshold ${this.autoFlagScoreThreshold}`,
              'auto',
            );
            const flag = this.flagManager.getFlag(context.executionId);
            if (flag) {
              const flagEvent: EvalFlaggedEvent = {
                executionId: context.executionId,
                flowName: context.flowName,
                reason: flag.reason,
                source: 'auto',
                status: 'pending',
                timestamp: flag.createdAt,
              };
              this.emitEvent('eval:flagged', flagEvent);
            }
          } catch {
            // Already flagged — ignore
          }
          break; // One flag per execution is enough
        }
      }
    }

    // Emit eval:complete
    const completeEvent: EvalCompleteEvent = {
      executionId: context.executionId,
      flowName: context.flowName,
      aggregateScores: aggScores,
      overallScore,
      confidence: overallConfidence,
      evaluatorCount: results.length,
      errorCount: errors.length,
      timestamp: record.timestamp,
    };
    this.emitEvent('eval:complete', completeEvent);
  }

  /** Get evaluation record for an execution */
  getEvaluation(executionId: string): EvalRecord | null {
    return this.evalRecords.get(executionId) ?? null;
  }

  /** List evaluation records with optional filtering */
  listEvaluations(filter?: { flowName?: string; startTime?: Date }): EvalRecord[] {
    const records = Array.from(this.evalRecords.values());
    if (!filter) return records;

    return records.filter((r) => {
      if (filter.flowName && r.flowName !== filter.flowName) return false;
      if (filter.startTime && r.timestamp < filter.startTime) return false;
      return true;
    });
  }

  /** Manually flag an execution for human review */
  flagExecution(executionId: string, flowName: string, reason?: string): void {
    this.flagManager.createFlag(
      executionId,
      flowName,
      reason ?? 'Manually flagged for review',
      'manual',
    );
    const flag = this.flagManager.getFlag(executionId);
    if (flag) {
      const flagEvent: EvalFlaggedEvent = {
        executionId,
        flowName,
        reason: flag.reason,
        source: 'manual',
        status: 'pending',
        timestamp: flag.createdAt,
      };
      this.emitEvent('eval:flagged', flagEvent);
    }
  }

  /** Update flag status */
  updateFlag(executionId: string, status: FlagStatus): void {
    this.flagManager.updateFlag(executionId, status);
  }

  /** List flags matching filter criteria */
  listFlags(filter?: FlagFilter): HumanReviewFlag[] {
    return this.flagManager.listFlags(filter);
  }
}
