// Shared types for the Runcor runtime

import type { ModelProvider, ModelRequest } from './model/provider.js';

// ── Structured Output Types ──

/** A JSON Schema object (draft-07). */
export type JsonSchema = Record<string, unknown>;

/** Format hint for model responses: plain text, any JSON, or JSON matching a schema */
export type ResponseFormat = 'text' | 'json' | JsonSchema;

/** Event payload: emitted per validation retry attempt */
export interface ValidationRetryEvent {
  /** Which retry attempt (1 or 2) */
  attempt: number;
  /** Validation errors from the failed attempt */
  errors: import('./errors.js').ValidationErrorDetail[];
  /** The raw text that failed validation */
  rawText: string;
  /** Execution ID if available */
  executionId?: string;
  /** Flow name if available */
  flowName?: string;
}

// ── End Structured Output Types ──
import type { TracerProvider, MeterProvider, Span } from '@opentelemetry/api';
import type { MCPServerConfig } from './server/types.js';
import type { Execution } from './execution.js';
import type { DiscernmentConfig } from './discernment/types.js';

// ── Telemetry Types ──

/** Severity levels for structured logs */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured log entry passed to the LogHandler callback */
export interface LogRecord {
  level: LogLevel;
  message: string;
  attributes: Record<string, unknown>;
  traceId: string | null;
  spanId: string | null;
  timestamp: Date;
}

/** Callback interface for structured logging */
export type LogHandler = (record: LogRecord) => void;

/** Engine-level configuration for observability */
export interface TelemetryConfig {
  /** OTel TracerProvider for creating tracers */
  tracerProvider?: TracerProvider;
  /** OTel MeterProvider for creating meters */
  meterProvider?: MeterProvider;
  /** Callback for structured log records */
  logHandler?: LogHandler;
  /** Service name for tracer/meter identity. Default: "runcor" */
  serviceName?: string;
  /** Service version for tracer/meter identity. Default: package version */
  serviceVersion?: string;
  /** Enable spans for memory operations (debug). Default: false */
  memorySpans?: boolean;
}

/** Read-write interface exposed to flows via ctx.telemetry */
export interface TelemetryAccessor {
  /** The active execution span. Returns a no-op span when telemetry is not configured. */
  readonly activeSpan: Span;
  /** Add a custom attribute to the execution span. */
  setAttribute(key: string, value: string | number | boolean): void;
  /** Add a timestamped event to the execution span. */
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  /** Create a child span, execute the callback within it, and end the span. */
  startSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T>;
}

// ── End Telemetry Types ──

// ── Routing Types ──

/** Circuit breaker health states */
export type HealthState = 'healthy' | 'unhealthy' | 'half_open';

/** Static cost metadata for a provider */
export interface CostPerToken {
  /** Cost per input token (arbitrary units) */
  input: number;
  /** Cost per output token (arbitrary units) */
  output: number;
}

/** Configuration for registering a single provider */
export interface ProviderConfig {
  /** The provider instance */
  provider: ModelProvider;
  /** Routing priority (lower = higher priority, >= 1). Default: 1 */
  priority?: number;
  /** Input/output token costs for lowest-cost strategy */
  costPerToken?: CostPerToken;
  /** List of supported model identifiers */
  models?: string[];
}

/** A model provider registered with the engine, with resolved routing metadata */
export interface ProviderRegistration {
  /** Unique identifier (from provider.name) */
  name: string;
  /** The provider instance */
  provider: ModelProvider;
  /** Routing priority (lower = higher priority, min 1) */
  priority: number;
  /** Input/output token costs for lowest-cost strategy */
  costPerToken: CostPerToken | null;
  /** List of supported model identifiers */
  models: string[] | null;
}

/** A function that orders providers by preference for a given request */
export type RoutingStrategy = (
  providers: ProviderRegistration[],
  request: ModelRequest,
) => ProviderRegistration[];

/** Configuration for the model router, part of EngineConfig */
export interface RouterConfig {
  providers: ProviderConfig[];
  strategy?: RoutingStrategy | 'priority' | 'round-robin' | 'lowest-cost';
  maxFallbackAttempts?: number;
  failureThreshold?: number;
  cooldownMs?: number;
}

// ── End Routing Types ──

// ── Cost Tracking Types ──

/** A single cost record for one completed model request */
export interface CostEntry {
  /** Unique identifier (UUID) */
  id: string;
  /** When the request completed */
  timestamp: Date;
  /** Provider name that handled the request */
  provider: string;
  /** Model identifier from the response */
  model: string;
  /** Input token count from response.usage */
  promptTokens: number;
  /** Output token count from response.usage */
  completionTokens: number;
  /** Calculated cost in arbitrary units */
  cost: number;
  /** Execution that made the request */
  executionId: string;
  /** Flow that owns the execution */
  flowName: string;
  /** User ID if provided in trigger options */
  userId: string | null;
}

/** Time window configuration for budget accumulation */
export interface BudgetWindow {
  type: 'hourly' | 'daily' | 'monthly' | 'custom' | 'none';
  /** Required when type = 'custom' */
  durationMs?: number;
}

/** Budget configuration for a single scope */
export interface BudgetScopeConfig {
  /** Maximum cost units allowed within the time window */
  limit: number;
  /** How the budget is enforced. Default: 'hard' */
  enforcement?: 'hard' | 'soft' | 'disabled';
  /** Time window for accumulation. Default: { type: 'none' } for perRequest, { type: 'daily' } for others */
  window?: BudgetWindow;
}

/** Query filter for cost ledger entries */
export interface CostQueryFilter {
  userId?: string;
  flowName?: string;
  executionId?: string;
  startTime?: Date;
  endTime?: Date;
}

/** Pluggable storage backend for cost entries */
export interface CostLedgerStore {
  /** Record a new cost entry */
  record(entry: CostEntry): void;
  /** Query entries by filter criteria */
  query(filter: CostQueryFilter): CostEntry[];
  /** Get aggregated cost total for a filter */
  getTotal(filter: CostQueryFilter): number;
  /** Get current entry count */
  getCount(): number;
}

/** Read-only cost info exposed to flows via ctx.cost */
export interface CostAccessor {
  /** Total cost accumulated by the current execution */
  readonly executionTotal: number;
  /** Number of model requests made in this execution */
  readonly requestCount: number;
}

/** Cost configuration (part of EngineConfig) */
export interface CostConfig {
  budgets?: {
    perRequest?: BudgetScopeConfig;
    perUser?: BudgetScopeConfig;
    perFlow?: BudgetScopeConfig;
    global?: BudgetScopeConfig;
  };
  /** Warning threshold as fraction 0-1. Default: 0.8 */
  warningThreshold?: number;
  /** Default token estimate when maxTokens not in request. Default: 1000 */
  defaultTokenEstimate?: number;
  /** Maximum ledger entries before FIFO eviction. Default: 100000 */
  maxLedgerEntries?: number;
  /** Custom ledger backend. Default: InMemoryCostLedger */
  ledgerStore?: CostLedgerStore;
}

/** Event payload: emitted after every completed model request */
export interface CostRequestEvent {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  executionId: string;
  flowName: string;
  userId: string | null;
  timestamp: Date;
}

/** Event payload: emitted when spend reaches warning threshold */
export interface CostBudgetWarningEvent {
  scope: 'user' | 'flow' | 'global';
  scopeKey: string;
  currentSpend: number;
  limit: number;
  warningThreshold: number;
  utilizationPercent: number;
  timestamp: Date;
}

/** Event payload: emitted when any budget limit is reached */
export interface CostBudgetExceededEvent {
  scope: 'request' | 'user' | 'flow' | 'global';
  scopeKey: string;
  currentSpend: number;
  limit: number;
  enforcement: 'hard' | 'soft';
  blocked: boolean;
  timestamp: Date;
}

// ── End Cost Tracking Types ──

// ── Policy Types ──

/** Operations that policy rules can gate */
export type OperationType = 'trigger' | 'resume' | 'replay' | 'listWaiting';

/** Context passed to policy rule evaluation functions */
export interface PolicyContext {
  /** Which operation is being evaluated */
  operation: OperationType;
  /** Target flow name */
  flowName: string;
  /** User identity */
  userId: string | null;
  /** Resolved tenant identity */
  tenantId: string | null;
  /** Operation input (trigger input, resumeData, etc.) */
  input: unknown;
  /** Execution ID (null for trigger, present for resume/replay) */
  executionId: string | null;
  /** Additional metadata from TriggerOptions */
  metadata: Record<string, unknown>;
}

/** Result of a policy rule evaluation */
export interface PolicyDecision {
  /** The decision action */
  action: 'allow' | 'deny' | 'modify';
  /** Reason for the decision (required for deny, optional for allow/modify) */
  reason: string | null;
  /** Modified input (required when action is 'modify', ignored otherwise) */
  modifiedInput?: unknown;
}

/** Declarative rule that gates engine operations */
export interface PolicyRule {
  /** Unique rule name */
  name: string;
  /** Evaluation priority (lower = evaluated first). Default: 100 */
  priority: number;
  /** Which operations this rule applies to (non-empty) */
  operations: OperationType[];
  /** Synchronous evaluation function */
  evaluate: (context: PolicyContext) => PolicyDecision;
}

/** Context passed to guardrail handlers */
export interface GuardrailContext {
  /** The execution being evaluated */
  executionId: string;
  /** The flow being executed */
  flowName: string;
  /** User who triggered the operation */
  userId: string | null;
  /** Resolved tenant identity */
  tenantId: string | null;
  /** Which phase is being evaluated */
  phase: 'input' | 'output';
}

/** Result returned by a guardrail handler */
export interface GuardrailResult {
  /** The action taken */
  action: 'pass' | 'block' | 'warn' | 'transform';
  /** Description of why action was taken */
  reason: string | null;
  /** Transformed content (required when action is 'transform') */
  transformedContent?: unknown;
}

/** Content inspection policy with phase and mode */
export interface Guardrail {
  /** Unique guardrail name */
  name: string;
  /** Which phase this guardrail runs in */
  phase: 'input' | 'output';
  /** Intended behavior mode. Default: 'block' */
  mode: 'block' | 'warn' | 'transform';
  /** Evaluation priority (lower = evaluated first). Default: 100 */
  priority: number;
  /** Async handler that inspects content */
  handler: (content: unknown, context: GuardrailContext) => Promise<GuardrailResult>;
  /** Behavior when handler throws. Default: 'block' */
  failureMode?: 'block' | 'pass';
  /** Flow name filter (null = applies to all flows) */
  flowName?: string | null;
}

/** Configuration for a single rate limit scope */
export interface RateLimitConfig {
  /** Unique rate limit name */
  name: string;
  /** Rate limit scope */
  scope: 'user' | 'flow' | 'global';
  /** Max requests per window (must be > 0) */
  limit: number;
  /** Time window in milliseconds (must be > 0) */
  windowMs: number;
  /** Behavior when limit exceeded. Default: 'reject' */
  behavior?: 'reject' | 'queue';
  /** Max queued requests when behavior is 'queue'. Default: 100 */
  maxQueueDepth?: number;
  /** Queue timeout in ms when behavior is 'queue'. Default: 30000 */
  queueTimeoutMs?: number;
  /** Flow name filter (null = separate counter per flow). Only meaningful for scope 'flow' */
  flowName?: string | null;
}

/** Rate limit counter entry (persisted in StateStore) */
export interface RateLimitEntry {
  /** Rate limit key (ratelimit:{scope}:{identifier}) */
  key: string;
  /** Array of request timestamps within the sliding window */
  timestamps: number[];
}

/** A queued request waiting for rate limit capacity (ephemeral, in-memory) */
export interface RateLimitQueueEntry {
  /** Promise resolve callback */
  resolve: () => void;
  /** Promise reject callback */
  reject: (error: Error) => void;
  /** Queue timeout timer */
  timer: ReturnType<typeof setTimeout>;
  /** Timestamp of enqueue for FIFO ordering */
  enqueuedAt: number;
}

/** Identity-based access control for operations and flows */
export interface AccessPolicy {
  /** User or tenant identifier. '*' for wildcard default */
  identity: string;
  /** Allowed flows (null = all flows allowed) */
  allowedFlows?: string[] | null;
  /** Denied flows (null = no flows denied). Deny takes precedence over allow */
  deniedFlows?: string[] | null;
  /** Allowed operations (null = all operations allowed) */
  allowedOperations?: OperationType[] | null;
  /** Denied operations (null = no operations denied) */
  deniedOperations?: OperationType[] | null;
}

/** Per-tenant guardrail mode override */
export interface GuardrailOverride {
  /** Must match an existing guardrail name */
  guardrailName: string;
  /** Override mode for this tenant */
  mode: 'block' | 'warn' | 'transform';
}

/** Isolated configuration scope for a tenant */
export interface TenantConfig {
  /** Tenant identifier (unique) */
  tenantId: string;
  /** Override engine rate limits for this tenant */
  rateLimits?: RateLimitConfig[] | null;
  /** Restrict which flows this tenant can trigger */
  allowedFlows?: string[] | null;
  /** Per-guardrail mode overrides */
  guardrailOverrides?: GuardrailOverride[] | null;
  /** Tenant-scoped access policies */
  accessPolicies?: AccessPolicy[] | null;
}

/** Top-level policy configuration for the engine */
export interface PolicyConfig {
  /** Initial policy rules */
  rules?: PolicyRule[];
  /** Initial guardrails */
  guardrails?: Guardrail[];
  /** Initial rate limits */
  rateLimits?: RateLimitConfig[];
  /** Initial access policies */
  accessPolicies?: AccessPolicy[];
  /** Initial tenant configurations */
  tenants?: TenantConfig[];
}

// ── End Policy Types ──

// ── Evaluation Types ──

/** Confidence level derived from score thresholds */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

/** Human review flag lifecycle status */
export type FlagStatus = 'pending' | 'reviewed' | 'resolved';

/** Configurable thresholds for confidence level derivation */
export interface ConfidenceThresholds {
  /** Minimum aggregate score for "high" confidence. Default: 0.8 */
  high: number;
  /** Minimum aggregate score for "medium" confidence. Default: 0.5 */
  medium: number;
}

/** Context provided to evaluator functions */
export interface EvalContext {
  /** ID of the completed execution */
  executionId: string;
  /** Name of the flow that executed */
  flowName: string;
  /** Original flow input */
  input: unknown;
  /** Flow execution result */
  output: unknown;
  /** User who triggered the execution */
  userId: string | null;
  /** Resolved tenant ID */
  tenantId: string | null;
  /** Execution duration in milliseconds */
  duration: number;
  /** Terminal execution state */
  state: 'complete' | 'failed';
  /** Error info if state is 'failed' */
  error: ExecutionError | null;
  /** Additional execution metadata */
  metadata: Record<string, unknown>;
}

/** Structured output from an evaluator function */
export interface EvalResult {
  /** Dimension name -> score (0.0-1.0) */
  scores: Record<string, number>;
  /** Arbitrary classification labels */
  labels?: string[];
  /** Optional textual feedback */
  feedback?: string | null;
}

/** Registered evaluation function */
export interface Evaluator {
  /** Unique identifier */
  name: string;
  /** Execution order (lower = first). Default: 100 */
  priority: number;
  /** Target flows (null = all flows) */
  flowNames?: string[] | null;
  /** Per-evaluator timeout in ms. Default: 30000 */
  timeoutMs?: number;
  /** Custom confidence thresholds (null = defaults) */
  thresholds?: ConfidenceThresholds | null;
  /** The evaluation function (sync or async) */
  evaluate: (context: EvalContext) => EvalResult | Promise<EvalResult>;
}

/** Individual evaluator result within an EvalRecord */
export interface EvaluatorResultEntry {
  /** Name of the evaluator that produced this */
  evaluatorName: string;
  /** Per-dimension scores from this evaluator */
  scores: Record<string, number>;
  /** Labels from this evaluator */
  labels: string[];
  /** Feedback text from this evaluator */
  feedback: string | null;
  /** Confidence for this evaluator */
  confidence: ConfidenceLevel;
  /** How long this evaluator took in ms */
  durationMs: number;
}

/** Failed evaluator info within an EvalRecord */
export interface EvalErrorEntry {
  /** Name of the evaluator that failed */
  evaluatorName: string;
  /** Error message */
  error: string;
  /** Whether the failure was a timeout */
  timedOut: boolean;
}

/** Persisted evaluation record for a completed execution */
export interface EvalRecord {
  /** References the evaluated execution */
  executionId: string;
  /** Flow name (denormalized for querying) */
  flowName: string;
  /** When evaluation completed */
  timestamp: Date;
  /** Individual evaluator results */
  evaluatorResults: EvaluatorResultEntry[];
  /** Averaged scores per dimension */
  aggregateScores: Record<string, number>;
  /** Mean of all aggregate dimension scores */
  overallScore: number;
  /** Derived from overallScore + thresholds */
  confidence: ConfidenceLevel;
  /** Union of all evaluator labels */
  labels: string[];
  /** Failed evaluator info */
  errors: EvalErrorEntry[];
}

/** Marker on an execution indicating it needs human attention */
export interface HumanReviewFlag {
  /** References the flagged execution */
  executionId: string;
  /** Flow name (denormalized for querying) */
  flowName: string;
  /** Current lifecycle state */
  status: FlagStatus;
  /** Why flagged */
  reason: string;
  /** How the flag was created */
  source: 'auto' | 'manual';
  /** When flag was created */
  createdAt: Date;
  /** When status last changed */
  updatedAt: Date;
}

/** Filter for querying human review flags */
export interface FlagFilter {
  /** Filter by flow name */
  flowName?: string;
  /** Filter by flag status */
  status?: FlagStatus;
}

/** Event payload: individual evaluator score */
export interface EvalScoreEvent {
  executionId: string;
  flowName: string;
  evaluatorName: string;
  scores: Record<string, number>;
  confidence: ConfidenceLevel;
  labels: string[];
  durationMs: number;
}

/** Event payload: all evaluators complete */
export interface EvalCompleteEvent {
  executionId: string;
  flowName: string;
  aggregateScores: Record<string, number>;
  overallScore: number;
  confidence: ConfidenceLevel;
  evaluatorCount: number;
  errorCount: number;
  timestamp: Date;
}

/** Event payload: execution flagged for review */
export interface EvalFlaggedEvent {
  executionId: string;
  flowName: string;
  reason: string;
  source: 'auto' | 'manual';
  status: FlagStatus;
  timestamp: Date;
}

/** Configuration for the evaluation engine */
export interface EvaluationConfig {
  /** Initial evaluators to register */
  evaluators?: Evaluator[];
  /** Minimum dimension score for auto-flagging (disabled if not set) */
  autoFlagScoreThreshold?: number;
}

// ── End Evaluation Types ──

// ── Adapter Types ──

/** Lifecycle states for an adapter connection */
export type AdapterState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Transport mechanism for MCP communication.
 *
 * - `stdio` — adapter runs as a subprocess; engine communicates via stdin/stdout MCP protocol.
 *   Requires `command`. Used for production MCP servers (gmail, slack, calendar references).
 * - `sse` — adapter runs as a remote HTTP/SSE server; engine connects via URL.
 *   Requires `url`. Used for cloud-hosted MCP services.
 * - `in-process` (v0.3.0+) — adapter runs in-process with the engine; tools are dispatched
 *   directly to handler functions provided in `tools`. Requires `tools`. Used for V2-style
 *   tool surfaces where spawning a subprocess is undesirable (e.g., a primordial agent's local
 *   action set, dynamically-synthesised SQLite-schema tools from runcor-integration).
 */
export type TransportType = 'stdio' | 'sse' | 'in-process';

/**
 * Tool definition for in-process adapters (v0.3.0+, V2-002).
 * Carries the handler function inline; no IPC, no subprocess.
 */
export interface AdapterToolDefinition {
  /** Tool name as exposed to the engine. */
  name: string;
  /** Human-readable tool description (passed through to the agent's capability layer). */
  description: string;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>;
  /** Handler invoked when the engine calls this tool. */
  handler: (args: Record<string, unknown>) => Promise<ToolCallResult>;
}

/** Configuration for connecting to an MCP server */
export interface AdapterConfig {
  /** Unique identifier for this adapter */
  name: string;
  /** Transport mechanism (stdio, sse, or in-process) */
  transport: TransportType;
  /** Command to launch local MCP server process (required for stdio) */
  command?: string;
  /** Arguments for the stdio command */
  args?: string[];
  /** Environment variables for stdio process */
  env?: Record<string, string>;
  /** Endpoint URL for SSE transport (required for sse) */
  url?: string;
  /** HTTP headers for SSE transport (e.g., auth tokens) */
  headers?: Record<string, string>;
  /**
   * In-process tool definitions (required when `transport === 'in-process'`).
   * Each tool's `handler` is invoked directly when the engine routes a call to this adapter.
   */
  tools?: AdapterToolDefinition[];
  /** Per-operation timeout in milliseconds. Default: 30000 */
  timeoutMs?: number;
  /** Maximum retry attempts for failed operations. Default: 3 */
  retryAttempts?: number;
  /** Base delay for exponential backoff (doubles each attempt). Default: 1000 */
  retryDelayMs?: number;
  /** Interval between health checks in ms (0 to disable). Default: 30000 */
  healthCheckIntervalMs?: number;
  /** Failures before circuit breaker trips. Default: 3 */
  failureThreshold?: number;
  /** Circuit breaker cooldown period in ms. Default: 30000 */
  cooldownMs?: number;
  /** Default TTL for cached resources in ms. Default: 60000 */
  resourceCacheTtlMs?: number;
  /** Tenant scope for multi-tenant policy */
  tenantId?: string;
}

/** Describes a tool exposed by an adapter (per MCP specification) */
export interface AdapterToolSchema {
  /** Tool name as defined by the MCP server */
  name: string;
  /** Human-readable tool description */
  description?: string;
  /** JSON Schema defining the tool's input parameters */
  inputSchema: Record<string, unknown>;
}

/** Describes a resource exposed by an adapter (per MCP specification) */
export interface AdapterResourceSchema {
  /** Resource URI (RFC3986 compliant) */
  uri: string;
  /** Human-readable name */
  name: string;
  /** Resource description */
  description?: string;
  /** Content MIME type */
  mimeType?: string;
}

/** Result of a tool invocation */
export interface ToolCallResult {
  /** Result content items */
  content: ToolContent[];
  /** Whether the tool reported an error */
  isError: boolean;
}

/** A single content item in a tool result */
export interface ToolContent {
  /** Content type */
  type: 'text' | 'image' | 'resource';
  /** Text content (when type is 'text') */
  text?: string;
  /** Base64-encoded image data (when type is 'image') */
  data?: string;
  /** Image MIME type (when type is 'image') */
  mimeType?: string;
  /** Embedded resource (when type is 'resource') */
  resource?: { uri: string; text?: string; blob?: string };
}

/** Content returned when reading a resource */
export interface ResourceContent {
  /** Resource URI */
  uri: string;
  /** UTF-8 text content */
  text?: string;
  /** Base64-encoded binary content */
  blob?: string;
  /** Content MIME type */
  mimeType?: string;
}

/** Runtime information about a connected adapter */
export interface AdapterInfo {
  /** Adapter name from config */
  name: string;
  /** Current lifecycle state */
  state: AdapterState;
  /** Discovered tools */
  tools: AdapterToolSchema[];
  /** Discovered resources */
  resources: AdapterResourceSchema[];
  /** Timestamp of last health check */
  lastHealthCheck: Date | null;
  /** Last error message (credentials redacted) */
  lastError: string | null;
  /** Failure count for circuit breaker */
  consecutiveFailures: number;
}

/** Tool info with qualified name for cross-adapter discovery */
export interface AdapterToolInfo {
  /** Fully-qualified name (adapterName.toolName) */
  qualifiedName: string;
  /** Adapter that owns this tool */
  adapterName: string;
  /** Tool name on the adapter */
  toolName: string;
  /** Human-readable description */
  description?: string;
  /** JSON Schema for input parameters */
  inputSchema: Record<string, unknown>;
}

/** Engine-level configuration for the adapter subsystem */
export interface AdapterManagerConfig {
  /** Adapter configurations to connect on startup */
  adapters?: AdapterConfig[];
}

// ── End Adapter Types ──

// ── Agent Types ──

/** Scoped interface for accessing adapter tools from within a flow handler */
export interface ToolsAccessor {
  /** List available tools (from connected adapters) */
  listTools(filter?: { adapter?: string }): AdapterToolInfo[];
  /** Execute a tool by qualified name */
  callTool(qualifiedName: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
}

// ── End Agent Types ──

// ── Wait/Resume Types ──

/** Metadata stored on a waiting execution */
export interface WaitContext {
  /** Why the execution is waiting */
  reason: string | null;
  /** When the external system is expected to resume */
  expectedResumeBy: Date | null;
  /** Arbitrary data attached by the flow */
  waitData: unknown;
  /** When the execution entered waiting state */
  waitingSince: Date;
}

// ── End Wait/Resume Types ──

/** Engine lifecycle states */
export type EngineStatus = 'initializing' | 'ready' | 'shutting_down' | 'stopped';

/** Execution state machine states */
export type ExecutionState = 'queued' | 'running' | 'waiting' | 'retrying' | 'complete' | 'failed';

/** Engine initialization configuration */
export interface EngineConfig {
  model: {
    /** Single provider (backward compatible) */
    provider?: ModelProvider;
    /** Multi-provider config (mutually exclusive with provider) */
    providers?: ProviderConfig[];
    /** Routing strategy. Default: 'priority' */
    strategy?: RoutingStrategy | 'priority' | 'round-robin' | 'lowest-cost';
    /** Max additional providers to try after primary fails. Default: providers.length - 1 */
    maxFallbackAttempts?: number;
    /** Circuit breaker failure threshold. Default: 5 */
    failureThreshold?: number;
    /** Circuit breaker cooldown in ms. Default: 30000 */
    cooldownMs?: number;
  };
  /** Max simultaneous running executions. Default: 100 */
  concurrency?: number;
  /** Shutdown drain period in ms. Default: 10000 */
  drainTimeout?: number;
  /** How long to keep terminal executions in seconds. 0 = forever. Default: 3600 */
  retentionPeriod?: number;
  /** Custom memory backend. Default: InMemoryStore */
  memoryStore?: MemoryStore;
  /** Cost tracking configuration. Default: no budgets */
  cost?: CostConfig;
  /** Telemetry configuration. Default: no telemetry */
  telemetry?: TelemetryConfig;
  /** Policy configuration. Default: no policies */
  policy?: PolicyConfig;
  /** Evaluation configuration. Default: no evaluators */
  evaluation?: EvaluationConfig;
  /** Adapter configuration. Default: no adapters */
  adapters?: AdapterManagerConfig;
  /** MCP server configuration. Default: server disabled */
  server?: MCPServerConfig;
  /** Scheduler configuration. Default: no scheduler */
  scheduler?: {
    /** Default IANA timezone for scheduled flows. Default: 'UTC' */
    defaultTimezone?: string;
  };
  /** State backend configuration. Default: InMemoryStateStore */
  state?: StateStoreConfig;
  /** Discernment configuration. Default: disabled */
  discernment?: DiscernmentConfig;
}

/** State backend configuration */
export interface StateStoreConfig {
  /** Backend type. Default: 'memory' */
  type: 'memory' | 'sqlite';
  /** Filesystem path to SQLite database (required when type='sqlite') */
  path?: string;
  /** Callback for orphaned execution recovery (programmatic only) */
  onOrphanedExecution?: (execution: Execution) => 'fail' | 'requeue' | 'ignore';
}

/** Flow-level configuration */
export interface FlowConfig {
  /** Max execution time in ms. 0 = no timeout. Default: 30000 */
  timeout?: number;
  /** Max retry attempts for retryable errors. 0 = no retries. Default: 3 */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms. Default: 1000 */
  baseRetryDelay?: number;
  /** Maximum delay cap for backoff in ms. Default: 30000 */
  maxRetryDelay?: number;
  /** Per-flow budget override */
  budget?: BudgetScopeConfig;
  /** Max wait time in ms. 0 = wait indefinitely. Default: 0 */
  waitTimeout?: number;
  /** Human-readable description of the flow. Used as MCP tool description */
  description?: string;
  /** JSON Schema describing expected input. Used as MCP tool input schema */
  inputSchema?: Record<string, unknown>;
  /** Cron expression for scheduled execution. Example: "0 7 * * *" */
  schedule?: string;
  /** IANA timezone for this flow's schedule. Overrides engine default */
  timezone?: string;
  /** Primary objective name */
  objective?: string;
  /** Optional secondary objectives */
  secondaryObjectives?: string[];
  /** Expected execution cadence, e.g., 'daily', 'hourly', 'weekly' */
  expectedCadence?: string;
  /** Business purpose description */
  purpose?: string;
  /** Opt-in for enforce mode auto-execution */
  enforceable?: boolean;
}

/** Resolved flow config with all defaults applied */
export interface ResolvedFlowConfig {
  timeout: number;
  maxRetries: number;
  baseRetryDelay: number;
  maxRetryDelay: number;
  /** Max wait time in ms. 0 = wait indefinitely */
  waitTimeout: number;
}

/** Flow handler function signature */
export type FlowHandler = (ctx: ExecutionContext) => Promise<unknown>;

/** A registered flow definition */
export interface Flow {
  name: string;
  handler: FlowHandler;
  config: ResolvedFlowConfig;
  /** Per-flow budget override */
  budget?: BudgetScopeConfig;
  /** Human-readable description. Undefined if not provided */
  description?: string;
  /** JSON Schema for expected input. Defaults to { type: "object" } */
  inputSchema: Record<string, unknown>;
  /** Primary objective name. Undefined if not tagged */
  objective?: string;
  /** Secondary objectives. Undefined if not tagged */
  secondaryObjectives?: string[];
  /** Expected execution cadence */
  expectedCadence?: string;
  /** Business purpose description */
  purpose?: string;
  /** Opt-in for enforce mode auto-execution */
  enforceable?: boolean;
}

/** Timestamps recorded during execution lifecycle */
export interface ExecutionTimestamps {
  queued: Date;
  started: Date | null;
  completed: Date | null;
  transitions: Array<{ from: ExecutionState; to: ExecutionState; at: Date }>;
}

/** Error context preserved for failed executions */
export interface ExecutionError {
  message: string;
  stack: string | null;
  retryable: boolean;
  retryCount: number;
  code: string | null;
}

/** Filter for listing executions */
export interface StateFilter {
  state?: ExecutionState;
  flowName?: string;
}

/** Options for triggering a flow */
export interface TriggerOptions {
  /** Required — caller must provide */
  idempotencyKey: string;
  /** Input data for the flow */
  input?: unknown;
  /** Override flow-level timeout */
  timeout?: number;
  /** User ID for user-scoped memory */
  userId?: string;
  /** Session ID for session-scoped memory */
  sessionId?: string;
  /** Override flow-level wait timeout for this execution */
  waitTimeout?: number;
  /** Explicit tenant identity */
  tenantId?: string;
  /** Additional context for policy evaluation */
  metadata?: Record<string, unknown>;
}

/** Model interface exposed to flow handlers */
export interface ModelInterface {
  complete(request: import('./model/provider.js').ModelRequest): Promise<import('./model/provider.js').ModelResponse>;
  /** Stream a response as async-iterable events with a final response promise */
  stream(request: import('./model/provider.js').ModelRequest): import('./model/provider.js').ModelStream;
}

/** A single memory entry stored in the backend */
export interface MemoryEntry {
  key: string;
  value: unknown;
  createdAt: Date;
  expiresAt: Date | null;
}

/** Scoped memory accessor with get/set/delete/list */
export interface ScopedMemory {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

/** Memory accessor exposed on ExecutionContext */
export interface MemoryAccessor {
  tool: ScopedMemory;
  user: ScopedMemory;
  session: ScopedMemory;
}

/** Pluggable memory backend interface */
export interface MemoryStore {
  get(namespace: string, key: string): Promise<MemoryEntry | null>;
  set(namespace: string, key: string, entry: MemoryEntry): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
  list(namespace: string): Promise<string[]>;
  deleteNamespace(namespace: string): Promise<void>;
}

/** Execution context provided to flow handlers */
export interface ExecutionContext {
  executionId: string;
  input: unknown;
  model: ModelInterface;
  memory: MemoryAccessor;
  /** Read-only cost info for cost-aware flows */
  cost: CostAccessor;
  /** Telemetry accessor for custom span attributes/events */
  telemetry: TelemetryAccessor;
  /** Data from engine.resume(). Undefined for initial invocations */
  resumeData?: unknown;
  /** Adapter tool access: list and call tools. Undefined when no adapters configured. */
  tools?: ToolsAccessor;
}

/** Default configuration values */
export const DEFAULTS = {
  concurrency: 100,
  drainTimeout: 10000,
  retentionPeriod: 3600,
  timeout: 30000,
  maxRetries: 3,
  baseRetryDelay: 1000,
  maxRetryDelay: 30000,
  // Routing defaults
  failureThreshold: 5,
  cooldownMs: 30000,
  defaultStrategy: 'priority' as const,
  defaultPriority: 1,
  // Wait timeout default — 0 means wait indefinitely
  waitTimeout: 0,
} as const;
