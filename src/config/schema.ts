// TypeScript interfaces for the runcor.yaml config file structure

/** Root YAML document structure. All sections are optional. */
export interface RuncorConfigFile {
  engine?: EngineEntry;
  providers?: ProviderEntry[];
  routing?: RoutingEntry;
  connections?: ConnectionEntry[];
  costs?: CostsEntry;
  telemetry?: TelemetryEntry;
  policy?: PolicyEntry;
  evaluation?: EvaluationEntry;
  server?: ServerEntry;
  httpServer?: HttpServerEntry;
  scheduler?: SchedulerEntry;
  state?: StateEntry;
  discernment?: DiscernmentEntry;
  objectives?: ObjectiveEntry[];
}

/** Valid top-level keys in runcor.yaml */
export const VALID_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'engine',
  'providers',
  'routing',
  'connections',
  'costs',
  'telemetry',
  'policy',
  'evaluation',
  'server',
  'httpServer',
  'scheduler',
  'state',
  'discernment',
  'objectives',
]);

/** Engine-level settings */
export interface EngineEntry {
  concurrency?: number;
  drainTimeout?: number;
  retentionPeriod?: number;
}

/** Model provider declaration */
export interface ProviderEntry {
  type: string;
  apiKey?: string;
  baseUrl?: string;
  priority?: number;
  models?: string[];
  costPerToken?: { input: number; output: number };
}

/** Built-in provider type identifiers */
export const VALID_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  'anthropic',
  'openai',
  'google',
  'ollama',
  'mock',
]);

/** Model routing configuration */
export interface RoutingEntry {
  strategy?: string;
  maxFallbackAttempts?: number;
  failureThreshold?: number;
  cooldownMs?: number;
}

/** Valid routing strategies */
export const VALID_STRATEGIES: ReadonlySet<string> = new Set([
  'priority',
  'round-robin',
  'lowest-cost',
]);

/** External system connection (MCP adapter) */
export interface ConnectionEntry {
  name: string;
  preset?: string;
  transport?: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  healthCheckIntervalMs?: number;
}

/** Valid transport types */
export const VALID_TRANSPORTS: ReadonlySet<string> = new Set(['stdio', 'sse']);

/** Valid connection presets */
export const VALID_PRESETS: ReadonlySet<string> = new Set([
  'gmail',
  'slack',
  'calendar',
]);

/** Cost tracking configuration */
export interface CostsEntry {
  warningThreshold?: number;
  defaultTokenEstimate?: number;
  maxLedgerEntries?: number;
  budgets?: BudgetsEntry;
}

/** Budget scope configurations */
export interface BudgetsEntry {
  perRequest?: BudgetEntry;
  perUser?: BudgetEntry;
  perFlow?: BudgetEntry;
  global?: BudgetEntry;
}

/** Single budget scope */
export interface BudgetEntry {
  limit: number;
  enforcement?: string;
  window?: WindowEntry;
}

/** Valid enforcement modes */
export const VALID_ENFORCEMENTS: ReadonlySet<string> = new Set([
  'hard',
  'soft',
  'disabled',
]);

/** Time window for budget */
export interface WindowEntry {
  type: string;
  durationMs?: number;
}

/** Valid window types */
export const VALID_WINDOW_TYPES: ReadonlySet<string> = new Set([
  'hourly',
  'daily',
  'monthly',
  'custom',
  'none',
]);

/** Telemetry configuration */
export interface TelemetryEntry {
  serviceName?: string;
  serviceVersion?: string;
  memorySpans?: boolean;
}

/** Policy configuration */
export interface PolicyEntry {
  rateLimits?: RateLimitEntry[];
  accessPolicies?: AccessPolicyEntry[];
  tenants?: TenantEntry[];
}

/** Rate limit rule */
export interface RateLimitEntry {
  name: string;
  scope: string;
  limit: number;
  windowMs: number;
  behavior?: string;
  maxQueueDepth?: number;
  queueTimeoutMs?: number;
  flowName?: string;
}

/** Valid rate limit scopes */
export const VALID_SCOPES: ReadonlySet<string> = new Set([
  'user',
  'flow',
  'global',
]);

/** Valid rate limit behaviors */
export const VALID_BEHAVIORS: ReadonlySet<string> = new Set([
  'reject',
  'queue',
]);

/** Access control policy */
export interface AccessPolicyEntry {
  identity: string;
  allowedFlows?: string[];
  deniedFlows?: string[];
  allowedOperations?: string[];
  deniedOperations?: string[];
}

/** Valid operations for access policies */
export const VALID_OPERATIONS: ReadonlySet<string> = new Set([
  'trigger',
  'resume',
  'replay',
  'listWaiting',
]);

/** Tenant-scoped configuration */
export interface TenantEntry {
  tenantId: string;
  rateLimits?: RateLimitEntry[];
  allowedFlows?: string[];
  accessPolicies?: AccessPolicyEntry[];
}

/** Evaluation configuration */
export interface EvaluationEntry {
  evaluators?: EvaluatorEntry[];
  autoFlagScoreThreshold?: number;
}

/** Built-in evaluator declaration */
export interface EvaluatorEntry {
  type: string;
  name?: string;
  weight?: number;
  config?: Record<string, unknown>;
}

/** Valid evaluator types */
export const VALID_EVALUATOR_TYPES: ReadonlySet<string> = new Set([
  'length',
  'format',
  'keyword',
]);

/** MCP server configuration */
export interface ServerEntry {
  enabled?: boolean;
  name?: string;
  version?: string;
}

/** HTTP REST server configuration (distinct from MCP server) */
export interface HttpServerEntry {
  enabled?: boolean;
  port?: number;
  hostname?: string;
  cors?: boolean;
}

/** Scheduler configuration from YAML */
export interface SchedulerEntry {
  defaultTimezone?: string;
}

/** State backend configuration */
export interface StateEntry {
  type?: string;
  path?: string;
}

/** Valid state backend types */
export const VALID_STATE_TYPES: ReadonlySet<string> = new Set(['memory', 'sqlite']);

/** Discernment subsystem configuration */
export interface DiscernmentEntry {
  enabled?: boolean;
  autonomy?: string;
  schedule?: string;
  provider?: string;
  lookbackPeriod?: number;
  gracePeriod?: number;
  prompt?: string;
  thresholds?: ThresholdsEntry;
}

/** Heuristic threshold overrides */
export interface ThresholdsEntry {
  idleFlowDays?: number;
  disproportionateCostPercent?: number;
  qualityDeclinePercent?: number;
  agentHardStopPercent?: number;
}

/** Business objective declaration */
export interface ObjectiveEntry {
  name: string;
  description: string;
}

/** Valid autonomy levels */
export const VALID_AUTONOMY_LEVELS: ReadonlySet<string> = new Set([
  'observe',
  'recommend',
  'advise',
  'enforce',
]);
