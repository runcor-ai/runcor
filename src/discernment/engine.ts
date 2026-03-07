// DiscernmentEngine — core orchestration, report storage, recommendation management

import { trace, type Span } from '@opentelemetry/api';
import { EngineError } from '../errors.js';
import type {
  CycleReport,
  Recommendation,
  RecommendationFilter,
  RecommendationStatus,
  DiscernmentConfig,
  FlowProfile,
  SystemProfile,
  Signal,
  Objective,
  PendingAction,
  CostSignals,
  QualitySignals,
  ExecutionSignals,
  PolicySignals,
  AdapterSignals,
  MemorySignals,
  McpServerSignals,
  ScheduleSignals,
  ModelAnalysisResult,
} from './types.js';

/** Schedule shorthand mapping */
const SCHEDULE_SHORTHANDS: Record<string, string> = {
  daily: '0 0 * * *',
  hourly: '0 * * * *',
  weekly: '0 0 * * 0',
};

/** Actions eligible for enforce mode auto-execution */
const ENFORCEABLE_ACTIONS = new Set(['retire', 'optimize']);

/** Dependencies for cycle orchestration (optional — not needed for report-only use) */
export interface DiscernmentDeps {
  collector: {
    collectCostSignals(flowName: string, startTime: Date, totalCost: number): CostSignals;
    collectQualitySignals(flowName: string, startTime: Date): QualitySignals;
    collectExecutionSignals(flowName: string): Promise<ExecutionSignals>;
    collectPolicySignals(flowName: string, startTime: Date): PolicySignals;
    collectAdapterSignals(flowName: string, startTime: Date): AdapterSignals;
    collectMemorySignals(flowName: string): Promise<MemorySignals>;
    collectMcpServerSignals(flowName: string, startTime: Date): McpServerSignals | null;
    collectScheduleSignals(flowName: string): ScheduleSignals | null;
  };
  profiler: {
    buildSystemProfile(flowProfiles: FlowProfile[], objectives: Objective[], lookbackPeriod: number): SystemProfile;
  };
  heuristicAnalyzer: {
    analyze(flowProfiles: FlowProfile[], systemProfile: SystemProfile): Signal[];
  };
  modelAnalyzer: {
    analyze(systemProfile: SystemProfile, signals: Signal[]): Promise<{
      recommendations: Recommendation[];
      modelAnalysis: ModelAnalysisResult;
      signals?: Signal[];
    }>;
  };
  objectiveRegistry: {
    listObjectives(): Objective[];
    listOrphanFlows(): string[];
  };
  flowRegistry: Map<string, { name: string }>;
  emitEvent: (event: string, ...args: unknown[]) => void;
}

/** Enforce mode callbacks for auto-execution */
export interface EnforceCallbacks {
  enforceableFlows: Set<string>;
  unregister: (flowName: string) => void;
}

/**
 * Core discernment engine — manages cycle reports, recommendations, and their lifecycle.
 * When deps are provided, supports full cycle orchestration.
 */
export class DiscernmentEngine {
  private readonly config: DiscernmentConfig;
  private readonly deps: DiscernmentDeps | null;
  private readonly enforceCallbacks: EnforceCallbacks | null;
  private readonly reports = new Map<string, CycleReport>();
  private readonly recommendations = new Map<string, Recommendation>();
  private readonly cycleRecommendations = new Map<string, string[]>();
  private readonly pendingActions = new Map<string, PendingAction>();
  private cycleInProgress = false;
  /** ID of the last cycle that produced recommendations (for advise gate) */
  private lastAdviseCycleId: string | null = null;

  /** Resolved cron expression from schedule config */
  readonly resolvedSchedule: string;

  constructor(config: DiscernmentConfig, deps?: DiscernmentDeps, enforceCallbacks?: EnforceCallbacks) {
    this.config = config;
    this.deps = deps ?? null;
    this.enforceCallbacks = enforceCallbacks ?? null;
    this.resolvedSchedule = SCHEDULE_SHORTHANDS[config.schedule] ?? config.schedule;
  }

  // ── Cycle Orchestration ──

  /** Run a full discernment cycle */
  async runCycle(): Promise<CycleReport> {
    if (!this.config.enabled) {
      throw new EngineError('Discernment is not enabled', 'DISCERNMENT_DISABLED');
    }
    if (this.cycleInProgress) {
      throw new EngineError('A discernment cycle is already in progress', 'CYCLE_IN_PROGRESS');
    }

    // Advise gate: check if previous cycle's recommendations are still pending
    if (this.config.autonomy === 'advise' && this.lastAdviseCycleId) {
      const pendingRecs = this.getRecommendations({ cycleId: this.lastAdviseCycleId, status: 'pending' });
      if (pendingRecs.length > 0) {
        throw new EngineError(
          `Cannot start new cycle: ${pendingRecs.length} recommendation(s) from cycle '${this.lastAdviseCycleId}' require acknowledgment or dismissal`,
          'ADVISE_GATE_PENDING',
        );
      }
    }

    this.cycleInProgress = true;
    const tracer = trace.getTracer('runcor');
    const cycleSpan = tracer.startSpan('discernment.cycle', {
      attributes: { 'discernment.autonomy': this.config.autonomy },
    });
    try {
      const report = await this.executeCycle();
      cycleSpan.setAttribute('discernment.cycle_id', report.id);
      cycleSpan.setAttribute('discernment.signal_count', report.signals.length);
      cycleSpan.setAttribute('discernment.recommendation_count', report.recommendations.length);
      return report;
    } catch (err) {
      cycleSpan.recordException(err as Error);
      throw err;
    } finally {
      cycleSpan.end();
      this.cycleInProgress = false;
    }
  }

  private async executeCycle(): Promise<CycleReport> {
    const tracer = trace.getTracer('runcor');
    const deps = this.deps;
    if (!deps) {
      throw new EngineError('Discernment deps not configured for cycle execution', 'DISCERNMENT_DISABLED');
    }

    const lookbackPeriod = this.config.lookbackPeriod ?? 604800;
    const startTime = new Date(Date.now() - lookbackPeriod * 1000);
    const objectives = deps.objectiveRegistry.listObjectives();

    // Step 1: Collect signals for each flow
    const flowNames = Array.from(deps.flowRegistry.keys());
    const flowProfiles: FlowProfile[] = [];

    const collectSpan = tracer.startSpan('discernment.collect', {
      attributes: { 'discernment.flow_count': flowNames.length },
    });

    try {
      // First pass: compute total cost
      let totalEngineCost = 0;
      const costSignalsMap = new Map<string, any>();
      for (const flowName of flowNames) {
        const cost = deps.collector.collectCostSignals(flowName, startTime, 0);
        costSignalsMap.set(flowName, cost);
        totalEngineCost += cost.totalCost;
      }

      // Second pass: build flow profiles
      for (const flowName of flowNames) {
        const cost = costSignalsMap.get(flowName)!;
        cost.costPercentOfTotal = totalEngineCost > 0 ? cost.totalCost / totalEngineCost : 0;

        const quality = deps.collector.collectQualitySignals(flowName, startTime);
        const execution = await deps.collector.collectExecutionSignals(flowName);
        const policy = deps.collector.collectPolicySignals(flowName, startTime);
        const adapter = deps.collector.collectAdapterSignals(flowName, startTime);
        const memory = await deps.collector.collectMemorySignals(flowName);
        const mcpServer = deps.collector.collectMcpServerSignals(flowName, startTime);
        const schedule = deps.collector.collectScheduleSignals(flowName);

        flowProfiles.push({
          flowName,
          cost,
          quality,
          execution,
          policy,
          agent: null,
          provider: { providerDistribution: {}, fallbackFrequency: 0 },
          schedule,
          adapter,
          memory,
          mcpServer,
          objective: null,
          secondaryObjectives: [],
        });
      }
    } finally {
      collectSpan.end();
    }

    // Step 2: Build system profile
    const systemProfile = deps.profiler.buildSystemProfile(flowProfiles, objectives, lookbackPeriod);

    // Step 3: Run heuristic analysis
    const heuristicSpan = tracer.startSpan('discernment.heuristics');
    let signals: Signal[];
    try {
      signals = deps.heuristicAnalyzer.analyze(flowProfiles, systemProfile);
      heuristicSpan.setAttribute('discernment.signal_count', signals.length);
    } finally {
      heuristicSpan.end();
    }

    for (const signal of signals) {
      this.emitEvent('discernment:signal', signal);
    }

    // Step 4: Model analysis (skip in observe mode)
    let recommendations: Recommendation[] = [];
    let modelAnalysis = null;
    let additionalSignals: Signal[] = [];

    if (this.config.autonomy !== 'observe') {
      const modelSpan = tracer.startSpan('discernment.model');
      try {
        const result = await deps.modelAnalyzer.analyze(systemProfile, signals);
        recommendations = result.recommendations;
        modelAnalysis = result.modelAnalysis;
        if (result.signals) {
          additionalSignals = result.signals;
        }
        modelSpan.setAttribute('discernment.recommendation_count', recommendations.length);
      } finally {
        modelSpan.end();
      }
    }

    for (const rec of recommendations) {
      this.emitEvent('discernment:recommendation', rec);
    }

    // Step 5: Build and store report
    const report: CycleReport = {
      id: `cycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date(),
      autonomy: this.config.autonomy,
      lookbackPeriod,
      systemProfile,
      signals: [...signals, ...additionalSignals],
      recommendations,
      modelAnalysis,
      objectiveSummaries: systemProfile.objectiveSummaries,
    };

    this.storeReport(report);

    // Step 6: Advise mode tracking
    if (this.config.autonomy === 'advise' && recommendations.length > 0) {
      this.lastAdviseCycleId = report.id;
    }

    // Step 7: Enforce mode — arm grace period timers
    if (this.config.autonomy === 'enforce') {
      this.armEnforceTimers(recommendations);
    }

    // Step 8: Emit cycle event
    this.emitEvent('discernment:cycle', report);

    return report;
  }

  private armEnforceTimers(recommendations: Recommendation[]): void {
    if (!this.enforceCallbacks) return;

    const gracePeriodMs = (this.config.gracePeriod ?? 86400) * 1000;

    for (const rec of recommendations) {
      // Only arm for enforceable actions on enforceable flows
      if (!ENFORCEABLE_ACTIONS.has(rec.action)) continue;
      if (rec.targetType !== 'flow') continue;
      if (!this.enforceCallbacks.enforceableFlows.has(rec.target)) continue;

      const timerHandle = setTimeout(() => {
        this.executeEnforceAction(rec);
      }, gracePeriodMs);

      this.pendingActions.set(rec.id, {
        recommendationId: rec.id,
        action: rec.action,
        targetFlowName: rec.target,
        scheduledAt: new Date(Date.now() + gracePeriodMs),
        timerHandle,
      });
    }
  }

  private executeEnforceAction(rec: Recommendation): void {
    if (!this.enforceCallbacks) return;
    // Only execute if still pending
    if (rec.status !== 'pending') return;

    if (rec.action === 'retire') {
      try {
        this.enforceCallbacks.unregister(rec.target);
        rec.status = 'executed';
      } catch {
        // Execution failed — leave as pending
      }
    } else if (rec.action === 'optimize') {
      // TODO: adjust budget when budget adjustment API is available
      rec.status = 'executed';
    }

    this.pendingActions.delete(rec.id);
  }

  private emitEvent(event: string, ...args: unknown[]): void {
    if (this.deps?.emitEvent) {
      try {
        this.deps.emitEvent(event, ...args);
      } catch {
        // Events are best-effort
      }
    }
  }

  // ── Report Storage ──

  storeReport(report: CycleReport): void {
    this.reports.set(report.id, report);

    const recIds: string[] = [];
    for (const rec of report.recommendations) {
      this.recommendations.set(rec.id, rec);
      recIds.push(rec.id);
    }
    this.cycleRecommendations.set(report.id, recIds);
  }

  getReport(id: string): CycleReport | undefined {
    return this.reports.get(id);
  }

  listReports(limit?: number): CycleReport[] {
    const effectiveLimit = Math.min(limit ?? 10, 100);
    const sorted = Array.from(this.reports.values())
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return sorted.slice(0, effectiveLimit);
  }

  pruneReports(): void {
    const retentionMs = (this.config.lookbackPeriod ?? 604800) * 1000 * 4;
    const cutoff = Date.now() - retentionMs;

    for (const [id, report] of this.reports) {
      if (report.timestamp.getTime() < cutoff) {
        const recIds = this.cycleRecommendations.get(id) ?? [];
        for (const recId of recIds) {
          this.recommendations.delete(recId);
        }
        this.cycleRecommendations.delete(id);
        this.reports.delete(id);
      }
    }
  }

  // ── Recommendation Management ──

  getRecommendations(filter?: RecommendationFilter): Recommendation[] {
    if (!filter) return Array.from(this.recommendations.values());

    let candidates: Recommendation[];

    if (filter.cycleId) {
      const recIds = this.cycleRecommendations.get(filter.cycleId) ?? [];
      candidates = recIds
        .map(id => this.recommendations.get(id))
        .filter((r): r is Recommendation => r !== undefined);
    } else {
      candidates = Array.from(this.recommendations.values());
    }

    return candidates.filter(rec => {
      if (filter.targetFlow && (rec.targetType !== 'flow' || rec.target !== filter.targetFlow)) return false;
      if (filter.targetObjective && (rec.targetType !== 'objective' || rec.target !== filter.targetObjective)) return false;
      if (filter.action && rec.action !== filter.action) return false;
      if (filter.status && rec.status !== filter.status) return false;
      return true;
    });
  }

  acknowledgeRecommendation(id: string): void {
    this.transitionRecommendation(id, 'acknowledged');
  }

  dismissRecommendation(id: string): void {
    this.transitionRecommendation(id, 'dismissed');
  }

  overrideRecommendation(id: string, _reason?: string): void {
    // Cancel enforce timer if one exists
    const pending = this.pendingActions.get(id);
    if (pending) {
      clearTimeout(pending.timerHandle);
      this.pendingActions.delete(id);
    }
    this.transitionRecommendation(id, 'overridden');
  }

  private transitionRecommendation(id: string, toStatus: RecommendationStatus): void {
    const rec = this.recommendations.get(id);
    if (!rec) {
      throw new EngineError(
        `Recommendation '${id}' not found`,
        'RECOMMENDATION_NOT_FOUND',
      );
    }
    if (rec.status !== 'pending') {
      throw new EngineError(
        `Cannot transition recommendation from '${rec.status}' to '${toStatus}' — only 'pending' recommendations can be transitioned`,
        'INVALID_RECOMMENDATION_STATUS',
      );
    }
    rec.status = toStatus;
  }

  /** Shutdown — cleanup timers and pending actions */
  shutdown(): void {
    for (const [id, pending] of this.pendingActions) {
      clearTimeout(pending.timerHandle);
    }
    this.pendingActions.clear();
  }
}
