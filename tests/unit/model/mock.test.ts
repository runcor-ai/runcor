// Unit tests for MockProvider
// Tool API tests
// MockProvider.stream() tests
import { describe, it, expect } from 'vitest';
import { MockProvider } from '../../../src/model/mock.js';
import type { ToolCallRequest } from '../../../src/agent/types.js';
import type { StreamEvent } from '../../../src/model/provider.js';

describe('MockProvider', () => {
  it('should have name "mock"', () => {
    const provider = new MockProvider();
    expect(provider.name).toBe('mock');
  });

  it('should return deterministic response with default template', async () => {
    const provider = new MockProvider();
    const response = await provider.complete({ prompt: 'Hello world' });

    expect(response.text).toBe('Mock response to: Hello world');
    expect(response.model).toBe('mock');
    expect(response.provider).toBe('mock');
  });

  it('should return deterministic response with custom template', async () => {
    const provider = new MockProvider('Custom: {prompt}');
    const response = await provider.complete({ prompt: 'Test input' });

    expect(response.text).toBe('Custom: Test input');
  });

  it('should report usage as string lengths', async () => {
    const provider = new MockProvider();
    const prompt = 'Hello';
    const response = await provider.complete({ prompt });

    expect(response.usage.promptTokens).toBe(prompt.length);
    expect(response.usage.completionTokens).toBe(response.text.length);
  });

  it('should ignore optional request fields', async () => {
    const provider = new MockProvider();
    const response = await provider.complete({
      prompt: 'test',
      model: 'claude-sonnet-4-5-20250514',
      maxTokens: 100,
      temperature: 0.5,
    });

    expect(response.text).toBe('Mock response to: test');
    expect(response.model).toBe('mock');
  });

  // Public tool API tests
  describe('US2: Public tool API', () => {
    it('should pass tools through in request and return toolCalls', async () => {
      const provider = new MockProvider();
      const toolCalls: ToolCallRequest[] = [
        { id: 'tc1', name: 'search', arguments: { query: 'hello' } },
      ];
      provider.setToolCallResponses(toolCalls);

      const response = await provider.complete({
        messages: [{ role: 'user', content: 'Find something' }],
        tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
      });

      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0].id).toBe('tc1');
      expect(response.toolCalls![0].name).toBe('search');
      expect(response.toolCalls![0].arguments).toEqual({ query: 'hello' });
    });

    it('should return toolCalls with parsed object arguments (FR-022)', async () => {
      const provider = new MockProvider();
      provider.setToolCallResponses([
        { id: 'tc2', name: 'calc', arguments: { x: 42, nested: { a: true } } },
      ]);

      const response = await provider.complete({
        messages: [{ role: 'user', content: 'Calculate' }],
      });

      expect(typeof response.toolCalls![0].arguments).toBe('object');
      expect(response.toolCalls![0].arguments).toEqual({ x: 42, nested: { a: true } });
    });

    it('should accept tool-role messages with toolCallId and toolName (FR-021)', async () => {
      const provider = new MockProvider();
      const response = await provider.complete({
        messages: [
          { role: 'user', content: 'Search' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'search', arguments: {} }] },
          { role: 'tool', content: '{"results": []}', toolCallId: 'tc1', toolName: 'search' },
          { role: 'user', content: 'Thanks' },
        ],
      });

      // MockProvider just processes the messages — it should not crash
      expect(response.text).toContain('Search');
      expect(response.model).toBe('mock');
    });

    it('should treat empty tools array as absent', async () => {
      const provider = new MockProvider();
      const response = await provider.complete({
        prompt: 'hello',
        tools: [],
      });

      expect(response.text).toBe('Mock response to: hello');
      expect(response.toolCalls).toBeUndefined();
    });
  });

  // MockProvider backward compatibility
  describe('US2: MockProvider backward compatibility', () => {
    it('queueResponses() still works with text-only responses', async () => {
      const provider = new MockProvider();
      provider.queueResponses([
        { text: 'First' },
        { text: 'Second' },
      ]);

      const r1 = await provider.complete({ prompt: 'test' });
      const r2 = await provider.complete({ prompt: 'test' });
      expect(r1.text).toBe('First');
      expect(r2.text).toBe('Second');
    });

    it('queueResponses() still works with toolCalls', async () => {
      const provider = new MockProvider();
      provider.queueResponses([
        { toolCalls: [{ id: 'tc1', name: 'tool', arguments: { a: 1 } }] },
        { text: 'Done' },
      ]);

      const r1 = await provider.complete({ prompt: 'test' });
      expect(r1.toolCalls).toHaveLength(1);
      expect(r1.text).toBe('');

      const r2 = await provider.complete({ prompt: 'test' });
      expect(r2.text).toBe('Done');
      expect(r2.toolCalls).toBeUndefined();
    });

    it('setToolCallResponses() still works as one-shot', async () => {
      const provider = new MockProvider();
      provider.setToolCallResponses([
        { id: 'tc1', name: 'search', arguments: {} },
      ]);

      const r1 = await provider.complete({ prompt: 'test' });
      expect(r1.toolCalls).toHaveLength(1);

      // Second call should use default behavior
      const r2 = await provider.complete({ prompt: 'test' });
      expect(r2.toolCalls).toBeUndefined();
      expect(r2.text).toBe('Mock response to: test');
    });

    it('existing tool call behavior preserved (FR-016)', async () => {
      const provider = new MockProvider();
      provider.setToolCallResponses([
        { id: 'tc1', name: 'tool.action', arguments: { key: 'value' } },
      ]);

      const response = await provider.complete({ prompt: 'invoke' });
      expect(response.text).toBe('');
      expect(response.usage.promptTokens).toBe('invoke'.length);
      expect(response.usage.completionTokens).toBe(0);
      expect(response.toolCalls![0]).toEqual({
        id: 'tc1',
        name: 'tool.action',
        arguments: { key: 'value' },
      });
    });
  });

  // MockProvider.stream() tests
  describe('US6: MockProvider.stream()', () => {
    it('should yield entire response as one text_delta chunk by default', async () => {
      const provider = new MockProvider();
      const stream = provider.stream({ prompt: 'hello' });

      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text_delta');
      expect((events[0] as { type: 'text_delta'; text: string }).text).toBe('Mock response to: hello');
    });

    it('should split response into chunks when chunkSize is set', async () => {
      const provider = new MockProvider('ABCDEFGHIJ');
      provider.chunkSize = 3;

      const stream = provider.stream({ prompt: 'test' });
      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      // "ABCDEFGHIJ" = 10 chars, chunkSize=3 → 4 chunks: ABC, DEF, GHI, J
      expect(events).toHaveLength(4);
      expect(events.every(e => e.type === 'text_delta')).toBe(true);
      const texts = events.map(e => (e as { type: 'text_delta'; text: string }).text);
      expect(texts.join('')).toBe('ABCDEFGHIJ');
    });

    it('should resolve .response with same shape as complete()', async () => {
      const provider = new MockProvider();
      const stream = provider.stream({ prompt: 'hello' });

      for await (const _ of stream) { /* consume */ }
      const resp = await stream.response;

      expect(resp.text).toBe('Mock response to: hello');
      expect(resp.model).toBe('mock');
      expect(resp.provider).toBe('mock');
      expect(resp.usage.promptTokens).toBe('hello'.length);
      expect(resp.usage.completionTokens).toBe('Mock response to: hello'.length);
    });

    it('should work with queued responses', async () => {
      const provider = new MockProvider();
      provider.queueResponses([{ text: 'Queued response' }]);

      const stream = provider.stream({ prompt: 'test' });
      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect((events[0] as { type: 'text_delta'; text: string }).text).toBe('Queued response');
    });

    it('should yield tool_call events for queued toolCalls', async () => {
      const provider = new MockProvider();
      provider.queueResponses([{
        toolCalls: [
          { id: 'tc1', name: 'search', arguments: { q: 'test' } },
        ],
      }]);

      const stream = provider.stream({ prompt: 'test' });
      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_call');
    });

    it('should yield no events for empty response', async () => {
      const provider = new MockProvider('');
      const stream = provider.stream({ prompt: 'test' });

      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events).toHaveLength(0);
    });

    it('should work with messages-based requests', async () => {
      const provider = new MockProvider();
      const stream = provider.stream({
        messages: [{ role: 'user', content: 'Hello world' }],
      });

      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      const resp = await stream.response;
      expect(resp.usage.promptTokens).toBe('Hello world'.length);
    });
  });
});
