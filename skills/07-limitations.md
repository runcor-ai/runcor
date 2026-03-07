# Known Limitations

> **Purpose**: Documents what the Runcor engine does NOT support, so Claude avoids generating code that won't work.
> **When to use**: Before generating any workflow code, check this file for unsupported patterns.

**Engine version**: 0.1.0 (19 features implemented)

## Do NOT Generate Code That Uses These

### 1. Per-Request Auth Delegation

The engine does not pass per-request authentication tokens to providers. Provider API keys are set at engine initialization time (in `runcor.yaml` or `EngineConfig`).

**Do NOT generate**:
- Per-request API key injection
- Token forwarding from workflow input to provider
- Dynamic provider credential switching

**Instead**: Configure provider API keys in `runcor.yaml` using `${ENV_VAR}` interpolation.

### 2. Adapter Concurrency Limits

The engine does not enforce concurrency limits on MCP adapter calls. Multiple concurrent calls to the same adapter are allowed but not coordinated.

**Do NOT generate**:
- Adapter-level concurrency configuration
- References to adapter queue settings
- Parallel adapter call throttling

**Instead**: Adapter calls execute as fast as the MCP server allows. If throttling is needed, implement it in the flow handler.

### 3. Trace Context Propagation for Adapters

OpenTelemetry trace context is not propagated to MCP adapter calls. Adapter operations are not linked to the parent execution span.

**Do NOT generate**:
- Distributed tracing across adapter calls
- References to adapter span context
- Trace header injection for adapters

**Instead**: Use `ctx.telemetry.addEvent()` to manually record adapter call events on the execution span.

### 4. Dashboard Mutation

The built-in dashboard at `/v1/dashboard` is strictly read-only. It cannot trigger, register, resume, or cancel flows.

**Do NOT generate**:
- Code that relies on dashboard mutation endpoints
- References to triggering flows from the dashboard UI

**Instead**: Use the REST API (`POST /v1/flows/:name/trigger`) or programmatic `engine.trigger()` for mutations.

## What IS Supported

For reference, these are all supported and documented in other skill files:

- Model calls via `ctx.model.complete()` with multi-provider routing (see `02-scaffolding.md`)
- Streaming responses via `ctx.model.stream()` (see `05-subsystems.md`)
- Structured output with JSON Schema validation via `responseFormat` (see `02-scaffolding.md`)
- Autonomous agents via `createAgentHandler()` with tool calling (see `02-scaffolding.md`)
- Scoped memory: tool, user, session (see `05-subsystems.md`)
- Cost tracking with multi-scope budgets (see `05-subsystems.md`)
- OpenTelemetry telemetry (see `05-subsystems.md`)
- Policy: rules, guardrails, rate limits, access control, tenants (see `05-subsystems.md`)
- Evaluation: scoring, confidence, human review flags (see `05-subsystems.md`)
- MCP adapters: stdio and SSE transports, reference configs (see `05-subsystems.md`)
- Wait/resume for human-in-the-loop (see `05-subsystems.md`)
- Execution lifecycle: retry, timeout, cancel, replay (see `06-lifecycle.md`)
- YAML config loading with env var interpolation (see `03-config-reference.md`)
- Cron-based scheduling with timezone support (see `05-subsystems.md`)
- Discernment: portfolio-level analysis with business objectives (see `05-subsystems.md`)
- HTTP server with REST/SSE API and built-in dashboard (see `03-config-reference.md`)
- CLI: `runcor init`, `runcor dev`, `runcor trigger`, `runcor resume`, `runcor status`
- SQLite persistent state backend (see `03-config-reference.md`)

## See Also

- `02-scaffolding.md` — Code generation rules and templates
- `04-api-reference.md` — The actual API surface (what IS supported)
- `05-subsystems.md` — Detailed guides for all supported subsystems
