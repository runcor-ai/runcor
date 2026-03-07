// Public API contract tests for Enhanced Model Interface
// Validates the public shapes of ModelRequest, ModelResponse, StreamEvent, ModelStream, ModelInterface, ModelProvider

import { describe, it, expect } from 'vitest';
import { MockProvider } from '../../../src/model/mock.js';
import { createFallbackStream } from '../../../src/model/provider.js';
import type {
  ModelRequest,
  ModelResponse,
  ModelStream,
  StreamEvent,
  ModelProvider,
} from '../../../src/model/provider.js';
import type { ModelInterface } from '../../../src/types.js';

describe('Model API Contracts ', () => {
  describe('ModelRequest', () => {
    it('should accept prompt-only request', async () => {
      const provider = new MockProvider();
      const request: ModelRequest = { prompt: 'Hello' };
      const response = await provider.complete(request);
      expect(response.text).toContain('Hello');
    });

    it('should accept messages-only request', async () => {
      const provider = new MockProvider();
      const request: ModelRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const response = await provider.complete(request);
      expect(response.text).toBeDefined();
    });

    it('should accept both prompt and messages (messages wins)', async () => {
      const provider = new MockProvider();
      const request: ModelRequest = {
        prompt: 'Ignored prompt',
        messages: [{ role: 'user', content: 'Message content' }],
      };
      const response = await provider.complete(request);
      // MockProvider prefers messages when both provided
      expect(response.usage.promptTokens).toBe('Message content'.length);
    });

    it('should accept optional fields: model, maxTokens, temperature, tools, systemPrompt', async () => {
      const provider = new MockProvider();
      const request: ModelRequest = {
        prompt: 'test',
        model: 'claude-sonnet-4-5-20250514',
        maxTokens: 100,
        temperature: 0.5,
        tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
        systemPrompt: 'You are helpful.',
      };
      const response = await provider.complete(request);
      expect(response.text).toBeDefined();
    });
  });

  describe('ModelResponse', () => {
    it('should include text, model, provider, usage', async () => {
      const provider = new MockProvider();
      const response: ModelResponse = await provider.complete({ prompt: 'test' });

      expect(typeof response.text).toBe('string');
      expect(typeof response.model).toBe('string');
      expect(typeof response.provider).toBe('string');
      expect(typeof response.usage.promptTokens).toBe('number');
      expect(typeof response.usage.completionTokens).toBe('number');
    });

    it('should include optional toolCalls when present', async () => {
      const provider = new MockProvider();
      provider.setToolCallResponses([
        { id: 'tc1', name: 'search', arguments: { q: 'test' } },
      ]);

      const response = await provider.complete({ prompt: 'test' });
      expect(response.toolCalls).toBeDefined();
      expect(response.toolCalls![0].id).toBe('tc1');
      expect(response.toolCalls![0].name).toBe('search');
      expect(typeof response.toolCalls![0].arguments).toBe('object');
    });

    it('should have toolCalls undefined when no tool calls', async () => {
      const provider = new MockProvider();
      const response = await provider.complete({ prompt: 'test' });
      expect(response.toolCalls).toBeUndefined();
    });
  });

  describe('StreamEvent discrimination', () => {
    it('should discriminate text_delta events', () => {
      const event: StreamEvent = { type: 'text_delta', text: 'Hello' };
      if (event.type === 'text_delta') {
        expect(event.text).toBe('Hello');
      }
    });

    it('should discriminate tool_call events', () => {
      const event: StreamEvent = {
        type: 'tool_call',
        toolCall: { id: 'tc1', name: 'search', arguments: {} },
      };
      if (event.type === 'tool_call') {
        expect(event.toolCall.id).toBe('tc1');
      }
    });
  });

  describe('ModelStream lifecycle', () => {
    it('should support async iteration + .response', async () => {
      const provider = new MockProvider();
      const stream: ModelStream = provider.stream!({ prompt: 'hello' });

      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);

      const response = await stream.response;
      expect(response.text).toBeDefined();
      expect(response.model).toBe('mock');
      expect(response.provider).toBe('mock');
    });

    it('should work via createFallbackStream', async () => {
      const response: ModelResponse = {
        text: 'Fallback text',
        model: 'test',
        provider: 'test',
        usage: { promptTokens: 5, completionTokens: 13 },
      };

      const stream: ModelStream = createFallbackStream(response);
      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text_delta');

      const resp = await stream.response;
      expect(resp).toEqual(response);
    });
  });

  describe('ModelInterface contract', () => {
    it('should have complete() and stream() methods', () => {
      const provider = new MockProvider();
      // ModelProvider satisfies ModelInterface (complete + optional stream)
      const iface: ModelInterface = {
        complete: provider.complete.bind(provider),
        stream: provider.stream!.bind(provider),
      };

      expect(typeof iface.complete).toBe('function');
      expect(typeof iface.stream).toBe('function');
    });
  });

  describe('ModelProvider contract', () => {
    it('should have name, complete(), and optional stream()', () => {
      const provider: ModelProvider = new MockProvider();

      expect(typeof provider.name).toBe('string');
      expect(typeof provider.complete).toBe('function');
      // stream is optional on ModelProvider
      expect(provider.stream === undefined || typeof provider.stream === 'function').toBe(true);
    });

    it('should allow providers without stream()', () => {
      // A minimal provider with no stream()
      const minimal: ModelProvider = {
        name: 'minimal',
        async complete() {
          return {
            text: 'ok',
            model: 'minimal',
            provider: 'minimal',
            usage: { promptTokens: 0, completionTokens: 0 },
          };
        },
      };

      expect(minimal.stream).toBeUndefined();
      expect(typeof minimal.complete).toBe('function');
    });
  });
});
