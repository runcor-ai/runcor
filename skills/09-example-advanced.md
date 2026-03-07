# Example: Advanced Research Assistant Tool

> **Purpose**: A complete multi-subsystem tool demonstrating memory, cost tracking, telemetry, and evaluation.
> **When to use**: As a reference when building a tool that integrates multiple engine subsystems.

## The Complete Tool

Save as `research-assistant.ts` and run with `npx tsx research-assistant.ts`:

```typescript
import {
  createEngine,
  MockProvider,
  createLengthEvaluator,
} from 'runcor';
import type {
  FlowHandler,
  EngineConfig,
  Evaluator,
} from 'runcor';

// ── Types ──

interface ResearchInput {
  query: string;
  userId: string;
}

interface ResearchOutput {
  answer: string;
  previousQueries: string[];
  cost: number;
  requestCount: number;
}

// ── Flow Handler ──

const research: FlowHandler = async (ctx): Promise<ResearchOutput> => {
  const input = ctx.input as ResearchInput;

  // Telemetry: tag the span with the query
  ctx.telemetry.setAttribute('research.query', input.query);

  // Memory: load past queries for this user
  const previousQueries = await ctx.memory.user.get<string[]>('queries') ?? [];

  // Telemetry: wrap the model call in a custom span
  const answer = await ctx.telemetry.startSpan('generate-answer', async (span) => {
    span.addEvent('prompt-composed', { queryCount: previousQueries.length });

    // Build context-aware prompt
    const contextNote = previousQueries.length > 0
      ? `The user has previously asked: ${previousQueries.join(', ')}. `
      : '';

    const response = await ctx.model.complete({
      prompt: `You are a research assistant. ${contextNote}Provide thorough answers.\n\n${input.query}`,
      maxTokens: 500,
    });

    span.addEvent('response-received', {
      tokens: response.usage.completionTokens,
    });

    return response.text;
  });

  // Memory: save this query to the user's history
  previousQueries.push(input.query);
  await ctx.memory.user.set('queries', previousQueries);

  // Telemetry: record final metrics
  ctx.telemetry.addEvent('research-complete', {
    historyLength: previousQueries.length,
    cost: ctx.cost.executionTotal,
  });

  return {
    answer,
    previousQueries,
    cost: ctx.cost.executionTotal,
    requestCount: ctx.cost.requestCount,
  };
};

// ── Evaluators ──

const lengthEval: Evaluator = createLengthEvaluator({
  name: 'response-length',
  minLength: 20,
  maxLength: 2000,
});

const depthEval: Evaluator = {
  name: 'research-depth',
  priority: 100,
  evaluate: (context) => {
    const output = context.output as ResearchOutput;
    const wordCount = output.answer.split(/\s+/).length;
    const score = Math.min(wordCount / 100, 1.0);
    return {
      scores: { depth: score },
      labels: score >= 0.7 ? ['thorough'] : ['brief'],
    };
  },
};

// ── Engine Setup ──

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
      perUser: { limit: 5.00, window: { type: 'daily' } },
    },
  },
  telemetry: {
    serviceName: 'research-assistant',
  },
  evaluation: {
    evaluators: [lengthEval, depthEval],
    autoFlagScoreThreshold: 0.4,
  },
};

const engine = await createEngine(config);
engine.register('research', research);

// Listen for evaluation results
engine.on('eval:complete', (event) => {
  console.log(`Evaluation: score=${event.overallScore.toFixed(2)}, confidence=${event.confidence}`);
});

engine.on('eval:flagged', (event) => {
  console.log(`Flagged for review: ${event.reason}`);
});

// ── Run ──

// First query
const exec1 = await engine.trigger('research', {
  idempotencyKey: crypto.randomUUID(),
  input: { query: 'What is quantum computing?', userId: 'researcher-1' },
  userId: 'researcher-1',
});

const result1 = exec1.result as ResearchOutput;
console.log('Answer:', result1.answer);
console.log('Cost:', result1.cost);
console.log('History:', result1.previousQueries);

// Second query — same user, memory carries over
const exec2 = await engine.trigger('research', {
  idempotencyKey: crypto.randomUUID(),
  input: { query: 'How do qubits work?', userId: 'researcher-1' },
  userId: 'researcher-1',
});

const result2 = exec2.result as ResearchOutput;
console.log('\nAnswer:', result2.answer);
console.log('Cost:', result2.cost);
console.log('History:', result2.previousQueries);

await engine.shutdown();
```

## What This Demonstrates

| Subsystem | Usage | Lines |
|-----------|-------|-------|
| **Memory** | `ctx.memory.user.get()`/`set()` for cross-query history | Load + save user query history |
| **Cost Tracking** | `ctx.cost.executionTotal`, `costPerToken` config, `perRequest` + `perUser` budgets | Cost reported per query |
| **Telemetry** | `ctx.telemetry.setAttribute()`, `addEvent()`, `startSpan()` | Query tagging, model call span, completion event |
| **Evaluation** | `createLengthEvaluator()` + custom `research-depth` evaluator | Auto-scoring, auto-flagging |
| **Model Calls** | `ctx.model.complete()` with prompt string | Context-aware prompt |

## Running with Real Providers

Replace the config section:

```yaml
# runcor.yaml
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
    perUser:
      limit: 5.00
      window:
        type: daily

telemetry:
  serviceName: research-assistant

evaluation:
  autoFlagScoreThreshold: 0.4
  evaluators:
    - type: length
      config:
        minLength: 20
        maxLength: 2000
```

Then change engine creation to:

```typescript
const engine = await createEngine();  // Loads runcor.yaml
```

Remove `MockProvider` import and inline config.

## See Also

- `02-scaffolding.md` — Tool scaffolding patterns (this example follows them)
- `03-config-reference.md` — YAML config for the real-provider version
- `05-subsystems.md` — Individual subsystem guides for memory, cost, telemetry, evaluation
- `08-example-simple.md` — A simpler example to start with
