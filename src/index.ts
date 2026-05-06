// Public API exports

export { createEngine, Runcor } from './engine.js';
export type { CreateEngineOptions, EngineEvents } from './engine.js';

// Config file loading
export { loadConfig } from './config/loader.js';
export type { LoadConfigOptions } from './config/loader.js';
export type { ProviderFactory, EvaluatorFactory } from './config/factories.js';
export type {
  RuncorConfigFile,
  ProviderEntry,
  RoutingEntry,
  ConnectionEntry,
  CostsEntry,
  TelemetryEntry,
  PolicyEntry,
  EvaluationEntry,
  ServerEntry,
  SchedulerEntry,
} from './config/schema.js';
export type { ConfigValidationError } from './errors.js';

export type {
  Execution,
} from './execution.js';
export { createExecution, transitionExecution, validateTransition } from './execution.js';

export type {
  EngineConfig,
  EngineStatus,
  ExecutionState,
  ExecutionContext,
  ExecutionTimestamps,
  ExecutionError,
  FlowConfig,
  FlowHandler,
  TriggerOptions,
  StateFilter,
  ModelInterface,
  Flow,
  ResolvedFlowConfig,
  MemoryEntry,
  ScopedMemory,
  MemoryAccessor,
  MemoryStore,
  // Routing types
  RoutingStrategy,
  ProviderConfig,
  CostPerToken,
  HealthState,
  ProviderRegistration,
  RouterConfig,
  // Cost tracking types
  CostEntry,
  CostConfig,
  BudgetScopeConfig,
  BudgetWindow,
  CostAccessor,
  CostQueryFilter,
  CostLedgerStore,
  CostRequestEvent,
  CostBudgetWarningEvent,
  CostBudgetExceededEvent,
  // Telemetry types
  TelemetryConfig,
  TelemetryAccessor,
  LogHandler,
  LogRecord,
  LogLevel,
  // Policy types
  OperationType,
  PolicyContext,
  PolicyDecision,
  PolicyRule,
  GuardrailContext,
  GuardrailResult,
  Guardrail,
  RateLimitConfig,
  RateLimitEntry,
  RateLimitQueueEntry,
  AccessPolicy,
  GuardrailOverride,
  TenantConfig,
  PolicyConfig,
} from './types.js';
export { DEFAULTS } from './types.js';

export type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StreamEvent,
  ModelStream,
} from './model/provider.js';
export { createFallbackStream } from './model/provider.js';

export { EngineError, RetryableError, AllProvidersFailedError, BudgetExceededError, ValidationError } from './errors.js';
export type { ProviderError, ValidationErrorDetail } from './errors.js';

export type { StateStore } from './state-store.js';
export { InMemoryStateStore } from './state-store.js';

export { MockProvider } from './model/mock.js';
export { AnthropicProvider } from './model/anthropic.js';
export { OpenAIProvider } from './model/openai.js';
export { GoogleProvider } from './model/google.js';

export { InMemoryStore } from './memory/store.js';

// Routing strategy factories
export {
  createPriorityStrategy,
  createRoundRobinStrategy,
  createLowestCostStrategy,
} from './model/strategies.js';

// Cost tracking
export { InMemoryCostLedger } from './cost/ledger.js';

// Wait/Resume/Replay
export type { WaitSignal, WaitSignalOptions } from './wait-signal.js';
export { createWaitSignal, isWaitSignal } from './wait-signal.js';
export type { WaitContext } from './types.js';

// Evaluation types
export type {
  Evaluator,
  EvalContext,
  EvalResult,
  EvalRecord,
  EvaluatorResultEntry,
  EvalErrorEntry,
  HumanReviewFlag,
  FlagStatus,
  FlagFilter,
  ConfidenceThresholds,
  ConfidenceLevel,
  EvalScoreEvent,
  EvalCompleteEvent,
  EvalFlaggedEvent,
  EvaluationConfig,
} from './types.js';

// Built-in evaluator factories
export { createLengthEvaluator } from './evaluation/built-in/length-evaluator.js';
export { createFormatEvaluator } from './evaluation/built-in/format-evaluator.js';
export { createKeywordEvaluator } from './evaluation/built-in/keyword-evaluator.js';

// Adapter types
export type {
  AdapterConfig,
  AdapterState,
  TransportType,
  AdapterToolSchema,
  AdapterResourceSchema,
  AdapterToolDefinition,
  ToolCallResult,
  ToolContent,
  ResourceContent,
  AdapterInfo,
  AdapterToolInfo,
  AdapterManagerConfig,
} from './types.js';

// Reference adapter configs
export { gmailAdapterConfig, gmailToolSchemas } from './adapter/reference/gmail.js';
export { slackAdapterConfig, slackToolSchemas } from './adapter/reference/slack.js';
export { calendarAdapterConfig, calendarToolSchemas } from './adapter/reference/calendar.js';

// In-process adapter (V2-002, v0.3.0)
export { createInProcessClientFactory } from './adapter/in-process.js';

// MCP Server types
export type { MCPServerConfig } from './server/types.js';

// Agent execution pattern
export { createAgentHandler } from './agent/handler.js';
export type {
  AgentConfig,
  AgentResult,
  AgentIteration,
  ToolCallRecord,
  ConversationMessage,
  ToolDefinition,
  ToolCallRequest,
  StopReason,
} from './agent/types.js';
export type { ToolsAccessor } from './types.js';

// Structured output types
export type { ResponseFormat, JsonSchema, ValidationRetryEvent } from './types.js';

// HTTP Server
export { createServer } from './http/server.js';
export type { ServerOptions, RuncorServer, CorsOptions, ErrorResponse } from './http/types.js';
