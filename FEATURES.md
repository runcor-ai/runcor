# runcor — Feature Reference

Complete list of implemented features in the runcor AI runtime engine.

---

## Core Runtime

### 001 — Core Engine Runtime

Managed execution lifecycle for AI workflows. Every flow runs through a state machine (queued → running → waiting → retrying → complete/failed) with concurrency control, queue dispatch, idempotency keys, and graceful shutdown with drain timeout.

- **State machine**: 6 states with validated transitions
- **Concurrency**: Configurable slot-based limits with FIFO queue
- **Idempotency**: Duplicate triggers return existing execution
- **Shutdown**: Drain timeout with force-fail for stragglers

### 002 — Scoped Memory

Per-execution memory with three scopes: `tool` (persistent per flow), `user` (persistent per user), and `session` (ephemeral per execution). In-memory default with pluggable backend interface.

```typescript
await ctx.memory.tool.set('key', value);
await ctx.memory.user.get('preferences');
```

### 003 — Model Router

Multi-provider model routing with fallback chains, circuit breakers, and three routing strategies.

- **Providers**: Anthropic (Claude), OpenAI (GPT), Google (Gemini), Mock (testing)
- **Strategies**: Priority (ordered failover), Round-Robin (load distribution), Lowest-Cost (budget optimization)
- **Circuit breaker**: Automatic provider health tracking with open/half-open/closed states
- **Streaming**: SSE-compatible token streaming across all providers

### 004 — Cost Tracking

Per-request token counting and cost calculation with multi-scope budget enforcement.

- **Scopes**: Per-request, per-user, per-flow, hourly window, global
- **Enforcement**: Hard (block) or soft (warn) limits
- **Ledger**: Queryable cost history with filtering by flow, user, time range
- **Events**: `cost:request`, `cost:budget_warning`, `cost:budget_exceeded`

### 005 — Observability

OpenTelemetry-native instrumentation. Every execution produces traces, metrics, and structured logs compatible with Datadog, Grafana, Jaeger, and any OTel-compatible backend.

- **Traces**: Span per execution, model call, retry, wait/resume
- **Metrics**: Execution count, latency, error rate, token usage
- **Logs**: Structured JSON with execution context

### 006 — Wait / Resume / Replay

Pause execution for external input (human approval, webhook callback, async API response), then resume with data. Replay completed executions with the same or different input.

```typescript
return createWaitSignal({ reason: 'Awaiting manager approval', timeoutMs: 86400000 });
// Later...
await engine.resume(executionId, { approved: true });
```

---

## Governance & Quality

### 007 — Policy Layer

Declarative rules, content guardrails, rate limiting, and access control with multi-tenant configuration.

- **Rules**: Allow/deny flows per user, tenant, or operation type
- **Guardrails**: Input/output content checks (block, warn, or transform modes)
- **Rate limiting**: Per-user, per-flow, or global with reject or queue behavior
- **Access control**: Operation-level permissions (trigger, resume, cancel, replay)
- **Multi-tenant**: Per-tenant policy overrides via tenant resolver

### 008 — Evaluation Layer

Score execution outputs for quality, confidence, and correctness. Flag low-confidence results for human review.

- **Built-in evaluators**: Length, format, keyword presence
- **Custom evaluators**: Register functions that score outputs on any criteria
- **Confidence levels**: High, medium, low with configurable thresholds
- **Human review flags**: Auto-flag based on score thresholds, manage lifecycle (open → reviewed → resolved)
- **Events**: `eval:score`, `eval:complete`, `eval:flagged`

### 020 — Discernment

Portfolio-level analysis that reads signals from all subsystems and forms a judgment about whether what's running is worth running. Operators declare business objectives, tag flows to objectives, and receive recommendations on what to keep, optimize, merge, or retire.

- **Objectives**: Declare business goals, tag flows to objectives
- **Signal collection**: Reads cost, quality, policy, execution, adapter, agent, scheduler, memory, and MCP server signals
- **Heuristic analysis**: 9 built-in checks (idle flows, disproportionate cost, quality decline, untagged flows, agent hard stops, etc.) plus custom heuristic extensibility
- **Model analysis**: Sends system profile to LLM through the engine's own model router for strategic recommendations
- **Autonomy levels**: Observe (signals only), Recommend (+ model recs), Advise (require acknowledgment), Enforce (auto-execute after grace period)
- **Events**: `discernment:signal`, `discernment:recommendation`, `discernment:cycle`

---

## Connections & Tools

### 009 — MCP Adapter Framework

Connect to external systems (Gmail, Slack, Calendar, databases, APIs) via the Model Context Protocol. Managed lifecycle with auto-reconnection and circuit breaker.

- **Tool routing**: O(1) qualified name lookup (`adapter.tool`)
- **Resource caching**: TTL-based lazy expiration
- **Reconnection**: Exponential backoff with circuit breaker gating
- **Reference configs**: Gmail, Slack, Calendar presets included

### 012 — MCP Server Interface

Expose registered flows as MCP tools so other AI agents and MCP clients can discover and invoke them.

- **Auto-discovery**: Flows published with input/output schemas
- **Events**: `flow:registered`, `flow:unregistered`

---

## Execution Patterns

### 013 — Scheduled Flows

Cron-based flow triggers with IANA timezone support, overlap prevention, and idempotency.

```yaml
scheduler:
  flows:
    daily-summary:
      cron: "0 8 * * *"
      timezone: America/New_York
```

- **Overlap prevention**: Skip trigger if previous execution still running
- **Events**: `scheduler:trigger`, `scheduler:skip`, `scheduler:registered`, `scheduler:removed`

### 014 — Agent Execution Pattern

Autonomous agent loops with tool calling, conversation management, and configurable stop conditions.

```typescript
engine.register('research-agent', createAgentHandler({
  systemPrompt: 'You are a research assistant.',
  maxIterations: 10,
  timeoutMs: 60000,
}));
```

- **Tool calling**: Agents discover and call adapter tools via `ctx.tools`
- **Stop conditions**: Max iterations, iteration budget, timeout, budget exceeded, context overflow
- **Conversation**: Message history management with configurable truncation
- **Output schema**: Optional JSON Schema for structured agent responses
- **Telemetry**: `agent.iteration` spans per loop iteration

---

## Infrastructure

### 010 — Configuration System

Declarative `runcor.yaml` with environment variable interpolation, schema validation, and factory-based provider/evaluator registration.

- **Env vars**: `${VAR}` syntax with optional defaults `${VAR:-fallback}`
- **Validation**: AJV-based schema validation with clear error messages
- **Factories**: Register custom providers and evaluators by type name
- **Auto-detect**: Finds `runcor.yaml` or `runcor.yml` in working directory

### 015 — Extended Model Interface

Messages array, tool definitions, and streaming support on the model interface. Enables multi-turn conversations and tool-use patterns.

### 016 — SQLite State Backend

Persistent execution storage using SQLite. Survives process restarts with full state machine semantics preserved.

- **WAL mode**: Concurrent reads during writes
- **Automatic migration**: Schema created on first use
- **Drop-in replacement**: Implements the same `StateStore` interface as in-memory

### 017 — HTTP Server Mode

REST and SSE API for remote engine management. Built on Hono with CORS, error handling, and event streaming.

- **13 endpoints**: Flows, executions, adapters, health, events
- **SSE streaming**: Real-time event subscription with filtering
- **CORS**: Configurable cross-origin support

### 018 — CLI Binary

Terminal interface for managing a running runcor instance.

```bash
runcor init my-project        # Scaffold a new project
runcor dev                    # Start local dev server
runcor trigger <flow> [input] # Trigger a flow
runcor resume <id> [data]     # Resume a waiting execution
runcor status [id]            # View execution status
```

### 019 — Structured Output

JSON Schema validation on model responses with automatic retry on parse failure.

- **Response format**: Pass `responseFormat` with JSON Schema to `ctx.model.complete()`
- **Validation**: Responses validated against schema, retried if invalid
- **Provider support**: Native structured output where supported, prompt-based fallback otherwise

### 021 — Built-in Dashboard UI

Read-only web dashboard served at `/v1/dashboard` by the HTTP server. Single self-contained HTML page with embedded CSS and JavaScript — no React, no bundler, no new dependencies.

- **Real-time execution feed**: SSE-driven cards showing state transitions, newest-first, 200 card cap
- **Execution detail overlay**: Click any card to see state timeline, cost breakdown per model call, evaluation scores
- **Adapter connections**: Real adapter status from the AdapterManager (replaces demo dummy animations) — name, state, tool count, health check timestamp
- **Provider health tab**: Circuit breaker states (healthy/unhealthy/half_open), priority, per-provider metrics
- **Cost summary tab**: Total spend with breakdowns by flow, by user, by provider
- **Discernment tab**: Business objectives, latest cycle report, active recommendations with action badges
- **Graceful degradation**: Panels hidden when subsystems are disabled — works from minimal (single provider) to fully loaded
- **Auto-reconnect**: Exponential backoff (1s→30s max) with connection status indicator
- **New API endpoints**: `GET /v1/providers`, `GET /v1/cost/summary`, `GET /v1/discernment`, `GET /v1/executions/:id/detail`, extended `GET /v1/health` with capabilities detection

---

## Test Coverage

| Category | Files | Tests |
|----------|-------|-------|
| Unit | 93 | ~1450 |
| Integration | 27 | ~350 |
| E2E | 10 | ~100 |
| Stress | 10 | ~50 |
| Contract | 3 | ~20 |
| **Total** | **143** | **2122** |
