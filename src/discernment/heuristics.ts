// HeuristicAnalyzer — deterministic checks that fire signals

import { EngineError } from '../errors.js';
import type {
  FlowProfile,
  SystemProfile,
  Signal,
  HeuristicThresholds,
  CustomHeuristic,
} from './types.js';

/** Default thresholds for built-in heuristic checks */
const DEFAULT_THRESHOLDS: Required<HeuristicThresholds> = {
  idleFlowDays: 7,
  disproportionateCostPercent: 0.30,
  qualityDeclinePercent: 0.20,
  agentHardStopPercent: 0.50,
};

let idCounter = 0;

function generateId(): string {
  return `sig-${Date.now()}-${++idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Runs deterministic heuristic checks against flow profiles and system profile.
 * Produces Signal[] for conditions that warrant attention.
 */
export class HeuristicAnalyzer {
  private readonly thresholds: Required<HeuristicThresholds>;
  private readonly customHeuristics = new Map<string, CustomHeuristic>();

  constructor(thresholds?: HeuristicThresholds) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /** Run all built-in and custom heuristic checks */
  analyze(flowProfiles: FlowProfile[], systemProfile: SystemProfile): Signal[] {
    const signals: Signal[] = [];
    const now = new Date();

    // Per-flow checks
    for (const profile of flowProfiles) {
      this.checkIdleFlow(profile, signals, now);
      this.checkDisproportionateCost(profile, signals, now);
      this.checkQualityDeclining(profile, signals, now);
      this.checkOrphanFlow(profile, signals, now);
      this.checkAgentHardStopPattern(profile, signals, now);
      this.checkUnusedMcpTool(profile, signals, now);
    }

    // Cross-flow checks
    this.checkScheduleOverlap(flowProfiles, signals, now);
    this.checkAdapterOverlap(flowProfiles, signals, now);

    // System-level checks
    this.checkUnservedObjectives(systemProfile, signals, now);

    // Custom heuristics
    for (const [name, heuristic] of this.customHeuristics) {
      for (const profile of flowProfiles) {
        try {
          const customSignals = heuristic.check(profile, systemProfile);
          signals.push(...customSignals);
        } catch {
          // Custom heuristic error caught — skip, other heuristics continue
        }
      }
    }

    return signals;
  }

  /** Register a custom heuristic check */
  addHeuristic(heuristic: CustomHeuristic): void {
    if (this.customHeuristics.has(heuristic.name)) {
      throw new EngineError(
        `Custom heuristic '${heuristic.name}' is already registered`,
        'DUPLICATE_HEURISTIC',
      );
    }
    this.customHeuristics.set(heuristic.name, heuristic);
  }

  /** Remove a custom heuristic check */
  removeHeuristic(name: string): void {
    this.customHeuristics.delete(name);
  }

  // ── Built-in checks ──

  private checkIdleFlow(profile: FlowProfile, signals: Signal[], now: Date): void {
    if (profile.execution.totalExecutions === 0) {
      signals.push({
        id: generateId(),
        checkName: 'idle-flow',
        target: profile.flowName,
        targetType: 'flow',
        severity: 'warning',
        evidence: { totalExecutions: 0 },
        timestamp: now,
      });
    }
  }

  private checkDisproportionateCost(profile: FlowProfile, signals: Signal[], now: Date): void {
    if (profile.cost.costPercentOfTotal > this.thresholds.disproportionateCostPercent) {
      signals.push({
        id: generateId(),
        checkName: 'disproportionate-cost',
        target: profile.flowName,
        targetType: 'flow',
        severity: 'warning',
        evidence: {
          costPercentOfTotal: profile.cost.costPercentOfTotal,
          threshold: this.thresholds.disproportionateCostPercent,
          totalCost: profile.cost.totalCost,
        },
        timestamp: now,
      });
    }
  }

  private checkQualityDeclining(profile: FlowProfile, signals: Signal[], now: Date): void {
    if (profile.quality.scoreTrend === 'declining') {
      signals.push({
        id: generateId(),
        checkName: 'quality-declining',
        target: profile.flowName,
        targetType: 'flow',
        severity: 'warning',
        evidence: {
          averageScore: profile.quality.averageScore,
          scoreTrend: profile.quality.scoreTrend,
        },
        timestamp: now,
      });
    }
  }

  private checkOrphanFlow(profile: FlowProfile, signals: Signal[], now: Date): void {
    if (!profile.objective) {
      signals.push({
        id: generateId(),
        checkName: 'orphan-flow',
        target: profile.flowName,
        targetType: 'flow',
        severity: 'info',
        evidence: {},
        timestamp: now,
      });
    }
  }

  private checkAgentHardStopPattern(profile: FlowProfile, signals: Signal[], now: Date): void {
    if (!profile.agent) return;
    if (profile.agent.hardStopRate > this.thresholds.agentHardStopPercent) {
      signals.push({
        id: generateId(),
        checkName: 'agent-hard-stop-pattern',
        target: profile.flowName,
        targetType: 'flow',
        severity: 'critical',
        evidence: {
          hardStopRate: profile.agent.hardStopRate,
          threshold: this.thresholds.agentHardStopPercent,
          averageIterations: profile.agent.averageIterations,
        },
        timestamp: now,
      });
    }
  }

  private checkUnusedMcpTool(profile: FlowProfile, signals: Signal[], now: Date): void {
    if (profile.mcpServer && profile.mcpServer.externalInvocationCount === 0) {
      signals.push({
        id: generateId(),
        checkName: 'unused-mcp-tool',
        target: profile.flowName,
        targetType: 'flow',
        severity: 'info',
        evidence: { externalInvocationCount: 0 },
        timestamp: now,
      });
    }
  }

  private checkScheduleOverlap(profiles: FlowProfile[], signals: Signal[], now: Date): void {
    const scheduled = profiles.filter(p => p.schedule);
    const seen = new Set<string>();

    for (let i = 0; i < scheduled.length; i++) {
      for (let j = i + 1; j < scheduled.length; j++) {
        const a = scheduled[i];
        const b = scheduled[j];
        const key = [a.flowName, b.flowName].sort().join(':');
        if (seen.has(key)) continue;

        if (a.schedule!.cronExpression === b.schedule!.cronExpression) {
          // Check shared adapter tools
          const aTools = new Set(a.adapter.toolsUsed);
          const bTools = new Set(b.adapter.toolsUsed);
          const shared = [...aTools].filter(t => bTools.has(t));

          if (shared.length > 0) {
            seen.add(key);
            signals.push({
              id: generateId(),
              checkName: 'schedule-overlap',
              target: `${a.flowName},${b.flowName}`,
              targetType: 'flow',
              severity: 'info',
              evidence: {
                cronExpression: a.schedule!.cronExpression,
                sharedTools: shared,
                flows: [a.flowName, b.flowName],
              },
              timestamp: now,
            });
          }
        }
      }
    }
  }

  private checkAdapterOverlap(profiles: FlowProfile[], signals: Signal[], now: Date): void {
    // Only non-scheduled flows
    const unscheduled = profiles.filter(p => !p.schedule && p.adapter.toolsUsed.length > 0);
    const seen = new Set<string>();

    for (let i = 0; i < unscheduled.length; i++) {
      for (let j = i + 1; j < unscheduled.length; j++) {
        const a = unscheduled[i];
        const b = unscheduled[j];
        const key = [a.flowName, b.flowName].sort().join(':');
        if (seen.has(key)) continue;

        const aTools = new Set(a.adapter.toolsUsed);
        const bTools = new Set(b.adapter.toolsUsed);
        const shared = [...aTools].filter(t => bTools.has(t));
        const unionSize = new Set([...aTools, ...bTools]).size;

        if (unionSize > 0 && shared.length / unionSize > 0.5) {
          seen.add(key);
          signals.push({
            id: generateId(),
            checkName: 'adapter-overlap',
            target: `${a.flowName},${b.flowName}`,
            targetType: 'flow',
            severity: 'info',
            evidence: {
              sharedTools: shared,
              overlapRatio: shared.length / unionSize,
              flows: [a.flowName, b.flowName],
            },
            timestamp: now,
          });
        }
      }
    }
  }

  private checkUnservedObjectives(systemProfile: SystemProfile, signals: Signal[], now: Date): void {
    for (const objectiveName of systemProfile.unservedObjectives) {
      signals.push({
        id: generateId(),
        checkName: 'unserved-objective',
        target: objectiveName,
        targetType: 'objective',
        severity: 'info',
        evidence: { flowCount: 0 },
        timestamp: now,
      });
    }
  }
}
