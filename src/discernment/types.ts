// Discernment subsystem type definitions

// ── Autonomy Levels ──

/** Controls how far discernment goes in acting on its analysis */
export type AutonomyLevel = 'observe' | 'recommend' | 'advise' | 'enforce';

// ── Objectives ──

/** Declaration input for creating a business objective */
export interface ObjectiveDeclaration {
  /** Unique identifier, max 128 chars */
  name: string;
  /** Human-readable purpose */
  description: string;
}

/** A declared business objective with its associated flows */
export interface Objective {
  name: string;
  description: string;
  /** Flow names with this as primary objective */
  primaryFlows: string[];
  /** Flow names with this as secondary objective */
  secondaryFlows: string[];
}

// ── Flow Tagging ──

/** The association between a flow and its objectives, with optional metadata */
export interface FlowTag {
  flowName: string;
  /** Must reference a declared Objective */
  primaryObjective: string;
  /** Each must reference a declared Objective */
  secondaryObjectives: string[];
  /** e.g., 'daily', 'hourly', 'weekly' */
  expectedCadence: string | null;
  /** Business purpose of this flow */
  purpose: string | null;
  /** Opt-in for enforce mode auto-execution */
  enforceable: boolean;
}

// ── Signal Sub-types ──

export interface CostSignals {
  /** Absolute cost in lookback period */
  totalCost: number;
  costTrend: 'increasing' | 'decreasing' | 'stable';
  /** 0.0–1.0 */
  costPercentOfTotal: number;
  requestCount: number;
}

export interface QualitySignals {
  /** Null if no evaluations */
  averageScore: number | null;
  scoreTrend: 'improving' | 'declining' | 'stable' | null;
  humanReviewFlagCount: number;
  evaluationCount: number;
}

export interface ExecutionSignals {
  totalExecutions: number;
  completeCount: number;
  failedCount: number;
  timeoutCount: number;
  waitingCount: number;
  resumeCount: number;
  /** 0.0–1.0 */
  successRate: number;
}

export interface PolicySignals {
  violationCount: number;
  /** ruleName → count */
  violationTypes: Record<string, number>;
  rateLimitHitCount: number;
}

export interface AgentSignals {
  averageIterations: number;
  /** 0.0–1.0 (fraction hitting max iterations or budget exhausted) */
  hardStopRate: number;
  /** stopReason → count */
  stopReasonDistribution: Record<string, number>;
}

export interface ProviderSignals {
  /** providerName → request count */
  providerDistribution: Record<string, number>;
  /** 0.0–1.0 */
  fallbackFrequency: number;
}

export interface ScheduleSignals {
  cronExpression: string;
  lastFiredAt: Date | null;
  nextFireTime: Date;
  /** Other flows with same cadence + adapters */
  overlapFlows: string[];
}

export interface AdapterSignals {
  /** Adapter names */
  adaptersUsed: string[];
  /** Qualified tool names */
  toolsUsed: string[];
  toolCallCount: number;
}

export interface MemorySignals {
  /** Number of active memory scopes for this flow */
  activeScopeCount: number;
  /** Names of the active scopes */
  scopeNames: string[];
}

export interface McpServerSignals {
  externalInvocationCount: number;
}

// ── Flow Profile ──

/** Aggregated view of a single flow's operational signals collected during one cycle */
export interface FlowProfile {
  flowName: string;
  cost: CostSignals;
  quality: QualitySignals;
  execution: ExecutionSignals;
  policy: PolicySignals;
  /** Null for non-agent flows */
  agent: AgentSignals | null;
  provider: ProviderSignals;
  /** Null for unscheduled flows */
  schedule: ScheduleSignals | null;
  adapter: AdapterSignals;
  memory: MemorySignals;
  /** Null if not exposed via MCP server */
  mcpServer: McpServerSignals | null;
  /** Primary objective (null if untagged / orphan) */
  objective: string | null;
  /** Secondary objectives (empty if none) */
  secondaryObjectives: string[];
}

// ── System Profile ──

/** Per-objective aggregate */
export interface ObjectiveSummary {
  objectiveName: string;
  description: string;
  flowCount: number;
  totalCost: number;
  averageQuality: number | null;
  totalExecutions: number;
  /** All flows (primary + secondary) for this objective */
  flowNames: string[];
  /** Flows with this as primary objective */
  primaryFlowNames: string[];
  /** Flows with this as secondary objective */
  secondaryFlowNames: string[];
}

/** Aggregation of all flow profiles grouped by objective */
export interface SystemProfile {
  timestamp: Date;
  /** Time window for signal collection, in seconds */
  lookbackPeriod: number;
  flowProfiles: FlowProfile[];
  objectiveSummaries: ObjectiveSummary[];
  /** Flows not tagged to any objective */
  orphanFlows: string[];
  /** Objectives with no flows */
  unservedObjectives: string[];
  /** Engine-wide cost in lookback period */
  totalCost: number;
  /** Engine-wide execution count */
  totalExecutions: number;
}

// ── Signals ──

/** A fired heuristic check result */
export interface Signal {
  /** Unique signal identifier (UUID) */
  id: string;
  /** e.g., 'idle-flow', 'disproportionate-cost' */
  checkName: string;
  /** Flow name, objective name, or 'system' */
  target: string;
  targetType: 'flow' | 'objective' | 'system';
  severity: 'info' | 'warning' | 'critical';
  /** Specific metrics that triggered the check */
  evidence: Record<string, unknown>;
  timestamp: Date;
}

// ── Recommendations ──

export type RecommendationAction = 'keep' | 'optimize' | 'merge' | 'retire' | 'investigate' | 'escalate';
export type RecommendationStatus = 'pending' | 'acknowledged' | 'dismissed' | 'overridden' | 'executed';

/** An actionable suggestion from model-based analysis */
export interface Recommendation {
  /** Unique recommendation identifier (UUID) */
  id: string;
  /** Flow name, objective name, or 'system' */
  target: string;
  targetType: 'flow' | 'objective' | 'system';
  action: RecommendationAction;
  /** 0.0–1.0 */
  confidence: number;
  /** Plain-language reasoning citing evidence */
  explanation: string;
  /** Signal IDs that support this recommendation */
  evidenceRefs: string[];
  status: RecommendationStatus;
  createdAt: Date;
}

/** Filter for querying recommendations */
export interface RecommendationFilter {
  targetFlow?: string;
  targetObjective?: string;
  action?: RecommendationAction;
  status?: RecommendationStatus;
  cycleId?: string;
}

// ── Cycle Report ──

/** Result metadata for the model call */
export interface ModelAnalysisResult {
  provider: string;
  model: string;
  cost: number;
  success: boolean;
  /** Populated on parsing failure or model error */
  error: string | null;
}

/** The complete output of a discernment cycle */
export interface CycleReport {
  /** Unique cycle identifier (UUID) */
  id: string;
  timestamp: Date;
  autonomy: AutonomyLevel;
  /** Time window used, in seconds */
  lookbackPeriod: number;
  systemProfile: SystemProfile;
  /** All heuristic signals that fired */
  signals: Signal[];
  /** Model-based recommendations (empty if observe mode) */
  recommendations: Recommendation[];
  /** Null if observe mode or model call skipped */
  modelAnalysis: ModelAnalysisResult | null;
  /** Per-objective rollups */
  objectiveSummaries: ObjectiveSummary[];
}

// ── Pending Action (enforce mode) ──

/** An auto-execution timer for an enforce-mode recommendation */
export interface PendingAction {
  recommendationId: string;
  action: RecommendationAction;
  targetFlowName: string;
  scheduledAt: Date;
  timerHandle: ReturnType<typeof setTimeout>;
}

// ── Configuration ──

/** Configurable thresholds for heuristic checks */
export interface HeuristicThresholds {
  /** Default: lookbackPeriod */
  idleFlowDays?: number;
  /** Default: 0.30 (30%) */
  disproportionateCostPercent?: number;
  /** Default: 0.20 (20%) */
  qualityDeclinePercent?: number;
  /** Default: 0.50 (50%) */
  agentHardStopPercent?: number;
}

/** Discernment subsystem configuration */
export interface DiscernmentConfig {
  enabled: boolean;
  autonomy: AutonomyLevel;
  /** 'daily' | 'hourly' | 'weekly' | cron expression */
  schedule: string;
  /** Override model routing to specific provider */
  provider?: string;
  /** Seconds. Default: 604800 (7 days) */
  lookbackPeriod?: number;
  /** Seconds. Default: 86400 (24 hours) for enforce mode */
  gracePeriod?: number;
  /** Custom analysis prompt (replaces default) */
  prompt?: string;
  thresholds?: HeuristicThresholds;
  objectives?: ObjectiveDeclaration[];
}

// ── Custom Heuristic ──

/** User-defined heuristic check */
export interface CustomHeuristic {
  name: string;
  check: (profile: FlowProfile, systemProfile: SystemProfile) => Signal[];
}
