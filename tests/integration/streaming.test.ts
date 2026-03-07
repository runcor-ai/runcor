// Integration tests for end-to-end streaming
// Feature 015, US3: Streaming Responses via Async Iterators

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, Runcor } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import type { ModelProvider, ModelRequest, ModelResponse, ModelStream, StreamEvent } from '../../src/model/provider.js';
import type { CostRequestEvent } from '../../src/types.js';

// ── Helpers ──

function createStreamingProvider(name: string): ModelProvider {
  return {
    name,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const promptLen = request.prompt?.length ?? 0;
      return {
        text: `Response from ${name}`,
        model: `${name}-model`,
        provider: name,
        usage: { promptTokens: promptLen, completionTokens: 20 },
      };
    },
    stream(request: ModelRequest): ModelStream {
      const text = `Streamed from ${name}`;
      const response: ModelResponse = {
        text,
        model: `${name}-model`,
        provider: name,
        usage: { promptTokens: request.prompt?.length ?? 10, completionTokens: text.length },
      };

      return {
        async *[Symbol.asyncIterator]() {
          const words = text.split(' ');
          for (const word of words) {
            yield { type: 'text_delta' as const, text: word + ' ' };
          }
        },
        response: Promise.resolve(response),
      };
    },
  };
}

function createNonStreamingProvider(name: string): ModelProvider {
  return {
    name,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      return {
        text: `Fallback from ${name}`,
        model: `${name}-model`,
        provider: name,
        usage: { promptTokens: request.prompt?.length ?? 10, completionTokens: 20 },
      };
    },
  };
}

describe('Streaming integration (US3)', () => {
  let engine: Runcor;

  afterEach(async () => {
    if (engine) await engine.shutdown();
  });

  it('should stream through full engine with native streaming provider', async () => {
    engine = await createEngine({
      model: {
        providers: [{
          provider: createStreamingProvider('streamer'),
          priority: 1,
          costPerToken: null,
        }],
      },
    });

    let streamEvents: StreamEvent[] = [];
    let streamResponse: ModelResponse | undefined;

    engine.register('stream-flow', async (ctx) => {
      const stream = ctx.model.stream({ prompt: 'test streaming' });
      for await (const event of stream) {
        streamEvents.push(event);
      }
      streamResponse = await stream.response;
      return streamResponse.text;
    });

    const exec = await engine.trigger('stream-flow', { idempotencyKey: 'stream-1' });
    await new Promise(r => setTimeout(r, 200));
    const result = await engine.getExecution(exec.id);

    expect(result!.state).toBe('complete');
    expect(streamEvents.length).toBeGreaterThan(0);
    expect(streamEvents.every(e => e.type === 'text_delta')).toBe(true);
    expect(streamResponse).toBeDefined();
    expect(streamResponse!.provider).toBe('streamer');
  });

  it('should stream using fallback when provider has no stream()', async () => {
    engine = await createEngine({
      model: {
        providers: [{
          provider: createNonStreamingProvider('no-stream'),
          priority: 1,
          costPerToken: null,
        }],
      },
    });

    let streamEvents: StreamEvent[] = [];
    let streamResponse: ModelResponse | undefined;

    engine.register('fallback-stream-flow', async (ctx) => {
      const stream = ctx.model.stream({ prompt: 'test fallback' });
      for await (const event of stream) {
        streamEvents.push(event);
      }
      streamResponse = await stream.response;
      return streamResponse.text;
    });

    const exec = await engine.trigger('fallback-stream-flow', { idempotencyKey: 'stream-2' });
    await new Promise(r => setTimeout(r, 200));
    const result = await engine.getExecution(exec.id);

    expect(result!.state).toBe('complete');
    expect(streamEvents).toHaveLength(1);
    expect(streamEvents[0].type).toBe('text_delta');
    expect(streamResponse!.text).toBe('Fallback from no-stream');
  });

  it('should track cost for streaming requests', async () => {
    const costEvents: CostRequestEvent[] = [];

    engine = await createEngine({
      model: {
        providers: [{
          provider: createStreamingProvider('cost-streamer'),
          priority: 1,
          costPerToken: { input: 0.01, output: 0.03 },
        }],
      },
      cost: {},
    });

    engine.on('cost:request', (event: CostRequestEvent) => {
      costEvents.push(event);
    });

    engine.register('cost-stream-flow', async (ctx) => {
      const stream = ctx.model.stream({ prompt: 'test cost' });
      for await (const event of stream) { /* consume */ }
      const resp = await stream.response;
      return resp.text;
    });

    const exec = await engine.trigger('cost-stream-flow', { idempotencyKey: 'stream-3' });
    await new Promise(r => setTimeout(r, 300));
    const result = await engine.getExecution(exec.id);

    expect(result!.state).toBe('complete');
    expect(costEvents).toHaveLength(1);
    expect(costEvents[0].provider).toBe('cost-streamer');
    expect(costEvents[0].cost).toBeGreaterThan(0);
  });

  it('should fall back to second provider when first stream() throws (FR-023)', async () => {
    const failingProvider: ModelProvider = {
      name: 'fail-streamer',
      async complete() {
        throw new Error('should not call complete');
      },
      stream() {
        throw new Error('stream init failure');
      },
    };

    engine = await createEngine({
      model: {
        providers: [
          {
            provider: failingProvider,
            priority: 1,
            costPerToken: null,
          },
          {
            provider: createNonStreamingProvider('backup'),
            priority: 2,
            costPerToken: null,
          },
        ],
      },
    });

    let streamResponse: ModelResponse | undefined;

    engine.register('fallback-flow', async (ctx) => {
      const stream = ctx.model.stream({ prompt: 'test fallback' });
      for await (const _ of stream) { /* consume */ }
      streamResponse = await stream.response;
      return streamResponse.text;
    });

    const exec = await engine.trigger('fallback-flow', { idempotencyKey: 'stream-4' });
    await new Promise(r => setTimeout(r, 200));
    const result = await engine.getExecution(exec.id);

    expect(result!.state).toBe('complete');
    expect(streamResponse!.provider).toBe('backup');
  });

  // T035: MockProvider.stream() integrates with CostTracker.wrapStream()
  it('should track cost when streaming through MockProvider', async () => {
    const costEvents: CostRequestEvent[] = [];
    const mockProvider = new MockProvider();

    engine = await createEngine({
      model: {
        providers: [{
          provider: mockProvider,
          priority: 1,
          costPerToken: { input: 0.01, output: 0.03 },
        }],
      },
      cost: {},
    });

    engine.on('cost:request', (event: CostRequestEvent) => {
      costEvents.push(event);
    });

    let streamEvents: StreamEvent[] = [];
    let streamResponse: ModelResponse | undefined;

    engine.register('mock-stream-cost', async (ctx) => {
      const stream = ctx.model.stream({ prompt: 'hello cost' });
      for await (const event of stream) {
        streamEvents.push(event);
      }
      streamResponse = await stream.response;
      return streamResponse.text;
    });

    const exec = await engine.trigger('mock-stream-cost', { idempotencyKey: 'stream-5' });
    await new Promise(r => setTimeout(r, 200));
    const result = await engine.getExecution(exec.id);

    expect(result!.state).toBe('complete');
    expect(streamEvents.length).toBeGreaterThan(0);
    expect(streamResponse!.provider).toBe('mock');
    expect(costEvents).toHaveLength(1);
    expect(costEvents[0].provider).toBe('mock');
    expect(costEvents[0].cost).toBeGreaterThan(0);
    // Verify cost matches expected: input=10chars*0.01 + output=26chars*0.03
    const expectedCost = 'hello cost'.length * 0.01 + 'Mock response to: hello cost'.length * 0.03;
    expect(costEvents[0].cost).toBeCloseTo(expectedCost, 5);
  });
});
