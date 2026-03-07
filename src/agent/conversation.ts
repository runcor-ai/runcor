// Conversation message management and truncation

import type { ConversationMessage, ToolCallRequest } from './types.js';
import type { ToolCallResult } from '../types.js';

/** Build the initial conversation from system prompt and user input */
export function buildInitialMessages(systemPrompt: string, input: unknown): ConversationMessage[] {
  const userContent = typeof input === 'string' ? input : JSON.stringify(input);
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
}

/** Append an assistant message to the conversation history (immutable) */
export function appendAssistantMessage(
  messages: ConversationMessage[],
  text: string,
  toolCalls: ToolCallRequest[] | undefined,
): ConversationMessage[] {
  const assistantMsg: ConversationMessage = { role: 'assistant', content: text };
  if (toolCalls && toolCalls.length > 0) {
    assistantMsg.toolCalls = toolCalls;
  }
  return [...messages, assistantMsg];
}

/** Extract text content from a ToolCallResult */
function extractToolResultText(result: ToolCallResult): string {
  return result.content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text!)
    .join('\n');
}

/** Append tool result messages to the conversation history (immutable) */
export function appendToolResults(
  messages: ConversationMessage[],
  results: Array<{ toolCallId: string; toolName: string; result: ToolCallResult }>,
): ConversationMessage[] {
  const toolMessages: ConversationMessage[] = results.map((r) => ({
    role: 'tool' as const,
    content: extractToolResultText(r.result),
    toolCallId: r.toolCallId,
    toolName: r.toolName,
  }));
  return [...messages, ...toolMessages];
}

/** Truncate conversation history, preserving system prompt and most recent messages */
export function truncateHistory(
  messages: ConversationMessage[],
  maxHistoryMessages: number | undefined,
): ConversationMessage[] {
  if (maxHistoryMessages === undefined || messages.length <= maxHistoryMessages) {
    return messages;
  }

  // Always preserve the system prompt (first message)
  const systemMsg = messages[0];
  const rest = messages.slice(1);

  // Keep the most recent (maxHistoryMessages - 1) non-system messages
  const keepCount = maxHistoryMessages - 1;
  const kept = rest.slice(-keepCount);

  return [systemMsg, ...kept];
}
