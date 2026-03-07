# runcor.yaml Configuration Reference

> **Purpose**: Complete reference for every field in `runcor.yaml` so Claude can generate valid configuration files.
> **When to use**: When a developer asks Claude to generate or modify a `runcor.yaml` config file.

## Overview

The `runcor.yaml` file configures the engine. All sections are optional. The engine discovers the file automatically:

1. Explicit path via `LoadConfigOptions.path`
2. `RUNCOR_CONFIG` environment variable
3. Auto-detect `runcor.yaml` or `runcor.yml` in the current directory

Environment variables use `${VAR}` interpolation syntax. The engine replaces `${VAR}` with the value of the environment variable at load time.

The TypeScript type is `RuncorConfigFile` (see `04-api-reference.md`).

## Sections

### engine

Engine-level runtime settings.

| Field | Type | Required | Default | Description | Example |
|-------|------|----------|---------|-------------|---------|
| `concurrency` | number | No | `100` | Max simultaneous running executions | `50` |
| `drainTimeout` | number | No | `10000` | Shutdown drain period in ms | `5000` |
| `retentionPeriod` | number | No | `3600` | Seconds to keep terminal executions (0 = forever) | `7200` |

### providers

Array of model provider configurations. At least one provider is required for model calls.

| Field | Type | Required | Default | Description | Example |
|-------|------|----------|---------|-------------|---------|
| `type` | string | Yes | — | Provider type: `anthropic`, `openai`, `ollama`, `mock` | `anthropic` |
| `apiKey` | string | No | — | API key (use `${VAR}` for env vars) | `${ANTHROPIC_API_KEY}` |
| `baseUrl` | string | No | — | Custom API base URL | `http://localhost:11434` |
| `priority` | number | No | `1` | Routing priority (lower = higher priority) | `2` |
| `models` | string[] | No | — | Supported model identifiers | `["claude-sonnet-4-20250514"]` |
| `costPerToken` | object | No | — | Token costs for lowest-cost routing | `{ input: 0.003, output: 0.015 }` |

### routing

Model routing strategy configuration.

| Field | Type | Required | Default | Description | Example |
|-------|------|----------|---------|-------------|---------|
| `strategy` | string | No | `priority` | Routing strategy: `priority`, `round-robin`, `lowest-cost` | `round-robin` |
| `maxFallbackAttempts` | number | No | `providers.length - 1` | Max additional providers to try after primary fails | `2` |
| `failureThreshold` | number | No | `5` | Failures before circuit breaker trips | `3` |
| `cooldownMs` | number | No | `30000` | Circuit breaker cooldown in ms | `60000` |

### connections

Array of MCP adapter connections to external systems.

| Field | Type | Required | Default | Description | Example |
|-------|------|----------|---------|-------------|---------|
| `name` | string | Yes | — | Unique identifier for this connection | `slack` |
| `preset` | string | No | — | Built-in preset: `gmail`, `slack`, `calendar` | `slack` |
| `transport` | string | No | — | Transport type: `stdio`, `sse` (required if no preset) | `stdio` |
| `command` | string | No | — | Command to launch MCP server (stdio only) | `npx` |
| `args` | string[] | No | — | Arguments for the command | `["-y", "@modelcontextprotocol/server-slack"]` |
| `url` | string | No | — | Endpoint URL (sse only) | `http://localhost:3001/sse` |
| `headers` | object | No | — | HTTP headers for SSE transport | `{ "Authorization": "Bearer ${TOKEN}" }` |
| `timeoutMs` | number | No | `30000` | Per-operation timeout in ms | `10000` |
| `retryAttempts` | number | No | `3` | Max retry attempts for failed operations | `5` |
| `retryDelayMs` | number | No | `1000` | Base delay for exponential backoff in ms | `2000` |
| `healthCheckIntervalMs` | number | No | `30000` | Health check interval (0 to disable) | `60000` |

### costs

Cost tracking and budget enforcement configuration.

| Field | Type | Required | Default | Description | Example |
|-------|------|----------|---------|-------------|---------|
| `warningThreshold` | number | No | `0.8` | Budget utilization fraction to trigger warning (0-1) | `0.9` |
| `defaultTokenEstimate` | number | No | `1000` | Token estimate when maxTokens not in request | `500` |
| `maxLedgerEntries` | number | No | `100000` | Max entries before FIFO eviction | `50000` |
| `budgets` | object | No | — | Budget scope configurations (see below) | — |

#### budgets

| Field | Type | Required | Default | Description | Example |
|-------|------|----------|---------|-------------|---------|
| `budgets.perRequest` | object | No | — | Per-request budget | `{ limit: 0.50 }` |
| `budgets.perUser` | object | No | — | Per-user budget | `{ limit: 10.00, window: { type: daily } }` |
| `budgets.perFlow` | object | No | — | Per-flow budget | `{ limit: 5.00, window: { type: hourly } }` |
| `budgets.global` | object | No | — | Global budget | `{ limit: 100.00, window: { type: monthly } }` |

Each budget scope has:

| Field | Type | Required | Default | Description | Example |
|-------|------|----------|---------|-------------|---------|
| `limit` | number | Yes | — | Max cost units in window | `5.00` |
| `enforcement` | string | No | `hard` | `hard` (block), `soft` (warn only), `disabled` | `soft` |
| `window.type` | string | No | `none`/`daily` | `hourly`, `daily`, `monthly`, `custom`, `none` | `daily` |
| `window.durationMs` | number | No | — | Required when type is `custom` | `3600000` |

### telemetry

OpenTelemetry and logging configuration.

| Field | Type | Required | Default | Description | Example |
|-------|------|----------|---------|-------------|---------|
| `serviceName` | string | No | `runcor` | Service name for tracer/meter identity | `my-tool` |
| `serviceVersion` | string | No | package version | Service version | `1.0.0` |
| `memorySpans` | boolean | No | `false` | Enable spans for memory operations (debug) | `true` |

### policy

Policy rules, rate limits, access control, and tenant configuration.

#### policy.rateLimits

Array of rate limit rules.

| Field | Type | Required | Default | Description | Example |
|-------|------|----------|---------|-------------|---------|
| `name` | string | Yes | — | Unique rule name | `global-limit` |
| `scope` | string | Yes | — | `user`, `flow`, `global` | `user` |
| `limit` | number | Yes | — | Max requests per window | `100` |
| `windowMs` | number | Yes | — | Time window in ms | `3600000` |
| `behavior` | string | No | `reject` | `reject` or `queue` | `queue` |
| `maxQueueDepth` | number | No | `100` | Max queued requests (queue behavior) | `50` |
| `queueTimeoutMs` | number | No | `30000` | Queue timeout in ms | `10000` |
| `flowName` | string | No | — | Apply to specific flow only | `expensive-flow` |

#### policy.accessPolicies

Array of identity-based access control rules.

| Field | Type | Required | Default | Description | Example |
|-------|------|----------|---------|-------------|---------|
| `identity` | string | Yes | — | User or tenant ID (`*` for wildcard) | `admin-user` |
| `allowedFlows` | string[] | No | all | Allowed flow names | `["read-flow"]` |
| `deniedFlows` | string[] | No | none | Denied flow names (deny > allow) | `["admin-reset"]` |
| `allowedOperations` | string[] | No | all | `trigger`, `resume`, `replay`, `listWaiting` | `["trigger"]` |
| `deniedOperations` | string[] | No | none | Denied operations | `["replay"]` |

#### policy.tenants

Array of tenant-scoped configurations.

| Field | Type | Required | Default | Description | Example |
|-------|------|----------|---------|-------------|---------|
| `tenantId` | string | Yes | — | Unique tenant identifier | `acme-corp` |
| `rateLimits` | array | No | — | Tenant-specific rate limits | — |
| `allowedFlows` | string[] | No | all | Flows this tenant can trigger | `["basic-flow"]` |
| `accessPolicies` | array | No | — | Tenant-scoped access policies | — |

### evaluation

Quality scoring and human review configuration.

| Field | Type | Required | Default | Description | Example |
|-------|------|----------|---------|-------------|---------|
| `autoFlagScoreThreshold` | number | No | — | Auto-flag for review below this score | `0.5` |

#### evaluation.evaluators

Array of built-in evaluator declarations.

| Field | Type | Required | Default | Description | Example |
|-------|------|----------|---------|-------------|---------|
| `type` | string | Yes | — | Evaluator type: `length`, `format`, `keyword` | `length` |
| `name` | string | No | type | Unique evaluator name | `response-length` |
| `weight` | number | No | `1` | Scoring weight | `2` |
| `config` | object | No | — | Type-specific configuration | `{ minLength: 100 }` |

## Complete Examples

### Example 1: Minimal (development)

```yaml
# Minimal config — one mock provider
providers:
  - type: mock
```

### Example 2: Typical (single provider with routing)

```yaml
# Two providers with priority fallback
providers:
  - type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}  # Set in your .env file
    priority: 1
  - type: openai
    apiKey: ${OPENAI_API_KEY}  # Fallback provider
    priority: 2

routing:
  strategy: priority
  maxFallbackAttempts: 1
```

### Example 3: Full-featured

```yaml
# Full config with adapters, budgets, telemetry, policy, and evaluation
engine:
  concurrency: 50
  drainTimeout: 5000

providers:
  - type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    priority: 1
    models:
      - claude-sonnet-4-20250514
    costPerToken:
      input: 0.003
      output: 0.015
  - type: openai
    apiKey: ${OPENAI_API_KEY}
    priority: 2

routing:
  strategy: lowest-cost
  failureThreshold: 3
  cooldownMs: 60000

connections:
  - name: slack
    preset: slack
  - name: custom-api
    transport: sse
    url: ${CUSTOM_API_URL}
    headers:
      Authorization: "Bearer ${CUSTOM_API_TOKEN}"

costs:
  warningThreshold: 0.9
  budgets:
    perRequest:
      limit: 0.50
    perUser:
      limit: 10.00
      window:
        type: daily
    global:
      limit: 100.00
      enforcement: hard
      window:
        type: monthly

telemetry:
  serviceName: my-production-tool

policy:
  rateLimits:
    - name: user-hourly
      scope: user
      limit: 100
      windowMs: 3600000
  accessPolicies:
    - identity: "*"
      allowedOperations:
        - trigger

evaluation:
  autoFlagScoreThreshold: 0.5
  evaluators:
    - type: length
      config:
        minLength: 50
        maxLength: 5000
    - type: keyword
      config:
        requiredKeywords:
          - summary
          - conclusion
```

---

## scheduler (Scheduled Flows)

```yaml
scheduler:
  defaultTimezone: America/New_York     # IANA timezone, default for all scheduled flows

  flows:
    daily-summary:
      cron: "0 8 * * *"                # Standard cron expression
      timezone: America/New_York        # Per-flow timezone override
    hourly-check:
      cron: "0 * * * *"
```

Alternatively, schedule flows programmatically via `FlowConfig`:

```typescript
engine.register('daily-summary', handler, {
  schedule: '0 8 * * *',
  timezone: 'America/New_York',
});
```

---

## discernment (Portfolio Analysis)

```yaml
discernment:
  enabled: true
  autonomy: recommend       # observe | recommend | advise | enforce
  schedule: daily            # How often to run analysis cycles
  provider: anthropic        # Optional: specific provider for analysis (uses default route if omitted)
  lookbackPeriod: 604800     # Seconds to look back for signals (default: 7 days)
  gracePeriod: 86400         # Seconds before enforce actions execute (default: 24h)
  prompt: "Custom analysis prompt."  # Override the default analysis prompt
  thresholds:
    idleFlowDays: 14                   # Days of inactivity before flagging
    disproportionateCostPercent: 0.5   # Cost share threshold for flagging
    qualityDeclinePercent: 0.1         # Quality drop threshold
    agentHardStopPercent: 0.3          # Agent hard-stop rate threshold
```

### objectives (Business Objectives)

```yaml
objectives:
  - name: operational-visibility
    description: "Leadership has daily visibility into business metrics"
  - name: customer-retention
    description: "Reduce support ticket volume through proactive outreach"
```

---

## server (HTTP Server & Dashboard)

The HTTP server is started programmatically, not via YAML. But the MCP server can be configured:

```yaml
server:
  enabled: true
  name: my-runcor-instance
```

Starting the HTTP server:

```typescript
import { createServer } from 'runcor';

const server = createServer(engine, {
  port: 3000,
  hostname: '0.0.0.0',
  basePath: '',             # Prefix before /v1
  cors: true,               # Enable CORS (or pass CorsOptions object)
  shutdownTimeout: 30000,   # Graceful shutdown timeout
});

await server.start();
// Dashboard at http://localhost:3000/v1/dashboard
```

---

## state (Persistent Storage)

```yaml
state:
  backend: sqlite
  path: ./runcor.db         # SQLite database file path
```

Or programmatically:

```typescript
import { SQLiteStateStore } from 'runcor';

const engine = await createEngine({
  model: { providers: [...] },
  state: { store: new SQLiteStateStore('./runcor.db') },
});
```

---

## See Also

- `02-scaffolding.md` — Uses config patterns from this reference during workflow generation
- `04-api-reference.md` — `RuncorConfigFile` type and `loadConfig()` function
- `05-subsystems.md` — How each config section maps to runtime subsystem usage
