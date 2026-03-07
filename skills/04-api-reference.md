# API Reference

> **Purpose**: Documents every public export from the `runcor` package so Claude can generate correct import statements.
> **When to use**: When Claude needs to know what to import, what types to use, or what functions are available.

## Core Engine

```typescript
import { createEngine, Runcor } from 'runcor';
import type { CreateEngineOptions, EngineConfig, EngineStatus } from 'runcor';
```

| Export | Kind | Description |
|--------|------|-------------|
| `createEngine(config)` | Function | Create an engine instance from an `EngineConfig` object |
| `createEngine(options?)` | Function | Create an engine instance, optionally loading `runcor.yaml` via `CreateEngineOptions` |
| `Runcor` | Class | The engine class (returned by `createEngine`) |
| `EngineConfig` | Type | Programmatic engine configuration |
| `CreateEngineOptions` | Type | Options for YAML-based engine creation |
| `EngineStatus` | Type | `'initializing' \| 'ready' \| 'shutting_down' \| 'stopped'` |

### Engine Instance Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `register` | `(name: string, handler: FlowHandler, config?: FlowConfig) => void` | Register a flow with the engine |
| `trigger` | `(flowName: string, options: TriggerOptions) => Promise<Execution>` | Trigger execution of a registered flow |
| `cancel` | `(executionId: string, reason?: string) => Promise<void>` | Cancel a running or queued execution |
| `resume` | `(executionId: string, resumeData?: unknown) => Promise<Execution>` | Resume a waiting execution |
| `replay` | `(executionId: string) => Promise<Execution>` | Replay a completed/failed execution |
| `getExecution` | `(executionId: string) => Promise<Execution \| null>` | Get an execution by ID |
| `list` | `(filter?: StateFilter) => Promise<Execution[]>` | List executions with optional filter |
| `listWaiting` | `() => Promise<Execution[]>` | List all waiting executions |
| `getStatus` | `() => EngineStatus` | Get engine lifecycle status |
| `getCostLedger` | `() => CostLedgerStore \| null` | Get cost ledger (null if cost tracking disabled) |
| `shutdown` | `() => Promise<void>` | Gracefully shut down the engine |

## Flow Types

```typescript
import type { FlowHandler, FlowConfig, TriggerOptions, ExecutionContext } from 'runcor';
```

| Export | Kind | Description |
|--------|------|-------------|
| `FlowHandler` | Type | `(ctx: ExecutionContext) => Promise<unknown>` — the flow function signature |
| `FlowConfig` | Type | Per-flow settings: timeout, retries, backoff, budget, wait timeout |
| `TriggerOptions` | Type | `{ idempotencyKey, input?, timeout?, userId?, sessionId?, waitTimeout?, tenantId?, metadata? }` |
| `ExecutionContext` | Type | The `ctx` object passed to flow handlers |

### ExecutionContext Properties

| Property | Type | Description |
|----------|------|-------------|
| `ctx.executionId` | `string` | Unique execution identifier |
| `ctx.input` | `unknown` | Input data from `TriggerOptions.input` |
| `ctx.model` | `ModelInterface` | Model call interface — use `ctx.model.complete(request)` |
| `ctx.memory` | `MemoryAccessor` | Scoped memory — `ctx.memory.tool`, `ctx.memory.user`, `ctx.memory.session` |
| `ctx.cost` | `CostAccessor` | Read-only cost info — `ctx.cost.executionTotal`, `ctx.cost.requestCount` |
| `ctx.telemetry` | `TelemetryAccessor` | Telemetry — `setAttribute()`, `addEvent()`, `startSpan()` |
| `ctx.resumeData` | `unknown \| undefined` | Data from `engine.resume()` (undefined on first run) |

## Execution Types

```typescript
import type { Execution, ExecutionState, ExecutionError, ExecutionTimestamps } from 'runcor';
```

| Export | Kind | Description |
|--------|------|-------------|
| `Execution` | Type | Full execution record with state, result, error, timestamps |
| `ExecutionState` | Type | `'queued' \| 'running' \| 'waiting' \| 'retrying' \| 'complete' \| 'failed'` |
| `ExecutionError` | Type | Error context: message, stack, retryable flag, retry count, code |
| `ExecutionTimestamps` | Type | Lifecycle timestamps: queued, started, completed, transitions |

## Config Loading

```typescript
import { loadConfig } from 'runcor';
import type { LoadConfigOptions, RuncorConfigFile } from 'runcor';
```

| Export | Kind | Description |
|--------|------|-------------|
| `loadConfig(options?)` | Function | Load and validate `runcor.yaml`, returns `EngineConfig \| undefined` |
| `LoadConfigOptions` | Type | `{ path?, basePath?, providerFactories?, evaluatorFactories? }` |
| `RuncorConfigFile` | Type | TypeScript interface matching the YAML schema |

### Config Section Types

```typescript
import type {
  ProviderEntry, RoutingEntry, ConnectionEntry,
  CostsEntry, TelemetryEntry, PolicyEntry, EvaluationEntry,
} from 'runcor';
```

## Model Providers

```typescript
import { MockProvider, AnthropicProvider } from 'runcor';
import type { ModelProvider, ModelRequest, ModelResponse } from 'runcor';
```

| Export | Kind | Description |
|--------|------|-------------|
| `MockProvider` | Class | Test provider that returns deterministic responses |
| `AnthropicProvider` | Class | Anthropic Claude API provider |
| `ModelProvider` | Type | Provider interface: `name`, `complete(request)` |
| `ModelRequest` | Type | `{ prompt, model?, maxTokens?, temperature?, provider?, strategy? }` |
| `ModelResponse` | Type | `{ text, model, usage: { promptTokens, completionTokens, totalTokens } }` |

## Routing Strategies

```typescript
import {
  createPriorityStrategy,
  createRoundRobinStrategy,
  createLowestCostStrategy,
} from 'runcor';
import type { RoutingStrategy, ProviderConfig, RouterConfig } from 'runcor';
```

| Export | Kind | Description |
|--------|------|-------------|
| `createPriorityStrategy()` | Factory | Route by provider priority (lowest number first) |
| `createRoundRobinStrategy()` | Factory | Rotate across healthy providers |
| `createLowestCostStrategy()` | Factory | Route to cheapest provider with token costs |
| `ProviderConfig` | Type | `{ provider, priority?, costPerToken?, models? }` |

## Memory

```typescript
import { InMemoryStore } from 'runcor';
import type { ScopedMemory, MemoryAccessor, MemoryStore, MemoryEntry } from 'runcor';
```

| Export | Kind | Description |
|--------|------|-------------|
| `InMemoryStore` | Class | Default in-memory storage backend |
| `MemoryAccessor` | Type | `{ tool: ScopedMemory, user: ScopedMemory, session: ScopedMemory }` |
| `ScopedMemory` | Type | `get<T>(key)`, `set(key, value, ttl?)`, `delete(key)`, `list()` |
| `MemoryStore` | Type | Pluggable backend interface |

## Cost Tracking

```typescript
import { InMemoryCostLedger } from 'runcor';
import type { CostAccessor, CostConfig, CostEntry, CostLedgerStore, BudgetScopeConfig } from 'runcor';
```

| Export | Kind | Description |
|--------|------|-------------|
| `InMemoryCostLedger` | Class | Default in-memory cost ledger |
| `CostAccessor` | Type | Read-only: `executionTotal`, `requestCount` |
| `CostConfig` | Type | Budget configuration: perRequest, perUser, perFlow, global |
| `BudgetScopeConfig` | Type | `{ limit, enforcement?, window? }` |

## Telemetry

```typescript
import type { TelemetryConfig, TelemetryAccessor, LogHandler, LogRecord, LogLevel } from 'runcor';
```

| Export | Kind | Description |
|--------|------|-------------|
| `TelemetryAccessor` | Type | `activeSpan`, `setAttribute()`, `addEvent()`, `startSpan()` |
| `TelemetryConfig` | Type | `{ tracerProvider?, meterProvider?, logHandler?, serviceName?, memorySpans? }` |
| `LogHandler` | Type | `(record: LogRecord) => void` |
| `LogLevel` | Type | `'debug' \| 'info' \| 'warn' \| 'error'` |

## Wait/Resume

```typescript
import { createWaitSignal, isWaitSignal } from 'runcor';
import type { WaitSignal, WaitSignalOptions, WaitContext } from 'runcor';
```

| Export | Kind | Description |
|--------|------|-------------|
| `createWaitSignal(options?)` | Function | Create a signal that pauses execution until `engine.resume()` |
| `isWaitSignal(value)` | Function | Type guard to check if a value is a WaitSignal |
| `WaitSignalOptions` | Type | `{ reason?, expectedResumeBy?, data? }` |
| `WaitContext` | Type | Metadata stored on a waiting execution |

## Policy

```typescript
import type {
  PolicyConfig, PolicyRule, PolicyDecision, PolicyContext,
  Guardrail, GuardrailResult, GuardrailContext,
  RateLimitConfig, AccessPolicy, TenantConfig,
} from 'runcor';
```

Policy is configured on the engine — tools do not interact with policy directly.

## Evaluation

```typescript
import {
  createLengthEvaluator,
  createFormatEvaluator,
  createKeywordEvaluator,
} from 'runcor';
import type {
  Evaluator, EvalContext, EvalResult, EvalRecord,
  EvaluationConfig, ConfidenceLevel, HumanReviewFlag,
} from 'runcor';
```

| Export | Kind | Description |
|--------|------|-------------|
| `createLengthEvaluator(config)` | Factory | Score based on response length |
| `createFormatEvaluator(config)` | Factory | Score based on format compliance |
| `createKeywordEvaluator(config)` | Factory | Score based on keyword presence |

## Adapters (MCP)

```typescript
import type {
  AdapterConfig, AdapterState, TransportType,
  AdapterToolSchema, ToolCallResult, ResourceContent,
  AdapterInfo, AdapterToolInfo, AdapterManagerConfig,
} from 'runcor';
```

### Reference Adapter Configs

```typescript
import { gmailAdapterConfig, slackAdapterConfig, calendarAdapterConfig } from 'runcor';
import { gmailToolSchemas, slackToolSchemas, calendarToolSchemas } from 'runcor';
```

## Errors

```typescript
import { EngineError, RetryableError, AllProvidersFailedError, BudgetExceededError } from 'runcor';
import type { ProviderError, ConfigValidationError } from 'runcor';
```

| Export | Kind | Description |
|--------|------|-------------|
| `EngineError` | Class | Base error with `code` property |
| `RetryableError` | Class | Throw from a flow handler to trigger engine retry |
| `AllProvidersFailedError` | Class | All providers failed during routing |
| `BudgetExceededError` | Class | Budget limit reached |

## State & Storage

```typescript
import { InMemoryStateStore } from 'runcor';
import type { StateStore } from 'runcor';
```

| Export | Kind | Description |
|--------|------|-------------|
| `InMemoryStateStore` | Class | Default in-memory execution state storage |
| `StateStore` | Type | Pluggable state storage backend interface |

## Constants

```typescript
import { DEFAULTS } from 'runcor';
```

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULTS.concurrency` | `100` | Max simultaneous executions |
| `DEFAULTS.drainTimeout` | `10000` | Shutdown drain period (ms) |
| `DEFAULTS.timeout` | `30000` | Default flow timeout (ms) |
| `DEFAULTS.maxRetries` | `3` | Default retry attempts |
| `DEFAULTS.baseRetryDelay` | `1000` | Base backoff delay (ms) |
| `DEFAULTS.maxRetryDelay` | `30000` | Max backoff delay (ms) |
| `DEFAULTS.waitTimeout` | `0` | Wait timeout (0 = indefinite) |

## See Also

- `01-contract.md` — How these APIs map to tool vs engine responsibilities
- `02-scaffolding.md` — Which imports to use when scaffolding a new tool
- `03-config-reference.md` — `RuncorConfigFile` and config-related types
- `05-subsystems.md` — Usage examples for each API group
- `06-lifecycle.md` — Execution types and state transitions
