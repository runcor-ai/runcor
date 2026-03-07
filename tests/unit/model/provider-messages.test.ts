// Unit tests for extended ModelRequest/Response handling (T005)
// TDD: Write tests FIRST, expect failures until T007 implements MockProvider changes

import { describe, it, expect } from 'vitest';
import { MockProvider } from '../../../src/model/mock.js';
import type { ModelRequest } from '../../../src/model/provider.js';
import type { ConversationMessage, ToolDefinition } from '../../../src/agent/types.js';

describe('Extended ModelRequest/Response', () => {
  describe('MockProvider with messages', () => {
    it('uses messages array when provided (precedence over prompt)', async () => {
      const provider = new MockProvider('fallback');
      const messages: ConversationMessage[] = [
        { role: 'system', content: 'You are a helper.' },
        { role: 'user', content: 'Hello world' },
      ];

      const request: ModelRequest = {
        prompt: 'this should be ignored',
        messages,
      };

      const response = await provider.complete(request);
      // When messages is present, the provider should use messages content
      // not the prompt field
      expect(response.text).toBeDefined();
      expect(response.model).toBe('mock');
      expect(response.provider).toBe('mock');
    });

    it('falls back to prompt when messages not provided', async () => {
      const provider = new MockProvider('Response: {prompt}');
      const response = await provider.complete({ prompt: 'test' });
      expect(response.text).toBe('Response: test');
    });

    it('passes tools through and can return toolCalls', async () => {
      const tools: ToolDefinition[] = [
        { name: 'gmail.search', description: 'Search emails', inputSchema: { type: 'object' } },
      ];

      const provider = new MockProvider();
      const request: ModelRequest = {
        prompt: '',
        messages: [
          { role: 'system', content: 'Use tools' },
          { role: 'user', content: 'Search for emails' },
        ],
        tools,
      };

      const response = await provider.complete(request);
      expect(response.usage).toBeDefined();
      expect(response.usage.promptTokens).toBeGreaterThan(0);
    });

    it('returns toolCalls when mock is configured with tool responses', async () => {
      // MockProvider can be configured to return tool calls
      const provider = new MockProvider();
      provider.setToolCallResponses([
        { id: 'call-1', name: 'gmail.search', arguments: { query: 'test' } },
      ]);

      const request: ModelRequest = {
        prompt: '',
        messages: [{ role: 'user', content: 'search' }],
        tools: [{ name: 'gmail.search', description: 'Search', inputSchema: { type: 'object' } }],
      };

      const response = await provider.complete(request);
      expect(response.toolCalls).toBeDefined();
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0].name).toBe('gmail.search');
    });

    it('returns undefined toolCalls when no tools requested', async () => {
      const provider = new MockProvider('simple response');
      const response = await provider.complete({ prompt: 'hello' });
      expect(response.toolCalls).toBeUndefined();
    });

    it('maintains backward compatibility with prompt-only requests', async () => {
      const provider = new MockProvider('Echo: {prompt}');
      const response = await provider.complete({ prompt: 'test input' });
      expect(response.text).toBe('Echo: test input');
      expect(response.model).toBe('mock');
      expect(response.provider).toBe('mock');
      expect(response.toolCalls).toBeUndefined();
    });
  });
});
