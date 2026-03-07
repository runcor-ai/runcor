// Error classes for the Runcor runtime

/** General engine error. Non-retryable by default. */
export class EngineError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

/** Signals to the engine that this failure should be retried. */
export class RetryableError extends Error {
  readonly cause?: Error;

  constructor(message: string, options?: { cause?: Error }) {
    super(message);
    this.name = 'RetryableError';
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

/** Thrown when a budget limit is exceeded in hard enforcement mode */
export class BudgetExceededError extends EngineError {
  readonly scope: 'request' | 'user' | 'flow' | 'global';
  readonly limit: number;
  readonly currentSpend: number;
  readonly estimatedCost: number;

  constructor(
    scope: 'request' | 'user' | 'flow' | 'global',
    limit: number,
    currentSpend: number,
    estimatedCost: number,
  ) {
    super(
      `Budget exceeded for scope "${scope}": limit=${limit}, currentSpend=${currentSpend}, estimatedCost=${estimatedCost}`,
      'BUDGET_EXCEEDED',
    );
    this.name = 'BudgetExceededError';
    this.scope = scope;
    this.limit = limit;
    this.currentSpend = currentSpend;
    this.estimatedCost = estimatedCost;
  }
}

// ── Adapter Error Codes ──
// DUPLICATE_ADAPTER      — Adapter with same name already registered
// ADAPTER_NOT_FOUND      — No adapter with given name
// ADAPTER_NOT_CONNECTED  — Adapter exists but not in connected state
// TOOL_NOT_FOUND         — Tool not found on the target adapter
// ADAPTER_CIRCUIT_OPEN   — Adapter circuit breaker is open
// ADAPTER_TIMEOUT        — Operation timed out
// RESOURCE_NOT_FOUND     — Resource URI not found on adapter
// ── End Adapter Error Codes ──

// ── Config Error Codes ──
// CONFIG_INVALID    — Config file failed schema validation (one or more errors)
// CONFIG_NOT_FOUND  — Config file not found at specified or auto-detected path
// ── End Config Error Codes ──

/** Structured validation error from config file parsing */
export interface ConfigValidationError {
  /** Dot-notation field path (e.g., providers[0].apiKey) */
  path: string;
  /** Human-readable error description */
  message: string;
  /** Expected type or value constraint */
  expected?: string;
  /** Actual value or type received */
  received?: string;
}

// ── Policy Error Codes ──
// POLICY_DENIED       — A policy rule denied the operation
// ACCESS_DENIED       — Access control denied the operation
// RATE_LIMITED         — Rate limit exceeded
// GUARDRAIL_BLOCKED   — A guardrail blocked the operation (input or output)
// DUPLICATE_POLICY    — Policy rule name already registered
// DUPLICATE_GUARDRAIL — Guardrail name already registered
// DUPLICATE_RATE_LIMIT— Rate limit name already registered
// INVALID_POLICY_CONFIG — Invalid policy configuration (empty operations, limit <= 0, windowMs <= 0)
// ── End Policy Error Codes ──

// ── Structured Output Errors ──

/** Structured validation error detail from JSON Schema validation */
export interface ValidationErrorDetail {
  /** JSON pointer path to the invalid field (e.g., "/name", "" for root-level) */
  path: string;
  /** Human-readable error message */
  message: string;
  /** JSON Schema keyword that failed (e.g., "type", "required", "pattern") */
  keyword: string;
}

/** Thrown when model response fails JSON/schema validation after all retries */
export class ValidationError extends EngineError {
  readonly errors: ValidationErrorDetail[];
  readonly rawText: string;

  constructor(errors: ValidationErrorDetail[], rawText: string) {
    const summary = errors.map(e => e.message).join('; ');
    super(`Validation failed: ${summary}`, 'VALIDATION_FAILED');
    this.name = 'ValidationError';
    this.errors = errors;
    this.rawText = rawText;
  }
}

// ── End Structured Output Errors ──

// ── Discernment Error Codes ──
// DUPLICATE_OBJECTIVE           — Objective with same name already exists
// OBJECTIVE_NOT_FOUND           — No objective with given name
// UNDECLARED_OBJECTIVE          — Flow references an objective that hasn't been declared
// RESERVED_FLOW_NAME            — Flow name is reserved by the engine (e.g., __discernment)
// DISCERNMENT_DISABLED          — Discernment operation attempted when subsystem is disabled
// CYCLE_IN_PROGRESS             — Concurrent discernment cycle attempted
// RECOMMENDATION_NOT_FOUND      — No recommendation with given ID
// INVALID_RECOMMENDATION_STATUS — Invalid recommendation status transition
// DUPLICATE_HEURISTIC           — Custom heuristic with same name already exists
// ADVISE_GATE_PENDING           — Next cycle blocked until previous recommendations acknowledged/dismissed
// ── End Discernment Error Codes ──

/** Error details collected during a failed provider attempt */
export interface ProviderError {
  /** Which provider failed */
  providerName: string;
  /** The original error */
  error: Error;
  /** When the failure occurred */
  timestamp: Date;
}

/** Thrown when all providers in the fallback chain fail */
export class AllProvidersFailedError extends EngineError {
  readonly attempts: ProviderError[];

  constructor(attempts: ProviderError[]) {
    super('All providers failed for model request.', 'ALL_PROVIDERS_FAILED');
    this.name = 'AllProvidersFailedError';
    this.attempts = attempts;
  }
}
