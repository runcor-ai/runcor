# Example: Simple Echo Tool

> **Purpose**: A complete, minimal tool that demonstrates the Runcor scaffolding pattern.
> **When to use**: As a reference when building a basic single-flow tool.

## The Complete Tool

Save as `echo-tool.ts` and run with `npx tsx echo-tool.ts`:

```typescript
import { createEngine, MockProvider } from 'runcor';
import type { FlowHandler, EngineConfig } from 'runcor';

// Define input/output types
interface EchoInput {
  text: string;
}

interface EchoOutput {
  original: string;
  transformed: string;
}

// Flow handler — the business logic
const echo: FlowHandler = async (ctx): Promise<EchoOutput> => {
  const input = ctx.input as EchoInput;

  // Use the model to transform the text
  const response = await ctx.model.complete({
    prompt: `Rephrase the following text in a more formal tone: "${input.text}"`,
  });

  return {
    original: input.text,
    transformed: response.text,
  };
};

// Engine configuration with MockProvider (no API keys needed)
const config: EngineConfig = {
  model: {
    providers: [{ provider: new MockProvider() }],
  },
};

// Initialize, register, trigger, shutdown
const engine = await createEngine(config);

engine.register('echo', echo);

const execution = await engine.trigger('echo', {
  idempotencyKey: crypto.randomUUID(),
  input: { text: 'hey whats up' },
});

console.log('State:', execution.state);
console.log('Result:', JSON.stringify(execution.result, null, 2));

await engine.shutdown();
```

## What This Demonstrates

| Pattern | Line | Description |
|---------|------|-------------|
| Typed input/output | `EchoInput`, `EchoOutput` | Explicit types, no `any` |
| Model call | `ctx.model.complete()` | Provider-agnostic model interaction |
| Engine init | `createEngine(config)` | Programmatic config with MockProvider |
| Flow registration | `engine.register('echo', echo)` | Register handler by name |
| Trigger | `engine.trigger('echo', {...})` | Execute with idempotency key and input |
| Shutdown | `engine.shutdown()` | Clean resource cleanup |

## Switching to a Real Provider

Replace the config with a `runcor.yaml`:

```yaml
providers:
  - type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
```

Then change the engine creation:

```typescript
const engine = await createEngine();  // Loads runcor.yaml
```

Remove the `MockProvider` import and the inline `config` object.

## See Also

- `02-scaffolding.md` — The scaffolding patterns this example demonstrates
- `03-config-reference.md` — Config reference for switching to `runcor.yaml`
- `04-api-reference.md` — All imports and type signatures used in this example
- `09-example-advanced.md` — A more complex example using multiple subsystems
