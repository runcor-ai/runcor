// OpenAIProvider implementation
// Mirrors AnthropicProvider pattern with OpenAI chat completions API translation

import type OpenAI from 'openai';
import type { ModelProvider, ModelRequest, ModelResponse } from './provider.js';
import type { ToolCallRequest } from '../agent/types.js';
import { classifyProviderError } from './provider-errors.js';

const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_MAX_TOKENS = 1024;

/** OpenAI model provider using the official SDK */
export class OpenAIProvider implements ModelProvider {
  readonly name: string;
  private readonly client: OpenAI;
  private readonly defaultModel: string;

  constructor(client: OpenAI, options?: { name?: string; defaultModel?: string }) {
    this.client = client;
    this.defaultModel = options?.defaultModel ?? DEFAULT_MODEL;
    this.name = options?.name ?? `openai/${this.defaultModel}`;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    try {
      const params: Record<string, unknown> = {
        model: request.model ?? this.defaultModel,
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      };

      // Build messages array
      if (request.messages && request.messages.length > 0) {
        // OpenAI supports system role directly in messages
        params.messages = request.messages.map((m) => {
          if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
            // Assistant message with tool calls → OpenAI tool_calls format
            const msg: Record<string, unknown> = {
              role: 'assistant',
              content: m.content || null,
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments),
                },
              })),
            };
            return msg;
          }

          if (m.role === 'tool') {
            // Tool result → OpenAI tool message
            return {
              role: 'tool',
              tool_call_id: m.toolCallId,
              content: m.content,
            };
          }

          // Regular system/user/assistant message
          return { role: m.role, content: m.content };
        });
      } else {
        // Backward compatible: use prompt as single user message
        const messages: unknown[] = [];
        if (request.systemPrompt) {
          messages.push({ role: 'system', content: request.systemPrompt });
        }
        messages.push({ role: 'user', content: request.prompt });
        params.messages = messages;
      }

      // Handle systemPrompt for messages-based requests
      if (request.messages && request.messages.length > 0 && request.systemPrompt) {
        const msgs = params.messages as unknown[];
        const hasSystem = request.messages.some((m) => m.role === 'system');
        if (!hasSystem) {
          (msgs as unknown[]).unshift({ role: 'system', content: request.systemPrompt });
        }
      }

      // Translate tools to OpenAI format
      if (request.tools && request.tools.length > 0) {
        params.tools = request.tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        }));
      }

      if (request.temperature !== undefined) {
        params.temperature = request.temperature;
      }

      // Map responseFormat to OpenAI response_format
      if (request.responseFormat && request.responseFormat !== 'text') {
        if (request.responseFormat === 'json') {
          params.response_format = { type: 'json_object' };
        } else {
          // Schema mode
          params.response_format = {
            type: 'json_schema',
            json_schema: {
              name: 'response',
              strict: true,
              schema: request.responseFormat,
            },
          };
        }
      }

      // SDK types incompatible — params is Record<string,unknown> but SDK expects ChatCompletionCreateParams
      const response = await (this.client.chat.completions.create as Function)(params);

      const choice = response.choices?.[0];
      const text = choice?.message?.content ?? '';

      // Extract tool calls
      let toolCalls: ToolCallRequest[] | undefined;
      const rawToolCalls = choice?.message?.tool_calls;
      if (rawToolCalls && rawToolCalls.length > 0) {
        toolCalls = rawToolCalls.map((tc: Record<string, unknown>) => {
          const fn = tc.function as { name: string; arguments: string };
          let args: unknown;
          try {
            args = JSON.parse(fn.arguments);
          } catch {
            args = {};
          }
          return {
            id: tc.id,
            name: fn.name,
            arguments: args,
          };
        });
      }

      return {
        text,
        model: response.model ?? request.model ?? this.defaultModel,
        provider: 'openai',
        usage: {
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0,
        },
        toolCalls,
      };
    } catch (err: unknown) {
      classifyProviderError('OpenAI', err);
    }
  }
}
