// SignalCollector — reads signals from subsystem stores + accumulators

import type {
  CostSignals,
  QualitySignals,
  ExecutionSignals,
  PolicySignals,
  AgentSignals,
  ProviderSignals,
  ScheduleSignals,
  AdapterSignals,
  MemorySignals,
  McpServerSignals,
} from './types.js';
import type { SignalAccumulator } from './accumulator.js';
import type { CostLedgerStore, EvalRecord, CostEntry } from '../types.js';

/** Dependencies injected into SignalCollector */
export interface CollectorDeps {
  costLedger: CostLedgerStore | null;
  evaluationEngine: {
    listEvaluations(filter?: { flowName?: string; startTime?: Date }): EvalRecord[];
    listFlags?(filter?: { flowName?: string }): Array<{ executionId: string }>;
  } | null;
  stateStore: {
    list(filter?: { flowName?: string }): Promise<Array<{ state: string; flowName: string; result?: unknown }>>;
  } | null;
  accumulator: SignalAccumulator;
  scheduler: {
    getSchedule?(flowName: string): { cronExpression: string; lastFiredAt: Date | null; nextFireTime: Date | null } | null;
  } | null;
  memoryStore: {
    list(namespace: string): Promise<string[]>;
  } | null;
  flowRegistry: Map<string, { name: string }>;
}

/**
 * Collects signals from subsystem stores and event accumulators.
 * Each collect method handles missing subsystems by returning neutral defaults.
 */
export class SignalCollector {
  constructor(private readonly deps: CollectorDeps) {}

  /** Collect cost signals from cost ledger */
  collectCostSignals(flowName: string, startTime: Date, totalEngineCost: number): CostSignals {
    if (!this.deps.costLedger) {
      return { totalCost: 0, costTrend: 'stable', costPercentOfTotal: 0, requestCount: 0 };
    }

    const entries = this.deps.costLedger.query({ flowName, startTime });
    const totalCost = entries.reduce((sum, e: CostEntry) => sum + e.cost, 0);
    const requestCount = entries.length;
    const costPercentOfTotal = totalEngineCost > 0 ? totalCost / totalEngineCost : 0;

    // Trend: compare recent third vs earliest third
    const costTrend = this.computeTrend(
      entries.map((e: CostEntry) => ({ timestamp: e.timestamp, value: e.cost })),
    ) as 'increasing' | 'decreasing' | 'stable';

    return { totalCost, costTrend, costPercentOfTotal, requestCount };
  }

  /** Collect quality signals from evaluation records */
  collectQualitySignals(flowName: string, startTime: Date): QualitySignals {
    if (!this.deps.evaluationEngine) {
      return { averageScore: null, scoreTrend: null, humanReviewFlagCount: 0, evaluationCount: 0 };
    }

    const records = this.deps.evaluationEngine.listEvaluations({ flowName, startTime });
    const evaluationCount = records.length;

    if (evaluationCount === 0) {
      return { averageScore: null, scoreTrend: null, humanReviewFlagCount: 0, evaluationCount: 0 };
    }

    const averageScore = records.reduce((sum, r) => sum + r.overallScore, 0) / evaluationCount;

    const scoreTrend = this.computeTrend(
      records.map(r => ({ timestamp: r.timestamp, value: r.overallScore })),
    );
    const qualityTrend = scoreTrend === 'increasing' ? 'improving' as const
      : scoreTrend === 'decreasing' ? 'declining' as const
      : 'stable' as const;

    const humanReviewFlagCount = this.deps.evaluationEngine.listFlags?.({ flowName })?.length ?? 0;

    return { averageScore, scoreTrend: qualityTrend, humanReviewFlagCount, evaluationCount };
  }

  /** Collect execution signals from state store */
  async collectExecutionSignals(flowName: string): Promise<ExecutionSignals> {
    if (!this.deps.stateStore) {
      return { totalExecutions: 0, completeCount: 0, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 0 };
    }

    const executions = await this.deps.stateStore.list({ flowName });
    const totalExecutions = executions.length;

    const completeCount = executions.filter(e => e.state === 'complete').length;
    const failedCount = executions.filter(e => e.state === 'failed').length;
    const waitingCount = executions.filter(e => e.state === 'waiting').length;
    const timeoutCount = 0; // Timeout shows as 'failed' — would need error inspection
    const resumeCount = 0; // Would need state transition history

    const successRate = totalExecutions > 0 ? completeCount / totalExecutions : 0;

    return { totalExecutions, completeCount, failedCount, timeoutCount, waitingCount, resumeCount, successRate };
  }

  /** Collect policy signals from accumulator */
  collectPolicySignals(flowName: string, startTime: Date): PolicySignals {
    const violations = this.deps.accumulator.getViolations(flowName, startTime);

    const violationTypes: Record<string, number> = {};
    let rateLimitHitCount = 0;

    for (const v of violations) {
      const ruleName = (v.payload.ruleName as string) || 'unknown';
      violationTypes[ruleName] = (violationTypes[ruleName] || 0) + 1;
      if (v.payload._type === 'rate_limited') {
        rateLimitHitCount++;
      }
    }

    return { violationCount: violations.length, violationTypes, rateLimitHitCount };
  }

  /** Collect adapter signals from accumulator */
  collectAdapterSignals(flowName: string, startTime: Date): AdapterSignals {
    const toolCalls = this.deps.accumulator.getToolCalls(flowName, startTime);

    const adaptersUsed = new Set<string>();
    const toolsUsed = new Set<string>();

    for (const call of toolCalls) {
      const adapter = call.payload.adapter as string;
      const tool = call.payload.tool as string;
      if (adapter) adaptersUsed.add(adapter);
      if (adapter && tool) toolsUsed.add(`${adapter}.${tool}`);
    }

    return {
      adaptersUsed: Array.from(adaptersUsed),
      toolsUsed: Array.from(toolsUsed),
      toolCallCount: toolCalls.length,
    };
  }

  /** Collect memory signals from memory store */
  async collectMemorySignals(flowName: string): Promise<MemorySignals> {
    if (!this.deps.memoryStore) {
      return { activeScopeCount: 0, scopeNames: [] };
    }

    try {
      const namespace = `tool:${flowName}`;
      const keys = await this.deps.memoryStore.list(namespace);
      return { activeScopeCount: keys.length, scopeNames: keys };
    } catch {
      return { activeScopeCount: 0, scopeNames: [] };
    }
  }

  /** Collect MCP server invocation signals */
  collectMcpServerSignals(flowName: string, startTime: Date): McpServerSignals | null {
    const invocations = this.deps.accumulator.getMcpInvocations(flowName, startTime);
    if (invocations.length === 0) return null;
    return { externalInvocationCount: invocations.length };
  }

  /** Collect schedule signals from CronScheduler */
  collectScheduleSignals(flowName: string): ScheduleSignals | null {
    if (!this.deps.scheduler?.getSchedule) return null;
    const schedule = this.deps.scheduler.getSchedule(flowName);
    if (!schedule) return null;
    return {
      cronExpression: schedule.cronExpression,
      lastFiredAt: schedule.lastFiredAt,
      nextFireTime: schedule.nextFireTime!,
      overlapFlows: [],
    };
  }

  /** Compute trend from timestamped values: split into thirds, compare earliest vs recent */
  private computeTrend(
    entries: Array<{ timestamp: Date; value: number }>,
  ): 'increasing' | 'decreasing' | 'stable' {
    if (entries.length < 3) return 'stable';

    const sorted = [...entries].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const thirdSize = Math.floor(sorted.length / 3);

    const earlyAvg = sorted.slice(0, thirdSize).reduce((s, e) => s + e.value, 0) / thirdSize;
    const recentAvg = sorted.slice(-thirdSize).reduce((s, e) => s + e.value, 0) / thirdSize;

    const threshold = 0.1; // 10% change threshold
    const percentChange = earlyAvg > 0 ? (recentAvg - earlyAvg) / earlyAvg : 0;

    if (percentChange > threshold) return 'increasing';
    if (percentChange < -threshold) return 'decreasing';
    return 'stable';
  }
}
