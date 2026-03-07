// Unit tests for AnthropicProvider (mocked SDK)
// AnthropicProvider.stream() tests
import { describe, it, expect, vi } from 'vitest';
import { AnthropicProvider } from '../../../src/model/anthropic.js';
import type { StreamEvent } from '../../../src/model/provider.js';

function createMockClient() {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Hello from Claude' }],
        model: 'claude-sonnet-4-5-20250514',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
        },
      }),
    },
  };
}

describe('AnthropicProvider', () => {
  it('should have name "anthropic"', () => {
    const client = createMockClient();
    const provider = new AnthropicProvider(client as any);
    expect(provider.name).toBe('anthropic');
  });

  it('should map ModelRequest to SDK messages.create() call', async () => {
    const client = createMockClient();
    const provider = new AnthropicProvider(client as any);

    await provider.complete({
      prompt: 'Hello',
      model: 'claude-sonnet-4-5-20250514',
      maxTokens: 200,
    });

    expect(client.messages.create).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 200,
      messages: [{ role: 'user', content: 'Hello' }],
    });
  });

  it('should use default model when not specified', async () => {
    const client = createMockClient();
    const provider = new AnthropicProvider(client as any);

    await provider.complete({ prompt: 'Hello' });

    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-5-20250514',
      }),
    );
  });

  it('should use default maxTokens when not specified', async () => {
    const client = createMockClient();
    const provider = new AnthropicProvider(client as any);

    await provider.complete({ prompt: 'Hello' });

    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 1024,
      }),
    );
  });

  it('should map Anthropic response to ModelResponse', async () => {
    const client = createMockClient();
    const provider = new AnthropicProvider(client as any);

    const response = await provider.complete({ prompt: 'Hello' });

    expect(response.text).toBe('Hello from Claude');
    expect(response.model).toBe('claude-sonnet-4-5-20250514');
    expect(response.provider).toBe('anthropic');
    expect(response.usage.promptTokens).toBe(10);
    expect(response.usage.completionTokens).toBe(20);
  });

  it('should classify rate limit errors as RetryableError', async () => {
    const client = createMockClient();
    client.messages.create.mockRejectedValue(new Error('API rate limited'));
    const provider = new AnthropicProvider(client as any);

    await expect(provider.complete({ prompt: 'Hello' })).rejects.toThrow('Anthropic rate limited');
    try {
      await provider.complete({ prompt: 'Hello' });
    } catch (err: any) {
      expect(err.name).toBe('RetryableError');
    }
  });

  it('should classify auth errors as EngineError with PROVIDER_AUTH_ERROR', async () => {
    const client = createMockClient();
    const authErr = Object.assign(new Error('Invalid API key'), { status: 401 });
    client.messages.create.mockRejectedValue(authErr);
    const provider = new AnthropicProvider(client as any);

    try {
      await provider.complete({ prompt: 'Hello' });
    } catch (err: any) {
      expect(err.name).toBe('EngineError');
      expect(err.code).toBe('PROVIDER_AUTH_ERROR');
    }
  });

  it('should classify server errors as RetryableError', async () => {
    const client = createMockClient();
    const serverErr = Object.assign(new Error('Internal server error'), { status: 500 });
    client.messages.create.mockRejectedValue(serverErr);
    const provider = new AnthropicProvider(client as any);

    await expect(provider.complete({ prompt: 'Hello' })).rejects.toThrow('Anthropic server error');
    try {
      await provider.complete({ prompt: 'Hello' });
    } catch (err: any) {
      expect(err.name).toBe('RetryableError');
    }
  });

  it('should classify unknown errors as EngineError with PROVIDER_ERROR', async () => {
    const client = createMockClient();
    client.messages.create.mockRejectedValue(new Error('Something unexpected'));
    const provider = new AnthropicProvider(client as any);

    try {
      await provider.complete({ prompt: 'Hello' });
    } catch (err: any) {
      expect(err.name).toBe('EngineError');
      expect(err.code).toBe('PROVIDER_ERROR');
    }
  });

  it('should include temperature when provided', async () => {
    const client = createMockClient();
    const provider = new AnthropicProvider(client as any);

    await provider.complete({ prompt: 'Hello', temperature: 0.7 });

    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.7,
      }),
    );
  });

  // AnthropicProvider.stream() tests
  describe('AnthropicProvider.stream()', () => {
    /** Create a mock MessageStream with given events and finalMessage */
    function createMockMessageStream(
      events: Array<{ event: string; data: any }>,
      finalMsg: any,
    ) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const evt of events) {
            yield evt;
          }
        },
        finalMessage: vi.fn().mockResolvedValue(finalMsg),
      };
    }

    function createStreamClient(messageStream: any) {
      return {
        messages: {
          create: vi.fn(),
          stream: vi.fn().mockReturnValue(messageStream),
        },
      };
    }

    it('should yield text_delta events for text content', async () => {
      const stream = createMockMessageStream(
        [
          { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } } },
          { event: 'message_stop', data: {} },
        ],
        {
          content: [{ type: 'text', text: 'Hello world' }],
          model: 'claude-sonnet-4-5-20250514',
          usage: { input_tokens: 5, output_tokens: 11 },
        },
      );

      const client = createStreamClient(stream);
      const provider = new AnthropicProvider(client as any);

      const modelStream = provider.stream!({ prompt: 'Hi' });
      const events: StreamEvent[] = [];
      for await (const event of modelStream) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'text_delta', text: 'Hello ' });
      expect(events[1]).toEqual({ type: 'text_delta', text: 'world' });
    });

    it('should accumulate tool calls and emit on content_block_stop', async () => {
      const stream = createMockMessageStream(
        [
          { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tc1', name: 'search' } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"test"}' } } },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          { event: 'message_stop', data: {} },
        ],
        {
          content: [{ type: 'tool_use', id: 'tc1', name: 'search', input: { q: 'test' } }],
          model: 'claude-sonnet-4-5-20250514',
          usage: { input_tokens: 10, output_tokens: 15 },
        },
      );

      const client = createStreamClient(stream);
      const provider = new AnthropicProvider(client as any);

      const modelStream = provider.stream!({ prompt: 'Find something' });
      const events: StreamEvent[] = [];
      for await (const event of modelStream) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_call');
      const tc = (events[0] as { type: 'tool_call'; toolCall: any }).toolCall;
      expect(tc.id).toBe('tc1');
      expect(tc.name).toBe('search');
      expect(tc.arguments).toEqual({ q: 'test' });
    });

    it('should resolve .response with aggregated usage and toolCalls', async () => {
      const stream = createMockMessageStream(
        [
          { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Response' } } },
          { event: 'message_stop', data: {} },
        ],
        {
          content: [{ type: 'text', text: 'Response' }],
          model: 'claude-sonnet-4-5-20250514',
          usage: { input_tokens: 8, output_tokens: 3 },
        },
      );

      const client = createStreamClient(stream);
      const provider = new AnthropicProvider(client as any);

      const modelStream = provider.stream!({ prompt: 'Hi' });
      for await (const _ of modelStream) { /* consume */ }
      const resp = await modelStream.response;

      expect(resp.text).toBe('Response');
      expect(resp.model).toBe('claude-sonnet-4-5-20250514');
      expect(resp.provider).toBe('anthropic');
      expect(resp.usage.promptTokens).toBe(8);
      expect(resp.usage.completionTokens).toBe(3);
    });

    it('should emit raw text_delta on invalid tool call JSON', async () => {
      const stream = createMockMessageStream(
        [
          { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tc1', name: 'calc' } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{invalid json' } } },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          { event: 'message_stop', data: {} },
        ],
        {
          content: [],
          model: 'claude-sonnet-4-5-20250514',
          usage: { input_tokens: 5, output_tokens: 5 },
        },
      );

      const client = createStreamClient(stream);
      const provider = new AnthropicProvider(client as any);

      const modelStream = provider.stream!({ prompt: 'calc' });
      const events: StreamEvent[] = [];
      for await (const event of modelStream) {
        events.push(event);
      }

      // Invalid JSON → emitted as text_delta fallback
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text_delta');
      expect((events[0] as { type: 'text_delta'; text: string }).text).toBe('{invalid json');
    });

    it('should handle empty response gracefully', async () => {
      const stream = createMockMessageStream(
        [
          { event: 'message_stop', data: {} },
        ],
        {
          content: [],
          model: 'claude-sonnet-4-5-20250514',
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      );

      const client = createStreamClient(stream);
      const provider = new AnthropicProvider(client as any);

      const modelStream = provider.stream!({ prompt: 'Hi' });
      const events: StreamEvent[] = [];
      for await (const event of modelStream) {
        events.push(event);
      }

      expect(events).toHaveLength(0);
      const resp = await modelStream.response;
      expect(resp.text).toBe('');
      expect(resp.usage.completionTokens).toBe(0);
    });

    it('should handle tool-only response (no text)', async () => {
      const stream = createMockMessageStream(
        [
          { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tc1', name: 'action' } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } } },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          { event: 'message_stop', data: {} },
        ],
        {
          content: [{ type: 'tool_use', id: 'tc1', name: 'action', input: {} }],
          model: 'claude-sonnet-4-5-20250514',
          usage: { input_tokens: 5, output_tokens: 10 },
        },
      );

      const client = createStreamClient(stream);
      const provider = new AnthropicProvider(client as any);

      const modelStream = provider.stream!({ prompt: 'Do something' });
      const events: StreamEvent[] = [];
      for await (const event of modelStream) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_call');

      const resp = await modelStream.response;
      expect(resp.text).toBe('');
      expect(resp.toolCalls).toHaveLength(1);
      expect(resp.toolCalls![0].name).toBe('action');
    });

    // T038: Verify stream() reuses systemPrompt and tools translation
    it('should pass systemPrompt and tools to stream() call', async () => {
      const stream = createMockMessageStream(
        [
          { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } } },
          { event: 'message_stop', data: {} },
        ],
        {
          content: [{ type: 'text', text: 'OK' }],
          model: 'claude-sonnet-4-5-20250514',
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      );

      const client = createStreamClient(stream);
      const provider = new AnthropicProvider(client as any);

      provider.stream!({
        messages: [{ role: 'user', content: 'Help me' }],
        systemPrompt: 'You are a helpful assistant.',
        tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
      });

      expect(client.messages.stream).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'You are a helpful assistant.',
          messages: [{ role: 'user', content: 'Help me' }],
          tools: [{ name: 'search', description: 'Search', input_schema: { type: 'object' } }],
        }),
      );
    });
  });
});
