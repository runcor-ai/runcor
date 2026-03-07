// MockProvider implementation — extended for agent + structured output support
// Deterministic, echoes configurable template, reports string-length usage
// Returns schema-conformant mock data when responseFormat is provided

import type { ModelProvider, ModelRequest, ModelResponse, ModelStream, StreamEvent } from './provider.js';
import type { ToolCallRequest } from '../agent/types.js';
import type { JsonSchema } from '../types.js';

/** Mock model provider for testing. Returns deterministic responses. */
export class MockProvider implements ModelProvider {
  readonly name = 'mock';
  private readonly template: string;
  private pendingToolCalls: ToolCallRequest[] | undefined;
  private responseQueue: Array<{ text?: string; toolCalls?: ToolCallRequest[] }> = [];

  /** When set, stream() splits text into chunks of this size (default: entire text as one chunk) */
  chunkSize?: number;

  constructor(template: string = 'Mock response to: {prompt}') {
    this.template = template;
  }

  /** Queue tool call responses for the next complete() call */
  setToolCallResponses(toolCalls: ToolCallRequest[]): void {
    this.pendingToolCalls = toolCalls;
  }

  /** Queue a sequence of responses (text and/or tool calls) for successive complete() calls */
  queueResponses(responses: Array<{ text?: string; toolCalls?: ToolCallRequest[] }>): void {
    this.responseQueue.push(...responses);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    // Check response queue first
    if (this.responseQueue.length > 0) {
      const queued = this.responseQueue.shift()!;
      const text = queued.text ?? '';
      const promptContent = this.getPromptContent(request);
      return {
        text,
        model: 'mock',
        provider: 'mock',
        usage: {
          promptTokens: promptContent.length,
          completionTokens: text.length,
        },
        toolCalls: queued.toolCalls,
      };
    }

    // Check for pending tool calls (one-shot)
    if (this.pendingToolCalls) {
      const toolCalls = this.pendingToolCalls;
      this.pendingToolCalls = undefined;
      const promptContent = this.getPromptContent(request);
      return {
        text: '',
        model: 'mock',
        provider: 'mock',
        usage: {
          promptTokens: promptContent.length,
          completionTokens: 0,
        },
        toolCalls,
      };
    }

    // Structured output — generate conformant mock data
    const responseFormat = request.responseFormat;
    if (responseFormat && responseFormat !== 'text') {
      const promptContent = this.getPromptContent(request);
      const text = responseFormat === 'json'
        ? '{}'
        : JSON.stringify(generateConformantData(responseFormat));
      return {
        text,
        model: 'mock',
        provider: 'mock',
        usage: {
          promptTokens: promptContent.length,
          completionTokens: text.length,
        },
      };
    }

    // Default behavior: template-based response
    const promptContent = this.getPromptContent(request);
    const text = this.template.replace('{prompt}', promptContent);

    return {
      text,
      model: 'mock',
      provider: 'mock',
      usage: {
        promptTokens: promptContent.length,
        completionTokens: text.length,
      },
    };
  }

  /** Stream a response as async-iterable events. Splits text into chunks of `chunkSize` characters when set. */
  stream(request: ModelRequest): ModelStream {
    // Build the response the same way complete() does (synchronously)
    let text: string;
    let toolCalls: ToolCallRequest[] | undefined;
    const promptContent = this.getPromptContent(request);

    if (this.responseQueue.length > 0) {
      const queued = this.responseQueue.shift()!;
      text = queued.text ?? '';
      toolCalls = queued.toolCalls;
    } else if (this.pendingToolCalls) {
      text = '';
      toolCalls = this.pendingToolCalls;
      this.pendingToolCalls = undefined;
    } else {
      text = this.template.replace('{prompt}', promptContent);
    }

    const response: ModelResponse = {
      text,
      model: 'mock',
      provider: 'mock',
      usage: {
        promptTokens: promptContent.length,
        completionTokens: text.length,
      },
      toolCalls,
    };

    const chunkSize = this.chunkSize;

    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
        if (text) {
          if (chunkSize && chunkSize > 0) {
            for (let i = 0; i < text.length; i += chunkSize) {
              yield { type: 'text_delta', text: text.slice(i, i + chunkSize) };
            }
          } else {
            yield { type: 'text_delta', text };
          }
        }
        if (toolCalls) {
          for (const tc of toolCalls) {
            yield { type: 'tool_call', toolCall: tc };
          }
        }
      },
      response: Promise.resolve(response),
    };
  }

  /** Extract prompt content from request, preferring messages over prompt */
  private getPromptContent(request: ModelRequest): string {
    if (request.messages && request.messages.length > 0) {
      return request.messages.map((m) => m.content).join('\n');
    }
    return request.prompt ?? '';
  }
}

/** Generate schema-conformant default data by walking JSON Schema properties */
function generateConformantData(schema: JsonSchema): unknown {
  // Handle const
  if ('const' in schema) return schema.const;

  // Handle enum — return first value
  if ('enum' in schema && Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  const type = schema.type as string | undefined;

  switch (type) {
    case 'string': return '';
    case 'number': return 0;
    case 'integer': return 0;
    case 'boolean': return false;
    case 'null': return null;
    case 'array': return [];
    case 'object': {
      const result: Record<string, unknown> = {};
      const properties = schema.properties as Record<string, JsonSchema> | undefined;
      if (properties) {
        for (const [key, propSchema] of Object.entries(properties)) {
          result[key] = generateConformantData(propSchema);
        }
      }
      return result;
    }
    default:
      return {};
  }
}
