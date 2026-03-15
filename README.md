<p align="center">
  <img src="https://runcor.ai/logo.svg" alt="runcor" width="64" />
</p>

<h1 align="center">runcor</h1>

<p align="center">
  <strong>The open-source AI runtime engine.</strong><br>
  Runcor handles model routing, retries, memory, cost tracking, and system connections —<br>
  and analyzes whether your AI operations are delivering business value.
</p>

<p align="center">
  Thin tools. Clean code.
</p>

<p align="center">
  <a href="https://runcor.ai">Website</a> ·
  <a href="https://runcor.ai/docs">Docs</a> ·
  <a href="https://demo.runcor.ai">Live Demo</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#features">Features</a> ·
  <a href="#contributing">Contributing</a> ·
  <a href="mailto:hello@runcor.ai">Contact</a>
</p>

<p align="center">
  <a href="https://github.com/runcor-ai/runcor/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://www.npmjs.com/package/runcor"><img src="https://img.shields.io/npm/v/runcor.svg" alt="npm" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js" /></a>
</p>

---

## Why runcor?

Every AI application rebuilds the same infrastructure: model routing, retry logic, authentication, cost tracking, memory management, external system connections. **runcor eliminates that redundancy.**

It's a platform runtime that sits between your application and foundation models — the same way Unreal Engine sits between hardware and games. You write the experience; the engine handles everything underneath.

```
┌─────────────────────────────────────────┐
│            Your AI Tools                │  ← Thin. Just workflow logic.
├─────────────────────────────────────────┤
│               runcor                    │  ← Handles everything else.
│  routing · memory · cost · policy       │
│  agents · eval · scheduling · telemetry │
├─────────────────────────────────────────┤
│          Foundation Models              │  ← Anthropic, OpenAI, Google, etc.
│          External Systems               │  ← Gmail, Slack, databases, APIs
└─────────────────────────────────────────┘
```

## Built for Every Layer

### Developers — The Runtime

Register flows in 10 lines. Swap providers without touching tool code. Run autonomous agents with tool calling. Schedule flows on cron. Expose flows as MCP tools. Stop rebuilding retries, routing, and model abstraction — the engine handles the rest.

### Businesses — Operational AI Workflows

Turn AI from an experiment into an operational tool your team relies on. Morning briefs, automated reports, customer workflows — connected to the systems you already use (Gmail, Slack, Calendar), with full cost visibility per request, per user, and per flow. Discernment analysis tells you what's worth keeping and what to retire.

### Enterprises — Governance at Scale

Deploy AI workflows across teams and tenants with the controls your security team demands. Multi-tenant isolation, declarative policy and access control, content guardrails, quality evaluation with human review flags, and OpenTelemetry-native observability that plugs into your existing stack (Datadog, Grafana, etc.).

---

## Quickstart

```bash
npm install runcor
```

Create a `runcor.yaml`:

```yaml
providers:
  - type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    models: [claude-sonnet-4-20250514]
```

Write a flow, agent, or app:

```typescript
import { createEngine } from 'runcor';

const engine = await createEngine(); // reads runcor.yaml

engine.register('morning-brief', async (ctx) => {
  const brief = await ctx.model.complete({
    prompt: 'Give me a one-paragraph summary of today\'s priorities.'
  });

  await ctx.memory.user.set('last-brief', brief.text);
  return brief.text;
});

await engine.trigger('morning-brief', {
  idempotencyKey: 'brief-2026-03-01'
});
```

That's it. runcor handles the model call, retries on failure, tracks token cost, manages memory, and logs the execution — your code is just the business logic.

### Try the demos

The repo ships with runnable examples — no API key required (they use the built-in MockProvider):

```bash
git clone https://github.com/runcor-ai/runcor.git
cd runcor
npm install

npm run smoke-test              # quick end-to-end check
npm run example:morning-brief   # full demo: mock data → LLM call → formatted brief
npm run dev                     # launch dashboard with 21 business flows
```

---

## Features

| Capability | What it does |
|---|---|
| **Model routing & fallbacks** | Priority, round-robin, or lowest-cost strategies across Anthropic, OpenAI, and Google. Circuit breakers and automatic failover. |
| **Durable execution** | Every flow runs through a managed state machine — queued, running, waiting, retrying, complete/failed. Concurrency control with FIFO queue. |
| **Wait / resume / replay** | Pause for human approval or async callbacks. Resume with data. Replay completed executions. |
| **Cost tracking** | Per-request, per-user, per-flow, and global budgets with hard/soft enforcement. Queryable cost ledger. |
| **Scoped memory** | Tool, user, and session memory scopes. In-memory default, pluggable backends. |
| **External connections** | MCP adapters for Gmail, Slack, calendars, and any compatible service. Managed lifecycle with auto-reconnection. |
| **Policy & guardrails** | Declarative rules, rate limiting, access control, content guardrails. Per-tenant config overrides. |
| **Quality evaluation** | Score outputs for quality, confidence, and correctness. Flag for human review. Built-in + custom evaluators. |
| **Agent execution** | Autonomous agent loops with tool calling, conversation management, hard stops, iteration budgets, and output schemas. |
| **Scheduled flows** | Cron-based triggers with IANA timezone support, overlap prevention, and idempotency. |
| **Structured output** | JSON Schema validation on model responses with automatic retry on parse failure. |
| **Discernment** | Portfolio-level analysis: declare business objectives, track signals across all subsystems, get recommendations on what to keep, optimize, merge, or retire. |
| **HTTP server** | REST and SSE API with 16 endpoints for remote engine management. Built-in dashboard included. |
| **CLI** | `runcor init`, `runcor dev`, `runcor trigger`, `runcor resume`, `runcor status`. |
| **OpenTelemetry native** | Traces, metrics, and structured logs. Plug in Datadog, Grafana, or any OTel-compatible backend. |
| **Declarative config** | One `runcor.yaml` for providers, connections, budgets, policies, scheduling, and telemetry. Env var interpolation built in. |
| **SQLite persistence** | Durable execution state that survives process restarts. Drop-in replacement for in-memory store. |
| **MCP server** | Expose registered flows as MCP tools for other AI agents to discover and invoke. |
| **Built-in dashboard** | Read-only monitoring UI at `/v1/dashboard` — real-time execution feed, detail overlay, adapter status, provider health, cost summary, discernment panel. Zero new dependencies. |

See the [full documentation](https://runcor.ai/docs) for the API reference, configuration schema, and usage examples.

---

## Architecture

runcor is a **capabilities layer**, not an autonomous agent framework. Like a game engine that provides physics, rendering, and audio for games to call, runcor provides the infrastructure your AI tools run on — routing, memory, cost, policy, execution, and discernment — so your code stays focused on business logic. Your tools make the decisions; runcor handles the infrastructure.

```typescript
engine.register('my-tool', async (ctx) => {
  // ctx.model     → LLM calls (routing, retries, cost tracking, structured output)
  // ctx.memory    → Scoped persistence (tool, user, session)
  // ctx.tools     → External systems via adapters (Gmail, Slack, etc.)
  // ctx.cost      → Execution cost so far
  // ctx.telemetry → Custom instrumentation
});
```

```
┌─────────────────────────────────────────────┐
│              runcor Engine                  │
│  ┌────────────────────────────────────────┐ │
│  │ Core Runtime                           │ │
│  │  ├─ Memory              Scoped state   │ │
│  │  ├─ Model Router        Multi-provider │ │
│  │  ├─ Cost Tracking       Budgets        │ │
│  │  ├─ Observability       OpenTelemetry  │ │
│  │  ├─ Wait/Resume         Async pauses   │ │
│  │  ├─ Policy              Rules/guards   │ │
│  │  ├─ Evaluation          Quality scores │ │
│  │  ├─ Adapters            MCP tools      │ │
│  │  ├─ Config              YAML loading   │ │
│  │  ├─ MCP Server          Expose flows   │ │
│  │  ├─ Scheduler           Cron triggers  │ │
│  │  ├─ Agents              Tool loops     │ │
│  │  ├─ SQLite State        Persistence    │ │
│  │  ├─ HTTP Server         REST/SSE API   │ │
│  │  ├─ CLI                 Terminal UI    │ │
│  │  ├─ Structured Output   JSON Schema    │ │
│  │  └─ Discernment         Portfolio ops  │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### Design Principles

- **Engine-first**: All cross-cutting concerns live in the engine, not in tools
- **Provider agnostic**: Swap models and providers without touching tool code
- **Request isolation**: Every execution is sandboxed — no shared mutable state
- **Observable by default**: Every operation produces traces, metrics, and logs
- **Graceful degradation**: Retries, fallbacks, circuit breakers, drain on shutdown

---

## Configuration

Everything lives in `runcor.yaml`:

```yaml
engine:
  concurrency: 50
  drainTimeout: 10000

providers:
  - type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    priority: 1
    models: [claude-sonnet-4-20250514]
  - type: openai
    apiKey: ${OPENAI_API_KEY}
    priority: 2
    models: [gpt-4o]

routing:
  strategy: priority
  maxFallbackAttempts: 3

connections:
  - name: gmail
    preset: gmail
    url: ${GMAIL_MCP_URL}
  - name: slack
    preset: slack
    url: ${SLACK_MCP_URL}

costs:
  budgets:
    perRequest:
      limit: 0.50
      enforcement: hard
    global:
      limit: 100.00
      enforcement: soft

policy:
  rateLimits:
    - name: per-user
      scope: user
      limit: 100
      windowMs: 3600000

evaluation:
  evaluators:
    - type: length
      config:
        minLength: 50
  autoFlagScoreThreshold: 0.3

scheduler:
  flows:
    daily-summary:
      cron: "0 8 * * *"
      timezone: America/New_York

discernment:
  enabled: true
  autonomy: recommend
  schedule: daily

objectives:
  - name: operational-visibility
    description: "Leadership has daily visibility into business metrics"
  - name: customer-retention
    description: "Reduce support ticket volume through proactive outreach"

telemetry:
  serviceName: my-app
```

Secrets use `${ENV_VAR}` syntax with optional defaults: `${VAR:-fallback}`.

---

## Requirements

- Node.js 20+
- TypeScript 5.x (recommended)

---

## Development

```bash
git clone https://github.com/runcor-ai/runcor.git
cd runcor
npm install
npm test              # 2122 tests across 143 files
npm run build         # compile TypeScript
npm run smoke-test    # quick end-to-end check
npm run dev           # launch demo dashboard
```

---

## Claude Code Skills

The `skills/` directory contains 9 structured knowledge files that teach [Claude Code](https://claude.ai/claude-code) the runcor API. When you open this repo in Claude Code, it can generate correct runcor code — flows, agents, config, policy, and more — without hallucinating method names or field types.

```
skills/
├── 01-contract.md          # Public API surface and exports
├── 02-scaffolding.md       # Project structure and type references
├── 03-config-reference.md  # Full runcor.yaml schema
├── 04-api-reference.md     # Engine methods and signatures
├── 05-subsystems.md        # Memory, cost, policy, eval, adapters, telemetry
├── 06-lifecycle.md         # Execution states, events, retry logic
├── 07-limitations.md       # What the engine does NOT support
├── 08-example-simple.md    # Simple flow example
└── 09-example-advanced.md  # Multi-tool agent example
```

---

## Project Status

runcor is in active development with **19 features implemented** and **2122 passing tests** across 143 test files. The core engine, model routing, memory, cost tracking, policy, evaluation, adapters, agents, scheduling, HTTP server, CLI, structured output, discernment, and built-in dashboard are all implemented and tested.

---

## Contributing

Contributions are welcome. Fork the repo, create a feature branch, and open a PR.

- All PRs must pass the existing test suite
- New features require tests (TDD approach — tests first)
- Follow the existing code style (Prettier + ESLint)
- See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

<p align="center">
  <a href="https://runcor.ai">runcor.ai</a> ·
  <a href="https://github.com/runcor-ai/runcor">GitHub</a> ·
  <a href="https://www.npmjs.com/package/runcor">npm</a> ·
  <a href="https://discord.gg/dyzHxEyg">Discord</a> ·
  <a href="mailto:hello@runcor.ai">hello@runcor.ai</a>
</p>
