# Scaffolding Guide

> **Purpose**: Step-by-step instructions for Claude to generate a complete, working workflow or agent from a plain-English description.
> **When to use**: When a developer asks "build me a workflow that does X", "create an agent that does Y", or any request to create something that runs on runcor.

## What to Generate

When a developer describes what they want, generate exactly:

1. **One TypeScript file** (e.g., `my-workflow.ts`) — the workflow or agent
2. **One `runcor.yaml` file** — engine configuration
3. **Console output** — what was generated, how to run it, what env vars are needed

## Step-by-Step Process

### Step 1: Understand the Request

Parse the developer's description to identify:

- **Core action**: What does the workflow do? (e.g., "summarize URLs", "research a topic", "process support tickets")
- **Input/output**: What goes in, what comes out?
- **Flow type**: Simple prompt flow or autonomous agent? (see decision below)
- **Subsystems needed**: Use the decision tree below

### Step 2: Choose Flow Type

**Agent flow** (use `createAgentHandler`) when:
- The task requires multiple steps or tool calls
- The task involves reasoning, research, or iterative work
- The description says "agent", "assistant", "autonomous", "research", "investigate"
- The task needs to call external tools (adapters) dynamically

**Prompt flow** (use a regular `FlowHandler`) when:
- The task is a single model call (summarize, translate, classify, extract)
- Input → model → output with no iteration
- No tool calling needed

### Step 3: Choose Subsystems

Based on the developer's description, opt into engine subsystems:

| If the description mentions... | Add this subsystem |
|-------------------------------|-------------------|
| "remember", "history", "context", "past" | Memory (`ctx.memory`) |
| "budget", "cost", "limit", "spend" | Cost tracking (`ctx.cost`) |
| "log", "trace", "monitor", "debug" | Telemetry (`ctx.telemetry`) |
| "approve", "wait", "human", "review" | Wait/resume (`createWaitSignal`) |
| "Slack", "Gmail", "calendar", "external tool" | Adapters (in `runcor.yaml` connections) |
| "schedule", "daily", "every hour", "cron" | Scheduler (in `FlowConfig.schedule`) |
| "structured", "JSON", "schema", "typed output" | Structured output (`responseFormat`) |
| "agent", "autonomous", "research", "multi-step" | Agent handler (`createAgentHandler`) |
| None of the above | Just `ctx.model.complete()` — keep it simple |

### Step 4: Generate the Tool File

Choose the appropriate template:

#### Template A: Simple Prompt Flow

```typescript
import { createEngine, MockProvider } from 'runcor';
import type { FlowHandler, EngineConfig } from 'runcor';

// Define input/output types
interface SummaryInput {
  text: string;
}

// Flow handler — single model call
const summarize: FlowHandler = async (ctx) => {
  const input = ctx.input as SummaryInput;

  const response = await ctx.model.complete({
    prompt: `Summarize the following text in 2-3 sentences:\n\n${input.text}`,
  });

  return { summary: response.text };
};

// Create engine and run
const engine = await createEngine({
  model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
});

engine.register('summarize', summarize);

const execution = await engine.trigger('summarize', {
  idempotencyKey: crypto.randomUUID(),
  input: { text: 'Your text here...' },
});

console.log('Execution:', execution.id, execution.state);

// Wait for completion (async execution)
engine.on('execution:complete', (e) => {
  if (e.executionId === execution.id) {
    console.log('Result:', e.result);
    engine.shutdown();
  }
});
```

#### Template B: Autonomous Agent

```typescript
import { createEngine, createAgentHandler, MockProvider } from 'runcor';
import type { AgentConfig, EngineConfig } from 'runcor';

// Agent configuration
const agentConfig: AgentConfig = {
  systemPrompt: `You are a research assistant. When given a topic,
investigate it thoroughly by searching available tools and synthesizing findings.
Return a structured summary with key points and sources.`,
  maxIterations: 10,        // Stop after 10 tool-calling rounds
  timeoutMs: 120000,        // 2 minute timeout
  // outputSchema: { ... },  // Optional: enforce JSON output shape
};

// Create the agent handler (returns a standard FlowHandler)
const researchAgent = createAgentHandler(agentConfig);

// Create engine
const engine = await createEngine({
  model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
  cost: {},  // Track agent cost across iterations
});

// Register the agent as a flow
engine.register('research', researchAgent, {
  description: 'Research assistant that investigates topics',
  timeout: 180000,  // 3 min execution timeout
});

// Trigger
const execution = await engine.trigger('research', {
  idempotencyKey: crypto.randomUUID(),
  input: { topic: 'What are the latest advances in battery technology?' },
});

engine.on('execution:complete', (e) => {
  if (e.executionId === execution.id) {
    console.log('Agent result:', e.result);
    // e.result is AgentResult: { answer, stopReason, iterations, totalCost, totalTokens }
    engine.shutdown();
  }
});
```

#### Template C: Structured Output (JSON Schema)

```typescript
import { createEngine, MockProvider } from 'runcor';
import type { FlowHandler } from 'runcor';

interface ExtractedData {
  name: string;
  email: string;
  company: string;
}

const extract: FlowHandler = async (ctx) => {
  const input = ctx.input as { text: string };

  const response = await ctx.model.complete({
    prompt: `Extract contact information from this text:\n\n${input.text}`,
    responseFormat: {
      type: 'json_schema',
      jsonSchema: {
        name: 'contact_info',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            email: { type: 'string' },
            company: { type: 'string' },
          },
          required: ['name', 'email', 'company'],
        },
      },
    },
  });

  // response.parsed contains the validated JSON object
  return response.parsed as ExtractedData;
};
```

#### Template D: Scheduled Flow

```typescript
import { createEngine, MockProvider } from 'runcor';
import type { FlowHandler } from 'runcor';

const dailyReport: FlowHandler = async (ctx) => {
  const response = await ctx.model.complete({
    prompt: 'Generate today\'s operational summary.',
  });
  return { report: response.text, generatedAt: new Date().toISOString() };
};

const engine = await createEngine({
  model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
});

// Register with a cron schedule — runs daily at 8am EST
engine.register('daily-report', dailyReport, {
  schedule: '0 8 * * *',
  timezone: 'America/New_York',
  description: 'Daily operational report',
});

// Engine keeps running — scheduler triggers the flow automatically
console.log('Scheduler active. Daily report runs at 8:00 AM EST.');
// Don't call shutdown() — engine stays alive for scheduled triggers
```

#### Template E: Agent with External Tools (Adapters)

```typescript
import { createEngine, createAgentHandler } from 'runcor';
import type { AgentConfig } from 'runcor';

const agent = createAgentHandler({
  systemPrompt: `You are a work assistant with access to email and calendar tools.
Help the user manage their schedule and communications.`,
  maxIterations: 15,
});

// Load config from runcor.yaml (which defines provider + connections)
const engine = await createEngine();

engine.register('work-assistant', agent, {
  description: 'Work assistant with Gmail and Calendar access',
});
```

With `runcor.yaml`:

```yaml
providers:
  - type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}

connections:
  - name: gmail
    preset: gmail
    url: ${GMAIL_MCP_URL}
  - name: calendar
    preset: calendar
    url: ${CALENDAR_MCP_URL}
```

The agent automatically discovers tools from connected adapters via `ctx.tools.listTools()` and calls them during its loop.

#### Template F: Flow with Wait/Resume (Human-in-the-Loop)

```typescript
import { createEngine, createWaitSignal, MockProvider } from 'runcor';
import type { FlowHandler } from 'runcor';

const reviewFlow: FlowHandler = async (ctx) => {
  if (!ctx.resumeData) {
    // First run — generate a draft, then pause for review
    const draft = await ctx.model.complete({
      prompt: `Draft a customer response for: ${JSON.stringify(ctx.input)}`,
    });

    return createWaitSignal({
      reason: 'Waiting for manager approval',
      waitData: { draft: draft.text },
    });
  }

  // Resumed — manager approved or rejected
  const decision = ctx.resumeData as { approved: boolean; feedback?: string };
  if (decision.approved) {
    return { status: 'sent', draft: (ctx.resumeData as any).draft };
  }
  return { status: 'rejected', feedback: decision.feedback };
};

const engine = await createEngine({
  model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
});

engine.register('customer-response', reviewFlow);

// Trigger
const exec = await engine.trigger('customer-response', {
  idempotencyKey: crypto.randomUUID(),
  input: { ticket: 'Customer wants a refund for order #1234' },
});

// Later, resume with approval:
// await engine.resume(exec.id, { approved: true });
```

#### Template G: Flow with Memory

```typescript
import { createEngine, MockProvider } from 'runcor';
import type { FlowHandler } from 'runcor';

const chatFlow: FlowHandler = async (ctx) => {
  const input = ctx.input as { message: string; userId: string };

  // Load conversation history from user memory
  const history = await ctx.memory.user.get<string[]>('history') ?? [];

  const response = await ctx.model.complete({
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      ...history.map((h, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: h,
      })),
      { role: 'user' as const, content: input.message },
    ],
  });

  // Save updated history
  history.push(input.message, response.text);
  await ctx.memory.user.set('history', history.slice(-20)); // Keep last 20 messages

  return { reply: response.text };
};
```

### Step 5: Generate runcor.yaml

Generate a config file based on the workflow's needs:

**Minimal** (development/testing — skip this file and use inline config):

```yaml
providers:
  - type: mock
```

**With a real provider**:

```yaml
providers:
  - type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
```

**With adapters (for agents that use tools)**:

```yaml
providers:
  - type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}

connections:
  - name: slack
    preset: slack
    url: ${SLACK_MCP_URL}
```

**With cost budgets**:

```yaml
providers:
  - type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}

costs:
  budgets:
    perRequest:
      limit: 0.50
    global:
      limit: 5.00
      window:
        type: daily
```

**With scheduling**:

```yaml
providers:
  - type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}

scheduler:
  defaultTimezone: America/New_York
```

**Full-featured (agent with tools, cost tracking, scheduling)**:

```yaml
providers:
  - type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    priority: 1
  - type: openai
    apiKey: ${OPENAI_API_KEY}
    priority: 2

routing:
  strategy: priority
  maxFallbackAttempts: 2

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
      limit: 1.00
    perUser:
      limit: 10.00
      window:
        type: daily

scheduler:
  defaultTimezone: America/New_York
```

### Step 6: Switch to YAML-Based Config

When generating `runcor.yaml`, change engine creation to load config automatically:

```typescript
// Instead of inline config:
// const engine = await createEngine(config);

// Use YAML-based config:
const engine = await createEngine();  // Loads runcor.yaml automatically
```

### Step 7: Tell the Developer

After generating files, output:

```
Generated:
  - my-workflow.ts  — your workflow (run with: npx tsx my-workflow.ts)
  - runcor.yaml     — engine configuration

Environment variables needed:
  - ANTHROPIC_API_KEY  — your Anthropic API key

To run:
  npx tsx my-workflow.ts
```

## Agent Configuration Reference

When generating agents with `createAgentHandler`, these are the available options:

```typescript
interface AgentConfig {
  systemPrompt: string;          // Required: agent's system instructions
  tools?: string[];              // Restrict which adapter tools the agent can use
  maxIterations?: number;        // Max tool-calling rounds (default: 25)
  iterationBudget?: number;      // Max cost per iteration
  timeoutMs?: number;            // Agent timeout in ms
  outputSchema?: Record<string, unknown>;  // JSON Schema for structured output
  maxHistoryMessages?: number;   // Truncate conversation history
}
```

Agent result shape:

```typescript
interface AgentResult {
  answer: unknown;               // The agent's final response
  stopReason: StopReason;        // Why the agent stopped
  iterations: AgentIteration[];  // Record of each loop iteration
  totalCost: number;             // Cumulative cost across all iterations
  totalTokens: { input: number; output: number };
  conversationLength: number;    // Total messages in conversation
}

type StopReason = 'completed' | 'max_iterations' | 'budget_exhausted' | 'timeout' | 'context_overflow';
```

## Important Rules

1. **Always import from `'runcor'`** — never use relative paths
2. **Always use `ctx.model.complete()`** — never call a provider directly
3. **Always include `idempotencyKey`** in trigger options — use `crypto.randomUUID()`
4. **Always call `engine.shutdown()`** for one-shot scripts — ensures clean cleanup (skip for scheduled flows)
5. **Use `MockProvider` for examples** — works without API keys
6. **Use explicit types** — no `any`, TypeScript strict mode
7. **Choose agent vs prompt flow correctly** — agents for multi-step reasoning, prompt flows for single model calls
8. **Execution is async** — `trigger()` returns immediately with the execution, listen to `execution:complete` for results
9. **Agents discover tools automatically** — when adapters are configured, agents see all adapter tools via `ctx.tools`
10. **Structured output uses `responseFormat`** — pass a JSON Schema to get validated, parsed JSON responses

## See Also

- `01-contract.md` — Responsibility boundary: what goes in the workflow vs the engine
- `03-config-reference.md` — Full `runcor.yaml` reference for config generation
- `04-api-reference.md` — All exports and correct import statements
- `05-subsystems.md` — Per-subsystem usage guides for opt-in features
- `07-limitations.md` — What to avoid when generating code
- `08-example-simple.md` — A working reference workflow
- `09-example-advanced.md` — Advanced workflow with multiple subsystems
