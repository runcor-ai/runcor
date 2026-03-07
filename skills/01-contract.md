# Tool-Engine Contract

> **Purpose**: Defines the boundary between what a tool handles and what the Runcor engine handles automatically.
> **When to use**: When Claude needs to decide whether a capability belongs in the tool code or is provided by the engine.

## The Contract

Tools are **thin** — they contain only business logic. The engine handles all cross-cutting concerns. This table defines the boundary for every concern area.

| Concern | Tool Handles | Engine Handles |
|---------|-------------|----------------|
| **Business Logic** | Flow handler function, input validation, output formatting, domain-specific decisions | Dispatching flows, state transitions, retry on failure, timeout enforcement |
| **Model Calls** | Composing prompts via `ctx.model.complete()`, interpreting model responses | Provider routing, fallback chains, circuit breaking, provider health monitoring |
| **Memory** | Choosing what to store, key naming conventions, deciding scope (tool/user/session) | Scoped isolation (`ctx.memory.tool`, `ctx.memory.user`, `ctx.memory.session`), storage backend, TTL enforcement |
| **Cost Tracking** | Optionally checking budget via `ctx.cost.executionTotal` | Tracking all costs automatically, ledger storage, budget enforcement, emitting `cost:*` events |
| **Telemetry** | Optionally adding custom span attributes/events via `ctx.telemetry` | OpenTelemetry tracing, metrics collection, structured logging, span lifecycle |
| **Policy** | Nothing — policy is transparent to tools | Rules evaluation, guardrails (input/output inspection), rate limits, access control, tenant isolation |
| **Evaluation** | Nothing — evaluation is transparent to tools | Quality scoring after execution, confidence levels, auto-flagging for human review |
| **Adapters (MCP)** | Calling adapter tools with correct arguments via the engine's adapter API | Connection lifecycle, reconnection, circuit breaking, health checks, resource caching |
| **Config** | Creating `runcor.yaml` with provider settings, connections, budgets | Loading, parsing, validating, interpolating env vars, mapping YAML to `EngineConfig` |
| **Lifecycle / State** | Returning results (success) or throwing errors (failure) from the flow handler | Execution state machine (queued → running → waiting → retrying → complete/failed), cancellation, wait/resume, replay |

## Key Principles

1. **Engine-First**: Every cross-cutting concern lives in the engine, never in a tool.
2. **Tools are functions**: A tool is a `FlowHandler` — an async function that receives `ExecutionContext` and returns a result.
3. **Opt-in subsystems**: Tools access engine capabilities through `ctx` (model, memory, cost, telemetry). Policy and evaluation run automatically without tool involvement.
4. **Provider agnosticism**: Tools call `ctx.model.complete()` — they never reference a specific provider.
5. **Config over code**: Runtime settings (providers, budgets, adapters) go in `runcor.yaml`, not in tool code.

## What a Tool Looks Like

A tool consists of:

1. **One or more flow handlers** — async functions containing business logic
2. **Engine initialization** — `createEngine()` or `createEngine(config)`
3. **Flow registration** — `engine.register('name', handler)`
4. **A trigger** — `engine.trigger('name', { idempotencyKey, input })`
5. **A `runcor.yaml`** — configuration for providers, adapters, budgets

Everything else is the engine's responsibility.

## Decision Guide

When building a tool, ask:

- **"Should I implement routing/fallback?"** — No, the engine does this. Use `ctx.model.complete()`.
- **"Should I track costs?"** — No, the engine tracks automatically. Use `ctx.cost` to read totals if needed.
- **"Should I add logging?"** — The engine logs automatically. Use `ctx.telemetry` only for custom business-level events.
- **"Should I handle retries?"** — No. Throw `RetryableError` and the engine retries with exponential backoff.
- **"Should I manage connections?"** — No. Configure adapters in `runcor.yaml` and call them through the engine.
- **"Should I validate config?"** — No. The engine validates `runcor.yaml` via `loadConfig()`.

## See Also

- `02-scaffolding.md` — Uses this contract to decide what to generate
- `04-api-reference.md` — The full API surface referenced by this contract
- `05-subsystems.md` — Detailed guides for each subsystem in the matrix above
- `06-lifecycle.md` — Execution state machine (the Lifecycle row in detail)
