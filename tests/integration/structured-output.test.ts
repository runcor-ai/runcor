// Integration tests for Structured Output
// Tests schema validation, JSON mode, retries, cost tracking, and backward compatibility

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, Runcor } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import { ValidationError } from '../../src/errors.js';
import type { EngineConfig, ValidationRetryEvent, CostRequestEvent } from '../../src/types.js';
import type { ModelProvider, ModelRequest, ModelResponse } from '../../src/model/provider.js';

// ── Helpers ──

async function makeEngine(overrides: Partial<EngineConfig> = {}): Promise<Runcor> {
  return createEngine({
    model: {
      providers: [
        {
          provider: new MockProvider(),
          priority: 1,
          costPerToken: { input: 0.001, output: 0.002 },
        },
      ],
    },
    cost: {},
    ...overrides,
  });
}

/** Wait for an execution to reach a terminal state */
async function waitForCompletion(engine: Runcor, executionId: string, timeout = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for completion')), timeout);
    const check = async () => {
      const exec = await engine.getExecution(executionId);
      if (exec && (exec.state === 'complete' || exec.state === 'failed')) {
        clearTimeout(timer);
        resolve();
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });
}

/** Create a provider that returns specific responses in sequence */
function createSequenceProvider(name: string, responses: string[]): ModelProvider {
  let callIndex = 0;
  return {
    name,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const text = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      const promptLen = request.prompt?.length ?? request.messages?.map(m => m.content).join('').length ?? 0;
      return {
        text,
        model: `${name}-model`,
        provider: name,
        usage: { promptTokens: promptLen, completionTokens: text.length },
      };
    },
  };
}

// ── T020: Schema validation through engine ──

describe('US1: Schema Validation', () => {
  let engine: Runcor;

  afterEach(async () => {
    if (engine) await engine.shutdown();
  });

  it('should return parsed field for valid schema response', async () => {
    const provider = createSequenceProvider('test', ['{"name":"John","age":30}']);
    engine = await createEngine({
      model: { providers: [{ provider, priority: 1, costPerToken: { input: 0.001, output: 0.002 } }] },
      cost: {},
    });

    let result: unknown;
    engine.register('test', async (ctx) => {
      const response = await ctx.model.complete({
        prompt: 'Extract user info',
        responseFormat: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'number' } },
          required: ['name', 'age'],
        },
      });
      result = response.parsed;
      return response.parsed;
    });

    const exec = await engine.trigger('test', { idempotencyKey: 'k1', input: 'test' });
    await waitForCompletion(engine, exec.id);
    expect(result).toEqual({ name: 'John', age: 30 });
  });

  it('should retry on invalid response then succeed', async () => {
    // First response is invalid, second is valid
    const provider = createSequenceProvider('test', [
      '{"name":"John"}', // Missing required 'age'
      '{"name":"John","age":30}', // Valid
    ]);
    engine = await createEngine({
      model: { providers: [{ provider, priority: 1, costPerToken: { input: 0.001, output: 0.002 } }] },
      cost: {},
    });

    let result: unknown;
    engine.register('test', async (ctx) => {
      const response = await ctx.model.complete({
        prompt: 'Extract user info',
        responseFormat: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'number' } },
          required: ['name', 'age'],
        },
      });
      result = response.parsed;
      return response.parsed;
    });

    const exec = await engine.trigger('test', { idempotencyKey: 'k2', input: 'test' });
    await waitForCompletion(engine, exec.id);
    expect(result).toEqual({ name: 'John', age: 30 });
  });

  it('should throw ValidationError after all retries fail', async () => {
    // All 3 responses are invalid
    const provider = createSequenceProvider('test', [
      '{"name":"John"}', // Missing age
      '{"name":"Jane"}', // Missing age
      '{"name":"Bob"}',  // Missing age
    ]);
    engine = await createEngine({
      model: { providers: [{ provider, priority: 1, costPerToken: { input: 0.001, output: 0.002 } }] },
      cost: {},
    });

    let caughtError: unknown;
    engine.register('test', async (ctx) => {
      try {
        await ctx.model.complete({
          prompt: 'Extract user info',
          responseFormat: {
            type: 'object',
            properties: { name: { type: 'string' }, age: { type: 'number' } },
            required: ['name', 'age'],
          },
        });
      } catch (err) {
        caughtError = err;
        throw err;
      }
    });

    const exec = await engine.trigger('test', { idempotencyKey: 'k3', input: 'test' });
    await waitForCompletion(engine, exec.id);
    expect(caughtError).toBeInstanceOf(ValidationError);
    expect((caughtError as ValidationError).rawText).toBe('{"name":"Bob"}');
  });

  it('should fire cost:request events for each attempt including retries', async () => {
    const provider = createSequenceProvider('test', [
      'not json',           // Attempt 1: fails
      '{"wrong":"type"}',   // Attempt 2: fails schema
      '{"name":"John","age":30}', // Attempt 3: succeeds
    ]);
    engine = await createEngine({
      model: { providers: [{ provider, priority: 1, costPerToken: { input: 0.001, output: 0.002 } }] },
      cost: {},
    });

    const costEvents: CostRequestEvent[] = [];
    engine.on('cost:request', (event) => costEvents.push(event));

    engine.register('test', async (ctx) => {
      const response = await ctx.model.complete({
        prompt: 'Extract user info',
        responseFormat: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'number' } },
          required: ['name', 'age'],
        },
      });
      return response.parsed;
    });

    const exec = await engine.trigger('test', { idempotencyKey: 'k4', input: 'test' });
    await waitForCompletion(engine, exec.id);
    // 3 model calls = 3 cost:request events
    expect(costEvents.length).toBe(3);
  });

  it('should fire model:validation_retry event per retry with correct payload', async () => {
    const provider = createSequenceProvider('test', [
      'not json',
      '{"name":"John","age":30}',
    ]);
    engine = await createEngine({
      model: { providers: [{ provider, priority: 1, costPerToken: { input: 0.001, output: 0.002 } }] },
      cost: {},
    });

    const retryEvents: ValidationRetryEvent[] = [];
    engine.on('model:validation_retry', (event) => retryEvents.push(event));

    engine.register('test', async (ctx) => {
      const response = await ctx.model.complete({
        prompt: 'Extract user info',
        responseFormat: { type: 'object', properties: { name: { type: 'string' }, age: { type: 'number' } }, required: ['name', 'age'] },
      });
      return response.parsed;
    });

    const exec = await engine.trigger('test', { idempotencyKey: 'k5', input: 'test' });
    await waitForCompletion(engine, exec.id);
    expect(retryEvents.length).toBe(1);
    expect(retryEvents[0].attempt).toBe(1);
    expect(retryEvents[0].rawText).toBe('not json');
    expect(retryEvents[0].errors.length).toBeGreaterThan(0);
  });

  it('should skip validation when response contains toolCalls (FR-022)', async () => {
    // Provider returns toolCalls + non-JSON text
    const provider: ModelProvider = {
      name: 'tool-provider',
      async complete(request: ModelRequest): Promise<ModelResponse> {
        return {
          text: 'I will use a tool to help',
          model: 'test-model',
          provider: 'tool-provider',
          usage: { promptTokens: 10, completionTokens: 10 },
          toolCalls: [{
            id: 'tc-1',
            name: 'some.tool',
            arguments: { query: 'test' },
          }],
        };
      },
    };
    engine = await createEngine({
      model: { providers: [{ provider, priority: 1 }] },
    });

    let response: ModelResponse | undefined;
    engine.register('test', async (ctx) => {
      response = await ctx.model.complete({
        prompt: 'Do something',
        responseFormat: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
      });
      return response;
    });

    const exec = await engine.trigger('test', { idempotencyKey: 'k6', input: 'test' });
    await waitForCompletion(engine, exec.id);
    // Should NOT throw ValidationError — toolCalls present, validation skipped
    expect(response?.toolCalls).toBeDefined();
    expect(response?.toolCalls?.length).toBe(1);
  });
});

// ── T021: JSON mode through engine ──

describe('US2: JSON Mode', () => {
  let engine: Runcor;

  afterEach(async () => {
    if (engine) await engine.shutdown();
  });

  it('should return parsed for valid JSON', async () => {
    const provider = createSequenceProvider('test', ['{"key":"value"}']);
    engine = await createEngine({
      model: { providers: [{ provider, priority: 1 }] },
    });

    let result: unknown;
    engine.register('test', async (ctx) => {
      const response = await ctx.model.complete({
        prompt: 'Generate JSON',
        responseFormat: 'json',
      });
      result = response.parsed;
      return response.parsed;
    });

    const exec = await engine.trigger('test', { idempotencyKey: 'j1', input: 'test' });
    await waitForCompletion(engine, exec.id);
    expect(result).toEqual({ key: 'value' });
  });

  it('should retry on invalid JSON', async () => {
    const provider = createSequenceProvider('test', [
      'not valid json',
      '{"valid":true}',
    ]);
    engine = await createEngine({
      model: { providers: [{ provider, priority: 1 }] },
    });

    let result: unknown;
    engine.register('test', async (ctx) => {
      const response = await ctx.model.complete({
        prompt: 'Generate JSON',
        responseFormat: 'json',
      });
      result = response.parsed;
      return response.parsed;
    });

    const exec = await engine.trigger('test', { idempotencyKey: 'j2', input: 'test' });
    await waitForCompletion(engine, exec.id);
    expect(result).toEqual({ valid: true });
  });

  it('should accept JSON primitives (42, "hello", true, null)', async () => {
    const primitives = ['42', '"hello"', 'true', 'null'];
    const expected = [42, 'hello', true, null];

    for (let i = 0; i < primitives.length; i++) {
      const provider = createSequenceProvider('test', [primitives[i]]);
      engine = await createEngine({
        model: { providers: [{ provider, priority: 1 }] },
      });

      let result: unknown;
      engine.register('test', async (ctx) => {
        const response = await ctx.model.complete({
          prompt: 'Generate value',
          responseFormat: 'json',
        });
        result = response.parsed;
        return response.parsed;
      });

      const exec = await engine.trigger('test', { idempotencyKey: `j3-${i}`, input: 'test' });
      await waitForCompletion(engine, exec.id);
      expect(result).toEqual(expected[i]);
      await engine.shutdown();
    }
    // Prevent double-shutdown in afterEach
    engine = undefined as any;
  });

  it('should treat empty string as invalid JSON', async () => {
    const provider = createSequenceProvider('test', [
      '',
      '{"recovered":true}',
    ]);
    engine = await createEngine({
      model: { providers: [{ provider, priority: 1 }] },
    });

    let result: unknown;
    engine.register('test', async (ctx) => {
      const response = await ctx.model.complete({
        prompt: 'Generate JSON',
        responseFormat: 'json',
      });
      result = response.parsed;
      return response.parsed;
    });

    const exec = await engine.trigger('test', { idempotencyKey: 'j4', input: 'test' });
    await waitForCompletion(engine, exec.id);
    expect(result).toEqual({ recovered: true });
  });
});

// ── T022: Invalid schema at request time ──

describe('Invalid schema at request time', () => {
  let engine: Runcor;

  afterEach(async () => {
    if (engine) await engine.shutdown();
  });

  it('should throw ValidationError for invalid schema before model call', async () => {
    engine = await makeEngine();
    let caughtError: unknown;

    engine.register('test', async (ctx) => {
      try {
        await ctx.model.complete({
          prompt: 'test',
          responseFormat: { type: 'object', properties: { name: { type: 'not-a-type' } } },
        });
      } catch (err) {
        caughtError = err;
        throw err;
      }
    });

    const exec = await engine.trigger('test', { idempotencyKey: 'inv1', input: 'test' });
    await waitForCompletion(engine, exec.id);
    expect(caughtError).toBeInstanceOf(ValidationError);
  });

  it('should reject remote $ref', async () => {
    engine = await makeEngine();
    let caughtError: unknown;

    engine.register('test', async (ctx) => {
      try {
        await ctx.model.complete({
          prompt: 'test',
          responseFormat: { $ref: 'https://example.com/schema.json' },
        });
      } catch (err) {
        caughtError = err;
        throw err;
      }
    });

    const exec = await engine.trigger('test', { idempotencyKey: 'inv2', input: 'test' });
    await waitForCompletion(engine, exec.id);
    expect(caughtError).toBeInstanceOf(ValidationError);
    expect((caughtError as ValidationError).errors[0].keyword).toBe('$ref');
  });
});

// ── T023: Code fence stripping ──

describe('Code fence stripping', () => {
  let engine: Runcor;

  afterEach(async () => {
    if (engine) await engine.shutdown();
  });

  it('should strip ```json fences and validate successfully', async () => {
    const provider = createSequenceProvider('test', ['```json\n{"name":"John","age":30}\n```']);
    engine = await createEngine({
      model: { providers: [{ provider, priority: 1 }] },
    });

    let result: unknown;
    engine.register('test', async (ctx) => {
      const response = await ctx.model.complete({
        prompt: 'Extract user info',
        responseFormat: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'number' } },
          required: ['name', 'age'],
        },
      });
      result = response.parsed;
      return response.parsed;
    });

    const exec = await engine.trigger('test', { idempotencyKey: 'cf1', input: 'test' });
    await waitForCompletion(engine, exec.id);
    expect(result).toEqual({ name: 'John', age: 30 });
  });
});

// ── T024: Text mode backward compatibility ──

describe('US5: Text mode backward compatibility', () => {
  let engine: Runcor;

  afterEach(async () => {
    if (engine) await engine.shutdown();
  });

  it('should not have parsed key when responseFormat is omitted', async () => {
    engine = await makeEngine();
    let hasParsedKey: boolean | undefined;

    engine.register('test', async (ctx) => {
      const response = await ctx.model.complete({
        prompt: 'Hello world',
      });
      hasParsedKey = 'parsed' in response;
      return response.text;
    });

    const exec = await engine.trigger('test', { idempotencyKey: 'bc1', input: 'test' });
    await waitForCompletion(engine, exec.id);
    expect(hasParsedKey).toBe(false);
  });

  it('should not have parsed key when responseFormat is text', async () => {
    engine = await makeEngine();
    let hasParsedKey: boolean | undefined;

    engine.register('test', async (ctx) => {
      const response = await ctx.model.complete({
        prompt: 'Hello world',
        responseFormat: 'text',
      });
      hasParsedKey = 'parsed' in response;
      return response.text;
    });

    const exec = await engine.trigger('test', { idempotencyKey: 'bc2', input: 'test' });
    await waitForCompletion(engine, exec.id);
    expect(hasParsedKey).toBe(false);
  });
});
