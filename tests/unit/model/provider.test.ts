// Type-level tests for StreamEvent, ModelStream, ModelRequest, ModelProvider
// Feature 015: Enhanced Model Interface

import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  ModelRequest,
  ModelResponse,
  ModelProvider,
  StreamEvent,
  ModelStream,
} from '../../../src/model/provider.js';
import type { ModelInterface } from '../../../src/types.js';

describe('StreamEvent (discriminated union)', () => {
  it('accepts a valid text_delta event', () => {
    const event: StreamEvent = { type: 'text_delta', text: 'hi' };
    expect(event.type).toBe('text_delta');
    expect((event as { type: 'text_delta'; text: string }).text).toBe('hi');
  });

  it('accepts a valid tool_call event', () => {
    const event: StreamEvent = {
      type: 'tool_call',
      toolCall: { id: '1', name: 'foo', arguments: {} },
    };
    expect(event.type).toBe('tool_call');
    expect((event as { type: 'tool_call'; toolCall: { id: string; name: string; arguments: Record<string, unknown> } }).toolCall.name).toBe('foo');
  });

  it('discriminates between text_delta and tool_call via type field', () => {
    const events: StreamEvent[] = [
      { type: 'text_delta', text: 'hello' },
      { type: 'tool_call', toolCall: { id: '1', name: 'bar', arguments: { x: 1 } } },
    ];

    const texts: string[] = [];
    const toolNames: string[] = [];

    for (const event of events) {
      if (event.type === 'text_delta') {
        texts.push(event.text);
      } else if (event.type === 'tool_call') {
        toolNames.push(event.toolCall.name);
      }
    }

    expect(texts).toEqual(['hello']);
    expect(toolNames).toEqual(['bar']);
  });

  it('tool_call arguments is a parsed object (Record<string, unknown>)', () => {
    const event: StreamEvent = {
      type: 'tool_call',
      toolCall: { id: 'tc1', name: 'search', arguments: { query: 'test', limit: 10 } },
    };
    if (event.type === 'tool_call') {
      expect(typeof event.toolCall.arguments).toBe('object');
      expect(event.toolCall.arguments).toEqual({ query: 'test', limit: 10 });
    }
  });
});

describe('ModelStream (wrapper interface)', () => {
  it('has Symbol.asyncIterator and response promise', () => {
    // Create a minimal ModelStream-compatible object
    const mockResponse: ModelResponse = {
      text: 'hello world',
      model: 'test-model',
      provider: 'test',
      usage: { promptTokens: 10, completionTokens: 5 },
    };

    const stream: ModelStream = {
      [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        let done = false;
        return {
          async next() {
            if (!done) {
              done = true;
              return { value: { type: 'text_delta' as const, text: 'hello world' }, done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
      response: Promise.resolve(mockResponse),
    };

    expect(stream[Symbol.asyncIterator]).toBeDefined();
    expect(stream.response).toBeInstanceOf(Promise);
  });

  it('async iteration yields StreamEvent items', async () => {
    const events: StreamEvent[] = [
      { type: 'text_delta', text: 'hello ' },
      { type: 'text_delta', text: 'world' },
    ];

    const mockResponse: ModelResponse = {
      text: 'hello world',
      model: 'test-model',
      provider: 'test',
      usage: { promptTokens: 10, completionTokens: 5 },
    };

    let index = 0;
    const stream: ModelStream = {
      [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        return {
          async next() {
            if (index < events.length) {
              return { value: events[index++], done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
      response: Promise.resolve(mockResponse),
    };

    const collected: StreamEvent[] = [];
    for await (const event of stream) {
      collected.push(event);
    }

    expect(collected).toHaveLength(2);
    expect(collected[0]).toEqual({ type: 'text_delta', text: 'hello ' });
    expect(collected[1]).toEqual({ type: 'text_delta', text: 'world' });
  });

  it('.response resolves to a valid ModelResponse', async () => {
    const mockResponse: ModelResponse = {
      text: 'result',
      model: 'gpt-4',
      provider: 'openai',
      usage: { promptTokens: 100, completionTokens: 50 },
      toolCalls: [{ id: 'tc1', name: 'search', arguments: { q: 'test' } }],
    };

    const stream: ModelStream = {
      [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        return { async next() { return { value: undefined, done: true }; } };
      },
      response: Promise.resolve(mockResponse),
    };

    const response = await stream.response;
    expect(response.text).toBe('result');
    expect(response.model).toBe('gpt-4');
    expect(response.provider).toBe('openai');
    expect(response.usage.promptTokens).toBe(100);
    expect(response.usage.completionTokens).toBe(50);
    expect(response.toolCalls).toHaveLength(1);
  });
});

describe('ModelRequest (prompt now optional)', () => {
  it('accepts prompt-only request', () => {
    const req: ModelRequest = { prompt: 'hello' };
    expect(req.prompt).toBe('hello');
  });

  it('accepts messages-only request (no prompt)', () => {
    const req: ModelRequest = {
      messages: [{ role: 'user', content: 'hello' }],
    };
    expect(req.prompt).toBeUndefined();
    expect(req.messages).toHaveLength(1);
  });

  it('accepts both prompt and messages', () => {
    const req: ModelRequest = {
      prompt: 'ignored',
      messages: [{ role: 'user', content: 'used' }],
    };
    expect(req.prompt).toBe('ignored');
    expect(req.messages).toHaveLength(1);
  });

  it('accepts tools, systemPrompt alongside messages', () => {
    const req: ModelRequest = {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
      systemPrompt: 'You are helpful.',
    };
    expect(req.tools).toHaveLength(1);
    expect(req.systemPrompt).toBe('You are helpful.');
  });
});

describe('ModelProvider (stream optional)', () => {
  it('satisfies interface with only complete()', () => {
    const provider: ModelProvider = {
      name: 'basic',
      complete: async () => ({
        text: 'hi',
        model: 'm',
        provider: 'basic',
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
    };
    expect(provider.name).toBe('basic');
    expect(provider.stream).toBeUndefined();
  });

  it('satisfies interface with complete() and stream()', () => {
    const provider: ModelProvider = {
      name: 'full',
      complete: async () => ({
        text: 'hi',
        model: 'm',
        provider: 'full',
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
      stream: () => {
        const response: ModelResponse = {
          text: 'hi',
          model: 'm',
          provider: 'full',
          usage: { promptTokens: 1, completionTokens: 1 },
        };
        return {
          [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
            return { async next() { return { value: undefined, done: true }; } };
          },
          response: Promise.resolve(response),
        };
      },
    };
    expect(provider.name).toBe('full');
    expect(provider.stream).toBeDefined();
  });
});

describe('ModelInterface (stream required)', () => {
  it('requires both complete() and stream()', () => {
    const mockResponse: ModelResponse = {
      text: 'hi',
      model: 'm',
      provider: 'p',
      usage: { promptTokens: 1, completionTokens: 1 },
    };

    const iface: ModelInterface = {
      complete: async () => mockResponse,
      stream: () => ({
        [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
          return { async next() { return { value: undefined, done: true }; } };
        },
        response: Promise.resolve(mockResponse),
      }),
    };

    expect(iface.complete).toBeDefined();
    expect(iface.stream).toBeDefined();
  });
});
