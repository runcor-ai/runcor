# Engine Subsystem Usage Guides

> **Purpose**: Per-subsystem reference for using Runcor engine features from within a tool's flow handler.
> **When to use**: When building a tool that needs memory, cost tracking, telemetry, evaluation, adapters, wait/resume, or any other engine subsystem beyond basic model calls.

## 1. Model Calls

Every flow handler receives `ctx.model` for provider-agnostic model interaction. The engine handles provider selection, routing, fallback, and circuit breaking — your tool just composes prompts and handles responses.

### API

```typescript
const response = await ctx.model.complete(request);
```

- **`request.prompt`**: The text prompt to send to the model
- **`request.model`** (optional): Target a specific model identifier
- **`request.maxTokens`** (optional): Maximum tokens in the response
- **`response.text`**: The model's text response
- **`response.model`**: Which model actually handled the request
- **`response.usage`**: `{ promptTokens, completionTokens }`

### Example

```typescript
import { createEngine, MockProvider } from 'runcor';
import type { FlowHandler, EngineConfig } from 'runcor';

interface SummaryInput {
  text: string;
}

const summarize: FlowHandler = async (ctx) => {
  const input = ctx.input as SummaryInput;

  const response = await ctx.model.complete({
    prompt: `You are a concise summarizer. Summarize this: ${input.text}`,
    maxTokens: 200,
  });

  return { summary: response.text, model: response.model };
};

const config: EngineConfig = {
  model: { providers: [{ provider: new MockProvider() }] },
};

const engine = await createEngine(config);
engine.register('summarize', summarize);

const execution = await engine.trigger('summarize', {
  idempotencyKey: crypto.randomUUID(),
  input: { text: 'A long article about climate change...' },
});

console.log('Result:', execution.result);
await engine.shutdown();
```

### Key Points

- Never call a provider directly — always use `ctx.model.complete()`
- The engine routes the request to the best available provider based on the configured strategy
- If one provider fails, the engine automatically falls back to the next provider
- Cost tracking happens automatically if configured — you don't need to instrument model calls

---

## 2. Scoped Memory

The engine provides three memory scopes via `ctx.memory`. Each scope has the same API (`get`, `set`, `delete`, `list`) but stores data in isolated namespaces.

### Scopes

| Scope | Access via | Persists across | Use for |
|-------|-----------|----------------|---------|
| **Tool** | `ctx.memory.tool` | All executions of this flow | Flow-global settings, shared caches |
| **User** | `ctx.memory.user` | Executions by the same `userId` | User preferences, conversation history |
| **Session** | `ctx.memory.session` | Executions with the same `sessionId` | Multi-turn conversation state |

User and session scopes require `userId` or `sessionId` in the trigger options.

### API

```typescript
// Get a value (returns null if not found)
const value = await ctx.memory.tool.get<string>('my-key');

// Set a value (optional TTL in seconds)
await ctx.memory.tool.set('my-key', 'my-value');
await ctx.memory.tool.set('temp-key', 'expires-soon', 3600); // 1 hour TTL

// Delete a value
await ctx.memory.tool.delete('my-key');

// List all keys in this scope
const keys = await ctx.memory.tool.list();
```

### Example

```typescript
import { createEngine, MockProvider } from 'runcor';
import type { FlowHandler, EngineConfig } from 'runcor';

interface ChatInput {
  message: string;
}

const chat: FlowHandler = async (ctx) => {
  const input = ctx.input as ChatInput;

  // Load conversation history from user memory
  const history = await ctx.memory.user.get<string[]>('history') ?? [];

  // Build prompt with context
  const context = history.length > 0
    ? `Previous messages: ${history.join('; ')}\n\n`
    : '';

  const response = await ctx.model.complete({
    prompt: `${context}${input.message}`,
  });

  // Save updated history
  history.push(input.message);
  await ctx.memory.user.set('history', history);

  return { reply: response.text };
};

const config: EngineConfig = {
  model: { providers: [{ provider: new MockProvider() }] },
};

const engine = await createEngine(config);
engine.register('chat', chat);

const execution = await engine.trigger('chat', {
  idempotencyKey: crypto.randomUUID(),
  input: { message: 'Hello!' },
  userId: 'user-123', // Required for ctx.memory.user
});

console.log('Reply:', execution.result);
await engine.shutdown();
```

### Key Points

- Memory is key-value based — keys are strings, values are any serializable data
- Generic type parameter on `get<T>()` gives you typed results
- Always provide `userId` in trigger options when using `ctx.memory.user`
- Always provide `sessionId` in trigger options when using `ctx.memory.session`
- The default backend is `InMemoryStore` — data resets when the process exits

---

## 3. Cost Tracking

The engine tracks token usage and cost automatically for every `ctx.model.complete()` call. Your flow handler can read cost information via `ctx.cost`.

### API

```typescript
// Read-only cost info for the current execution
ctx.cost.executionTotal  // Total cost accumulated so far
ctx.cost.requestCount    // Number of model requests made
```

Cost tracking is configured in `runcor.yaml` or `EngineConfig`. The engine enforces budgets automatically — if a hard budget is exceeded, the next model call throws `BudgetExceededError`.

### Config

```yaml
providers:
  - type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    costPerToken:
      input: 0.003
      output: 0.015

costs:
  budgets:
    perRequest:
      limit: 0.50
    global:
      limit: 100.00
      window:
        type: daily
```

### Example

```typescript
import { createEngine, MockProvider } from 'runcor';
import type { FlowHandler, EngineConfig, CostPerToken } from 'runcor';

const costAware: FlowHandler = async (ctx) => {
  const input = ctx.input as { query: string };

  const response = await ctx.model.complete({
    prompt: input.query,
  });

  // Check cost after the call
  const totalCost = ctx.cost.executionTotal;
  const requestsMade = ctx.cost.requestCount;

  return {
    answer: response.text,
    cost: totalCost,
    requests: requestsMade,
  };
};

const config: EngineConfig = {
  model: {
    providers: [{
      provider: new MockProvider(),
      costPerToken: { input: 0.003, output: 0.015 },
    }],
  },
  cost: {
    budgets: {
      perRequest: { limit: 0.50 },
    },
  },
};

const engine = await createEngine(config);
engine.register('cost-aware', costAware);

const execution = await engine.trigger('cost-aware', {
  idempotencyKey: crypto.randomUUID(),
  input: { query: 'Explain quantum computing' },
});

console.log('Result:', execution.result);
await engine.shutdown();
```

### Key Points

- Cost tracking requires `costPerToken` on at least one provider
- `ctx.cost` is read-only — the engine manages all tracking and enforcement
- Budget scopes: `perRequest`, `perUser`, `perFlow`, `global`
- Hard enforcement blocks the request; soft enforcement emits a warning event
- Listen for `cost:budget_warning` and `cost:budget_exceeded` events on the engine for monitoring

---

## 4. Telemetry

The engine provides OpenTelemetry-based observability via `ctx.telemetry`. Add custom attributes, events, and child spans to the execution trace.

### API

```typescript
// Add a custom attribute to the execution span
ctx.telemetry.setAttribute('my.attribute', 'value');

// Add a timestamped event
ctx.telemetry.addEvent('my-event', { key: 'value' });

// Create a child span for a subsection of work
const result = await ctx.telemetry.startSpan('my-operation', async (span) => {
  span.addEvent('step-1-complete');
  // ... do work
  return 'result';
});

// Access the raw active span
ctx.telemetry.activeSpan;
```

### Example

```typescript
import { createEngine, MockProvider } from 'runcor';
import type { FlowHandler, EngineConfig } from 'runcor';

const traced: FlowHandler = async (ctx) => {
  const input = ctx.input as { url: string };

  ctx.telemetry.setAttribute('input.url', input.url);

  // Wrap a subsection of work in a child span
  const fetched = await ctx.telemetry.startSpan('fetch-content', async (span) => {
    span.addEvent('fetch-start', { url: input.url });
    // Simulate fetching content
    const content = `Content from ${input.url}`;
    span.addEvent('fetch-complete', { length: content.length });
    return content;
  });

  ctx.telemetry.addEvent('content-fetched', { length: fetched.length });

  const response = await ctx.model.complete({
    prompt: `Summarize: ${fetched}`,
  });

  return { summary: response.text };
};

const config: EngineConfig = {
  model: { providers: [{ provider: new MockProvider() }] },
  telemetry: {
    serviceName: 'my-tool',
  },
};

const engine = await createEngine(config);
engine.register('traced', traced);

const execution = await engine.trigger('traced', {
  idempotencyKey: crypto.randomUUID(),
  input: { url: 'https://example.com/article' },
});

console.log('Result:', execution.result);
await engine.shutdown();
```

### Key Points

- Telemetry works even without an OTel provider configured — operations are no-ops with no overhead
- To export traces, configure `tracerProvider` and `meterProvider` in the engine config
- The engine automatically creates spans for execution lifecycle, model calls, and cost events
- Use `ctx.telemetry.startSpan()` to instrument custom business logic within your flow
- Structured logging is available via the `logHandler` callback in telemetry config

---

## 5. Policy

Policy rules, guardrails, rate limits, access control, and tenants are enforced transparently by the engine. Tools do not interact with policy directly — it happens before and after your flow handler runs.

### How It Works

1. **Policy rules** evaluate before an operation (`trigger`, `resume`, `replay`) and can `allow`, `deny`, or `modify` the input
2. **Guardrails** inspect content on `input` (before your handler) and `output` (after your handler) and can `pass`, `block`, `warn`, or `transform`
3. **Rate limits** control how many requests a user/flow/global scope can make per time window
4. **Access policies** restrict which users/tenants can use which flows and operations
5. **Tenants** scope rate limits, allowed flows, and guardrail overrides per tenant

### Config

```yaml
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
  tenants:
    - tenantId: acme-corp
      allowedFlows:
        - basic-flow
      rateLimits:
        - name: acme-limit
          scope: user
          limit: 50
          windowMs: 3600000
```

### Example (Programmatic Config)

```typescript
import { createEngine, MockProvider } from 'runcor';
import type { FlowHandler, EngineConfig, PolicyRule } from 'runcor';

const handler: FlowHandler = async (ctx) => {
  const input = ctx.input as { query: string };
  const response = await ctx.model.complete({
    prompt: input.query,
  });
  return { answer: response.text };
};

// A custom policy rule that blocks certain users
const blockList: PolicyRule = {
  name: 'blocklist',
  priority: 1,
  operations: ['trigger'],
  evaluate: (context) => {
    if (context.userId === 'banned-user') {
      return { action: 'deny', reason: 'User is banned' };
    }
    return { action: 'allow', reason: null };
  },
};

const config: EngineConfig = {
  model: { providers: [{ provider: new MockProvider() }] },
  policy: {
    rules: [blockList],
    rateLimits: [{
      name: 'global-limit',
      scope: 'global',
      limit: 1000,
      windowMs: 3600000,
    }],
  },
};

const engine = await createEngine(config);
engine.register('query', handler);

const execution = await engine.trigger('query', {
  idempotencyKey: crypto.randomUUID(),
  input: { query: 'Hello' },
  userId: 'normal-user',
});

console.log('Result:', execution.result);
await engine.shutdown();
```

### Key Points

- Policy is transparent — your flow handler doesn't need to check permissions
- If a policy rule denies an operation, the engine throws an `EngineError` with code `POLICY_DENIED`
- Rate limits use sliding window counters; behavior is `reject` (throw) or `queue` (wait for capacity)
- Access policies: deny rules always take precedence over allow rules
- Tenant ID is set via `tenantId` in trigger options; tenant config overrides engine-level policy
- Listen for `policy:violation`, `policy:warning`, and `policy:rate_limited` events for monitoring

---

## 6. Evaluation

The evaluation subsystem scores completed executions for quality. Evaluators run automatically after a flow handler completes. Tools don't call evaluators directly — you configure them and the engine does the rest.

### Built-in Evaluators

| Factory | What it checks | Config |
|---------|---------------|--------|
| `createLengthEvaluator()` | Output text length | `{ name, minLength?, maxLength? }` |
| `createFormatEvaluator()` | Output type/format | `{ name, expectedFormat }` |
| `createKeywordEvaluator()` | Required/forbidden keywords | `{ name, required?, forbidden? }` |

### Config

```yaml
evaluation:
  autoFlagScoreThreshold: 0.5
  evaluators:
    - type: length
      config:
        minLength: 50
        maxLength: 5000
    - type: keyword
      config:
        required:
          - summary
          - conclusion
```

### Example (Programmatic Config)

```typescript
import { createEngine, MockProvider, createLengthEvaluator } from 'runcor';
import type { FlowHandler, EngineConfig, Evaluator } from 'runcor';

const handler: FlowHandler = async (ctx) => {
  const input = ctx.input as { topic: string };
  const response = await ctx.model.complete({
    prompt: `Write about: ${input.topic}`,
  });
  return { content: response.text };
};

// Built-in evaluator: check output length
const lengthEval: Evaluator = createLengthEvaluator({
  name: 'response-length',
  minLength: 50,
  maxLength: 5000,
});

// Custom evaluator
const customEval: Evaluator = {
  name: 'topic-relevance',
  priority: 100,
  evaluate: (context) => {
    const output = context.output as { content: string };
    const input = context.input as { topic: string };
    const relevant = output.content.toLowerCase().includes(input.topic.toLowerCase());
    return {
      scores: { relevance: relevant ? 1.0 : 0.2 },
      labels: relevant ? ['on-topic'] : ['off-topic'],
      feedback: relevant ? null : 'Response may not address the requested topic',
    };
  },
};

const config: EngineConfig = {
  model: { providers: [{ provider: new MockProvider() }] },
  evaluation: {
    evaluators: [lengthEval, customEval],
    autoFlagScoreThreshold: 0.5,
  },
};

const engine = await createEngine(config);
engine.register('writer', handler);

// Listen for evaluation results
engine.on('eval:complete', (event) => {
  console.log('Overall score:', event.overallScore);
  console.log('Confidence:', event.confidence);
});

engine.on('eval:flagged', (event) => {
  console.log('Flagged for review:', event.reason);
});

const execution = await engine.trigger('writer', {
  idempotencyKey: crypto.randomUUID(),
  input: { topic: 'machine learning' },
});

console.log('Result:', execution.result);
await engine.shutdown();
```

### Key Points

- Evaluators run after the flow completes — they don't block the response
- Each evaluator returns scores (0.0-1.0), optional labels, and optional feedback
- The engine computes an aggregate `overallScore` and derives a `confidence` level (high/medium/low)
- `autoFlagScoreThreshold` triggers automatic human review flags for low-quality outputs
- Listen for `eval:score`, `eval:complete`, and `eval:flagged` events for monitoring
- Custom evaluators implement the `Evaluator` interface with an `evaluate` function

---

## 7. MCP Adapters

Adapters connect the engine to external systems via the Model Context Protocol (MCP). Configure adapters in `runcor.yaml` and they connect automatically on engine startup.

### Transports

| Transport | Config | Use for |
|-----------|--------|---------|
| `stdio` | `command` + `args` | Local MCP servers (npx-launched) |
| `sse` | `url` + optional `headers` | Remote MCP servers |

### Config

```yaml
connections:
  - name: slack
    preset: slack  # Built-in preset (includes command + args)
  - name: custom-api
    transport: sse
    url: ${CUSTOM_API_URL}
    headers:
      Authorization: "Bearer ${CUSTOM_API_TOKEN}"
    timeoutMs: 10000
```

### Presets

Three built-in presets provide pre-configured MCP server connections:

| Preset | Package | Tools provided |
|--------|---------|---------------|
| `slack` | `@anthropic/mcp-server-slack` | Send messages, read channels |
| `gmail` | `@anthropic/mcp-server-gmail` | Send/read emails, manage drafts |
| `calendar` | `@anthropic/mcp-server-calendar` | Create/read/update calendar events |

### Using Adapters Programmatically

Adapters are managed at the engine level. After engine startup, you can discover tools and call them:

```typescript
import { createEngine, MockProvider } from 'runcor';
import type { EngineConfig, AdapterConfig } from 'runcor';

const adapterConfig: AdapterConfig = {
  name: 'my-server',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@some/mcp-server'],
  timeoutMs: 10000,
};

const config: EngineConfig = {
  model: { providers: [{ provider: new MockProvider() }] },
  adapters: { adapters: [adapterConfig] },
};

const engine = await createEngine(config);

// Discover available tools across all adapters
const tools = engine.listTools();
console.log('Available tools:', tools.map((t) => t.qualifiedName));

// Call a tool on a specific adapter
const result = await engine.callTool('my-server', 'tool-name', { param: 'value' });
console.log('Tool result:', result);

// Get adapter status
const info = engine.getAdapterInfo('my-server');
console.log('Adapter state:', info?.state);

await engine.shutdown();
```

### Key Points

- Adapters connect on engine startup and disconnect on shutdown
- Tools are called via `engine.callTool(adapterName, toolName, args)` — not through `ctx`
- Use `engine.listTools()` to discover all available tools across adapters
- Presets simplify configuration for common integrations (Slack, Gmail, Calendar)
- Each adapter has circuit breaking, retry, and health check built in
- See `07-limitations.md` for known limitations (no adapter concurrency limits, no trace propagation)

---

## 8. Wait/Resume

Wait/resume enables human-in-the-loop workflows. A flow handler pauses execution by returning a `WaitSignal`, and an external system resumes it later with `engine.resume()`.

### API

```typescript
import { createWaitSignal, isWaitSignal } from 'runcor';

// In a flow handler — return this to pause
return createWaitSignal({
  reason: 'Waiting for human approval',
  data: { draft: 'Some draft content' },
});

// The handler is called again when resumed
// ctx.resumeData contains what was passed to engine.resume()
```

### How It Works

1. Flow handler returns a `WaitSignal` → execution transitions to `waiting` state
2. External system calls `engine.resume(executionId, resumeData)` → execution transitions back to `running`
3. The same flow handler is called again, this time with `ctx.resumeData` populated
4. Handler checks `ctx.resumeData` to distinguish initial run from resume

### Example

```typescript
import { createEngine, MockProvider, createWaitSignal } from 'runcor';
import type { FlowHandler, EngineConfig } from 'runcor';

interface ApprovalInput {
  content: string;
}

interface ApprovalResume {
  approved: boolean;
  reviewer: string;
}

const approval: FlowHandler = async (ctx) => {
  if (!ctx.resumeData) {
    // First invocation — generate draft and wait for approval
    const input = ctx.input as ApprovalInput;

    const response = await ctx.model.complete({
      prompt: `Polish this: ${input.content}`,
    });

    return createWaitSignal({
      reason: 'Waiting for human approval of polished content',
      data: { draft: response.text },
    });
  }

  // Resumed — process the approval decision
  const resume = ctx.resumeData as ApprovalResume;

  if (resume.approved) {
    return { status: 'published', reviewer: resume.reviewer };
  }

  return { status: 'rejected', reviewer: resume.reviewer };
};

const config: EngineConfig = {
  model: { providers: [{ provider: new MockProvider() }] },
};

const engine = await createEngine(config);
engine.register('approval', approval);

// Step 1: Trigger — execution will pause at the WaitSignal
const execution = await engine.trigger('approval', {
  idempotencyKey: crypto.randomUUID(),
  input: { content: 'Draft blog post about AI' },
});

console.log('State:', execution.state); // 'waiting'

// Step 2: Resume — simulate human approval
const resumed = await engine.resume(execution.executionId, {
  approved: true,
  reviewer: 'alice',
});

console.log('State:', resumed.state); // 'complete'
console.log('Result:', resumed.result);

await engine.shutdown();
```

### Key Points

- `createWaitSignal()` is the only way to pause an execution — it returns a branded sentinel
- The flow handler is called **twice**: once for the initial run, once after resume
- Use `ctx.resumeData` to distinguish: `undefined` = first run, populated = resumed
- Wait timeouts can be configured per-flow (`waitTimeout` in `FlowConfig`) or per-trigger (`waitTimeout` in `TriggerOptions`)
- If a wait times out, the execution transitions to `failed` with a timeout error
- `engine.resume(executionId)` can be called without data if no resume payload is needed

---

## 9. Agent Execution Pattern

> Use when: The workflow requires multi-step reasoning, tool calling, or autonomous iteration.

### Overview

`createAgentHandler(config)` creates a standard `FlowHandler` that runs an autonomous agent loop. The agent makes model calls, receives tool call requests, executes tools via adapters, feeds results back to the model, and repeats until the model provides a final answer or a stop condition is hit.

### API

```typescript
import { createAgentHandler } from 'runcor';
import type { AgentConfig, AgentResult } from 'runcor';

const agent = createAgentHandler({
  systemPrompt: 'You are a research assistant.',
  maxIterations: 10,          // Max tool-calling rounds (default: 25)
  iterationBudget: 0.10,      // Max cost per single iteration
  timeoutMs: 120000,          // Agent-level timeout
  outputSchema: { ... },      // Optional: JSON Schema for structured final answer
  maxHistoryMessages: 50,     // Truncate conversation to last N messages
  model: 'claude-sonnet-4-20250514',  // Override model for this agent
});

// Register as a normal flow
engine.register('my-agent', agent, {
  description: 'Research assistant agent',
  timeout: 180000,
});
```

### Agent Result

When an agent flow completes, the execution result is an `AgentResult`:

```typescript
interface AgentResult {
  answer: unknown;               // The model's final text or parsed JSON response
  stopReason: StopReason;        // 'completed' | 'max_iterations' | 'budget_exhausted' | 'timeout' | 'context_overflow'
  iterations: AgentIteration[];  // Record of each loop iteration
  totalCost: number;
  totalTokens: { input: number; output: number };
  conversationLength: number;
}
```

### Tool Discovery

Agents automatically discover tools from connected MCP adapters. No explicit tool registration needed — if adapters are configured in `runcor.yaml`, the agent sees all their tools.

```typescript
// Inside the agent loop, the model sees tools like:
// gmail.send_email, slack.post_message, calendar.create_event
// The agent calls them via ctx.tools.callTool('gmail.send_email', { to: '...', subject: '...' })
```

### Key Points

- The agent loop runs inside a standard execution — retries, timeouts, cost tracking, and policy all apply
- `stopReason` tells you why the agent stopped: `completed` means it gave a final answer
- `maxIterations` is a safety limit — most agents complete in 3-5 iterations
- `iterationBudget` caps cost per single model call, not total agent cost
- Use `outputSchema` to enforce structured JSON output from the agent's final answer
- Agent telemetry produces `agent.iteration` spans per loop round

---

## 10. Structured Output

> Use when: You need validated JSON responses from the model, not free-form text.

### API

```typescript
const response = await ctx.model.complete({
  prompt: 'Extract the key entities from this text.',
  responseFormat: {
    type: 'json_schema',
    jsonSchema: {
      name: 'entities',
      schema: {
        type: 'object',
        properties: {
          people: { type: 'array', items: { type: 'string' } },
          places: { type: 'array', items: { type: 'string' } },
        },
        required: ['people', 'places'],
      },
    },
  },
});

// response.parsed contains the validated object
const entities = response.parsed as { people: string[]; places: string[] };
```

### Key Points

- Pass `responseFormat` with a JSON Schema to `ctx.model.complete()`
- The response is validated against the schema; if invalid, the engine retries automatically
- `response.parsed` contains the validated JSON object
- `response.text` still contains the raw text response
- Works with all providers (native structured output where supported, prompt-based fallback otherwise)
- Emits `model:validation_retry` event when retrying

---

## 11. Scheduled Flows

> Use when: Flows need to run automatically on a recurring schedule (daily reports, hourly checks, etc.).

### API

```typescript
// Register a flow with a cron schedule
engine.register('daily-summary', handler, {
  schedule: '0 8 * * *',           // Cron expression: 8:00 AM daily
  timezone: 'America/New_York',    // IANA timezone
});
```

### Configuration in runcor.yaml

```yaml
scheduler:
  defaultTimezone: America/New_York

  flows:
    daily-summary:
      cron: "0 8 * * *"
      timezone: America/New_York
    hourly-check:
      cron: "0 * * * *"
```

### Key Points

- Uses standard cron expressions with IANA timezone support
- Overlap prevention: if the previous execution is still running, the scheduled trigger is skipped
- Each trigger gets a unique idempotency key: `scheduled-{flowName}-{timestamp}`
- Events: `scheduler:trigger`, `scheduler:skip`, `scheduler:registered`, `scheduler:removed`
- The engine must stay running for scheduled flows (don't call `shutdown()`)
- Remove a schedule by unregistering the flow: `engine.unregister('daily-summary')`

---

## 12. Discernment (Portfolio Analysis)

> Use when: Operators want the engine to analyze its own workload and recommend what to keep, optimize, merge, or retire.

### Overview

Discernment reads signals from all subsystems — cost, quality, policy, execution patterns, adapters, agents, scheduling, memory — and produces recommendations about whether what's running is worth running.

### API

```typescript
// Declare business objectives
engine.addObjective({ name: 'retention', description: 'Reduce customer churn' });

// Tag flows to objectives at registration
engine.register('churn-alert', handler, { objective: 'retention' });

// Run a discernment cycle
const report = await engine.runDiscernmentCycle();
console.log('Signals:', report.signals.length);
console.log('Recommendations:', report.recommendations.length);

// Query recommendations
const recs = engine.getRecommendations({ status: 'pending' });
for (const rec of recs) {
  console.log(`${rec.action} ${rec.target}: ${rec.explanation}`);
}

// Manage recommendation lifecycle
engine.acknowledgeRecommendation(recs[0].id);
engine.dismissRecommendation(recs[1].id);
```

### Configuration in runcor.yaml

```yaml
discernment:
  enabled: true
  autonomy: recommend    # observe | recommend | advise | enforce
  schedule: daily
  provider: anthropic    # optional, uses default route if omitted

objectives:
  - name: operational-visibility
    description: "Leadership has daily visibility into business metrics"
  - name: customer-retention
    description: "Reduce support ticket volume through proactive outreach"
```

### Autonomy Levels

- **observe**: Collect profiles and signals only, no recommendations
- **recommend**: Produce recommendations, surface via events and API, take no action (default)
- **advise**: Same as recommend but operator must acknowledge before next cycle
- **enforce**: Recommendations auto-execute after grace period (requires explicit opt-in per flow)

### Key Points

- Discernment runs on a cycle (daily by default, manually via `runDiscernmentCycle()`)
- 9 built-in heuristic checks: idle flows, disproportionate cost, quality decline, untagged flows, agent hard stops, etc.
- Custom heuristics: `engine.addHeuristic({ name: 'my-check', check: (profiles) => signals })`
- Model analysis sends the system profile to an LLM for strategic recommendations
- Events: `discernment:signal`, `discernment:recommendation`, `discernment:cycle`

---

## 13. HTTP Server & Dashboard

> Use when: You need remote access to the engine via REST API or a built-in monitoring dashboard.

### API

```typescript
import { createEngine, createServer } from 'runcor';

const engine = await createEngine();
const server = createServer(engine, { port: 3000 });
await server.start();
// Dashboard available at http://localhost:3000/v1/dashboard
```

### Key Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/health` | Engine status, uptime, capabilities |
| GET | `/v1/dashboard` | Built-in monitoring dashboard |
| GET | `/v1/flows` | List registered flows |
| POST | `/v1/flows/:name/trigger` | Trigger a flow |
| GET | `/v1/executions` | List executions (filterable) |
| GET | `/v1/executions/:id` | Get single execution |
| GET | `/v1/executions/:id/detail` | Execution + cost + eval data |
| GET | `/v1/events` | SSE event stream |
| GET | `/v1/providers` | Provider health states |
| GET | `/v1/cost/summary` | Cost breakdown by flow/user/provider |
| GET | `/v1/discernment` | Objectives, reports, recommendations |
| GET | `/v1/adapters` | Adapter connection status |

### Dashboard

The built-in dashboard at `/v1/dashboard` provides:
- Real-time execution feed via SSE
- Execution detail overlay (state timeline, cost, eval scores)
- Real adapter connection status
- Provider health panel
- Cost summary with breakdowns
- Discernment panel (objectives, recommendations)
- Graceful degradation for disabled subsystems

## See Also

- `01-contract.md` — Which subsystems are tool responsibilities vs engine responsibilities
- `02-scaffolding.md` — Decision tree for choosing which subsystems to opt into
- `03-config-reference.md` — YAML configuration for each subsystem
- `04-api-reference.md` — Type signatures for all subsystem interfaces
- `06-lifecycle.md` — How subsystem interactions map to execution states
- `09-example-advanced.md` — Working example using memory, cost, telemetry, and evaluation together
