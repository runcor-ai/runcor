// Unit tests for conversation message utilities (T006)
// TDD: Write tests FIRST, expect failures until T009 implements utilities

import { describe, it, expect } from 'vitest';
import {
  buildInitialMessages,
  appendAssistantMessage,
  appendToolResults,
  truncateHistory,
} from '../../../src/agent/conversation.js';
import type { ConversationMessage, ToolCallRequest } from '../../../src/agent/types.js';
import type { ToolCallResult } from '../../../src/types.js';

describe('Conversation utilities', () => {
  describe('buildInitialMessages', () => {
    it('creates system + user messages from prompt and input', () => {
      const messages = buildInitialMessages('You are a helper.', 'What is 2+2?');
      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ role: 'system', content: 'You are a helper.' });
      expect(messages[1]).toEqual({ role: 'user', content: 'What is 2+2?' });
    });

    it('stringifies non-string input', () => {
      const messages = buildInitialMessages('Analyze this', { data: [1, 2, 3] });
      expect(messages[1].role).toBe('user');
      expect(messages[1].content).toContain('data');
    });

    it('handles empty string input', () => {
      const messages = buildInitialMessages('System prompt', '');
      expect(messages).toHaveLength(2);
      expect(messages[1].content).toBe('');
    });
  });

  describe('appendAssistantMessage', () => {
    it('appends assistant message with text content', () => {
      const messages: ConversationMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ];
      const result = appendAssistantMessage(messages, 'Hello!', undefined);
      expect(result).toHaveLength(3);
      expect(result[2]).toEqual({ role: 'assistant', content: 'Hello!' });
    });

    it('appends assistant message with tool calls', () => {
      const messages: ConversationMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'search' },
      ];
      const toolCalls: ToolCallRequest[] = [
        { id: 'tc-1', name: 'gmail.search', arguments: { query: 'test' } },
      ];
      const result = appendAssistantMessage(messages, 'Let me search.', toolCalls);
      expect(result).toHaveLength(3);
      expect(result[2].role).toBe('assistant');
      expect(result[2].content).toBe('Let me search.');
      expect(result[2].toolCalls).toEqual(toolCalls);
    });

    it('does not mutate the original array', () => {
      const messages: ConversationMessage[] = [{ role: 'system', content: 'sys' }];
      const result = appendAssistantMessage(messages, 'text', undefined);
      expect(messages).toHaveLength(1);
      expect(result).toHaveLength(2);
    });
  });

  describe('appendToolResults', () => {
    it('appends tool result messages for each tool call', () => {
      const messages: ConversationMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'search' },
        { role: 'assistant', content: '', toolCalls: [
          { id: 'tc-1', name: 'gmail.search', arguments: { q: 'test' } },
          { id: 'tc-2', name: 'slack.post', arguments: { msg: 'hi' } },
        ] },
      ];

      const results: Array<{ toolCallId: string; toolName: string; result: ToolCallResult }> = [
        {
          toolCallId: 'tc-1',
          toolName: 'gmail.search',
          result: { content: [{ type: 'text', text: '3 emails found' }], isError: false },
        },
        {
          toolCallId: 'tc-2',
          toolName: 'slack.post',
          result: { content: [{ type: 'text', text: 'Posted' }], isError: false },
        },
      ];

      const updated = appendToolResults(messages, results);
      expect(updated).toHaveLength(5);
      expect(updated[3]).toEqual({
        role: 'tool',
        content: '3 emails found',
        toolCallId: 'tc-1',
        toolName: 'gmail.search',
      });
      expect(updated[4]).toEqual({
        role: 'tool',
        content: 'Posted',
        toolCallId: 'tc-2',
        toolName: 'slack.post',
      });
    });

    it('handles error results', () => {
      const messages: ConversationMessage[] = [{ role: 'system', content: 'sys' }];
      const results = [{
        toolCallId: 'tc-1',
        toolName: 'gmail.search',
        result: { content: [{ type: 'text' as const, text: 'Connection failed' }], isError: true },
      }];

      const updated = appendToolResults(messages, results);
      expect(updated[1].content).toContain('Connection failed');
    });

    it('does not mutate the original array', () => {
      const messages: ConversationMessage[] = [{ role: 'system', content: 'sys' }];
      const results = [{
        toolCallId: 'tc-1',
        toolName: 'test.tool',
        result: { content: [{ type: 'text' as const, text: 'ok' }], isError: false },
      }];
      const updated = appendToolResults(messages, results);
      expect(messages).toHaveLength(1);
      expect(updated).toHaveLength(2);
    });
  });

  describe('truncateHistory', () => {
    const buildHistory = (count: number): ConversationMessage[] => {
      const messages: ConversationMessage[] = [{ role: 'system', content: 'System prompt' }];
      for (let i = 0; i < count; i++) {
        messages.push({ role: 'user', content: `User message ${i}` });
        messages.push({ role: 'assistant', content: `Assistant response ${i}` });
      }
      return messages;
    };

    it('preserves all messages when under the limit', () => {
      const messages = buildHistory(3); // 7 messages total
      const result = truncateHistory(messages, 10);
      expect(result).toHaveLength(7);
    });

    it('truncates oldest non-system messages when over limit', () => {
      const messages = buildHistory(5); // 11 messages: 1 system + 10 exchanges
      const result = truncateHistory(messages, 5);
      expect(result).toHaveLength(5);
      // System prompt is always preserved
      expect(result[0]).toEqual({ role: 'system', content: 'System prompt' });
    });

    it('always preserves the system prompt', () => {
      const messages = buildHistory(10); // 21 messages
      const result = truncateHistory(messages, 3);
      expect(result[0].role).toBe('system');
      expect(result[0].content).toBe('System prompt');
      expect(result).toHaveLength(3);
    });

    it('keeps the most recent messages', () => {
      const messages = buildHistory(5); // 11 messages
      const result = truncateHistory(messages, 5);
      // Last message should be the most recent
      const lastMsg = result[result.length - 1];
      expect(lastMsg.content).toBe('Assistant response 4');
    });

    it('returns original array when no limit set (undefined)', () => {
      const messages = buildHistory(3);
      const result = truncateHistory(messages, undefined);
      expect(result).toHaveLength(7);
    });

    it('handles edge case of maxHistoryMessages = 2', () => {
      const messages = buildHistory(5);
      const result = truncateHistory(messages, 2);
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('system');
    });
  });
});
