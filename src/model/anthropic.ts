// AnthropicProvider implementation
// Provider-agnostic model interface backed by @anthropic-ai/sdk
// Extended for agent support: messages, tools, toolCalls

import type Anthropic from '@anthropic-ai/sdk';
import type { ModelProvider, ModelRequest, ModelResponse, ModelStream, StreamEvent } from './provider.js';
import type { ToolCallRequest } from '../agent/types.js';
import { classifyProviderError } from './provider-errors.js';

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250514';
const DEFAULT_MAX_TOKENS = 1024;

/** Anthropic model provider using the official SDK */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(client: Anthropic) {
    this.client = client;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    try {
      const params = this.buildParams(request);
      // SDK MessageCreateParams type is stricter than our dynamic params object
      const response = await this.client.messages.create(params as unknown as Anthropic.MessageCreateParams) as Anthropic.Message;
      return this.parseResponse(response, request);
    } catch (err: unknown) {
      classifyProviderError('Anthropic', err);
    }
  }

  /** Stream a response via SDK's messages.stream(). Accumulates tool call JSON and emits complete tool_call events. */
  stream(request: ModelRequest): ModelStream {
    const params = this.buildParams(request);
    // SDK types incompatible — messages.stream() exists at runtime but has version-dependent type exports
    const sdkStream = (this.client.messages as any).stream(params);

    // Accumulate tool calls across content block deltas
    const pendingToolBlocks = new Map<number, { id: string; name: string; jsonParts: string[] }>();
    const toolCalls: ToolCallRequest[] = [];
    let aggregatedText = '';

    const self = this;
    let resolveResponse: (resp: ModelResponse) => void;
    const responsePromise = new Promise<ModelResponse>((resolve) => {
      resolveResponse = resolve;
    });

    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
        for await (const event of sdkStream) {
          const data = event.data ?? event;

          if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
            pendingToolBlocks.set(data.index, {
              id: data.content_block.id,
              name: data.content_block.name,
              jsonParts: [],
            });
            continue;
          }

          if (data.type === 'content_block_delta') {
            if (data.delta?.type === 'text_delta') {
              aggregatedText += data.delta.text;
              yield { type: 'text_delta', text: data.delta.text };
            } else if (data.delta?.type === 'input_json_delta') {
              const block = pendingToolBlocks.get(data.index);
              if (block) {
                block.jsonParts.push(data.delta.partial_json);
              }
            }
            continue;
          }

          if (data.type === 'content_block_stop') {
            const block = pendingToolBlocks.get(data.index);
            if (block) {
              const rawJson = block.jsonParts.join('');
              try {
                const args = JSON.parse(rawJson);
                const tc: ToolCallRequest = { id: block.id, name: block.name, arguments: args };
                toolCalls.push(tc);
                yield { type: 'tool_call', toolCall: tc };
              } catch {
                // Invalid JSON — emit as text_delta fallback
                yield { type: 'text_delta', text: rawJson };
              }
              pendingToolBlocks.delete(data.index);
            }
            continue;
          }
        }

        // Stream consumed — resolve .response from finalMessage()
        // SDK stream finalMessage returns untyped shape — extract fields safely
        const finalMsg = await sdkStream.finalMessage() as Record<string, unknown>;
        const usage = finalMsg.usage as Record<string, number> | undefined;
        const contentBlocks = (finalMsg.content ?? []) as Array<Record<string, unknown>>;
        const textBlock = contentBlocks.find((b) => b.type === 'text');
        const text = (textBlock?.text as string) ?? aggregatedText;

        // Use accumulated toolCalls or extract from finalMessage
        let finalToolCalls: ToolCallRequest[] | undefined;
        if (toolCalls.length > 0) {
          finalToolCalls = toolCalls;
        } else {
          const toolUseBlocks = contentBlocks.filter((b) => b.type === 'tool_use');
          if (toolUseBlocks.length > 0) {
            finalToolCalls = toolUseBlocks.map((b) => ({
              id: b.id as string,
              name: b.name as string,
              arguments: b.input as Record<string, unknown>,
            }));
          }
        }

        const resp: ModelResponse = {
          text,
          model: (finalMsg.model as string) ?? request.model ?? DEFAULT_MODEL,
          provider: 'anthropic',
          usage: {
            promptTokens: usage?.input_tokens ?? 0,
            completionTokens: usage?.output_tokens ?? 0,
          },
          toolCalls: finalToolCalls,
        };
        resolveResponse(resp);
      },
      response: responsePromise,
    };
  }

  /** Build Anthropic SDK params from ModelRequest */
  private buildParams(request: ModelRequest): Record<string, unknown> {
    const params: Record<string, unknown> = {
      model: request.model ?? DEFAULT_MODEL,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    };

    if (request.messages && request.messages.length > 0) {
      const systemMsg = request.messages.find((m) => m.role === 'system');
      const nonSystemMsgs = request.messages.filter((m) => m.role !== 'system');

      if (systemMsg) {
        params.system = systemMsg.content;
      }

      params.messages = nonSystemMsgs.map((m) => {
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          const content: unknown[] = [];
          if (m.content) {
            content.push({ type: 'text', text: m.content });
          }
          for (const tc of m.toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            });
          }
          return { role: 'assistant', content };
        }

        if (m.role === 'tool') {
          return {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: m.toolCallId,
              content: m.content,
            }],
          };
        }

        return { role: m.role, content: m.content };
      });
    } else {
      params.messages = [{ role: 'user', content: request.prompt }];
    }

    if (request.systemPrompt && !params.system) {
      params.system = request.systemPrompt;
    }

    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }

    // Map responseFormat to Anthropic-native patterns
    if (request.responseFormat && request.responseFormat !== 'text') {
      if (request.responseFormat === 'json') {
        // JSON mode: append system prompt hint
        const existing = (params.system as string) ?? '';
        params.system = existing
          ? `${existing}\n\nRespond with valid JSON.`
          : 'Respond with valid JSON.';
      } else {
        // Schema mode: add synthetic __structured_output tool with forced tool_choice
        const soTool = {
          name: '__structured_output',
          description: 'Return structured output conforming to the schema',
          input_schema: request.responseFormat,
        };
        const existingTools = (params.tools as unknown[]) ?? [];
        params.tools = [...existingTools, soTool];
        params.tool_choice = { type: 'tool', name: '__structured_output' };
      }
    }

    return params;
  }

  /** Parse Anthropic response into ModelResponse */
  private parseResponse(response: Anthropic.Message, request: ModelRequest): ModelResponse {
    // SDK ContentBlock is a union type — use type narrowing via .type field
    const textBlock = response.content?.find(
      (block) => block.type === 'text',
    );
    let text = textBlock?.type === 'text' ? textBlock.text : '';

    let toolCalls: ToolCallRequest[] | undefined;
    const toolUseBlocks = response.content?.filter(
      (block) => block.type === 'tool_use',
    );

    // Extract __structured_output tool call as response text
    const soBlock = toolUseBlocks?.find((b) => b.type === 'tool_use' && b.name === '__structured_output');
    if (soBlock && soBlock.type === 'tool_use' && request.responseFormat && request.responseFormat !== 'text' && request.responseFormat !== 'json') {
      text = JSON.stringify(soBlock.input);
      // Filter out __structured_output from toolCalls
      const otherToolUseBlocks = toolUseBlocks!.filter((b) => b.type === 'tool_use' && b.name !== '__structured_output');
      if (otherToolUseBlocks.length > 0) {
        toolCalls = otherToolUseBlocks.map((block) => ({
          id: block.type === 'tool_use' ? block.id : '',
          name: block.type === 'tool_use' ? block.name : '',
          arguments: (block.type === 'tool_use' ? block.input : {}) as Record<string, unknown>,
        }));
      }
    } else if (toolUseBlocks && toolUseBlocks.length > 0) {
      toolCalls = toolUseBlocks.map((block) => ({
        id: block.type === 'tool_use' ? block.id : '',
        name: block.type === 'tool_use' ? block.name : '',
        arguments: (block.type === 'tool_use' ? block.input : {}) as Record<string, unknown>,
      }));
    }

    return {
      text,
      model: response.model ?? request.model ?? DEFAULT_MODEL,
      provider: 'anthropic',
      usage: {
        promptTokens: response.usage?.input_tokens ?? 0,
        completionTokens: response.usage?.output_tokens ?? 0,
      },
      toolCalls,
    };
  }
}
