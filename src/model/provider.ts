// ModelProvider interface, ModelRequest, ModelResponse

import type { RoutingStrategy, ResponseFormat } from '../types.js';
import type { ConversationMessage, ToolDefinition, ToolCallRequest } from '../agent/types.js';

// ── Streaming Types ──

/** A streaming event emitted during model response generation */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; toolCall: ToolCallRequest };

/** Wrapper around an async-iterable stream of events with a final response promise */
export interface ModelStream {
  /** Async iteration over stream events (text deltas and tool calls) */
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent>;
  /** Resolves to the final aggregated ModelResponse after the stream is fully consumed */
  response: Promise<ModelResponse>;
}

// ── End Streaming Types ──

/** Request sent to a model provider */
export interface ModelRequest {
  /** The text prompt to send. Optional when messages is provided. */
  prompt?: string;
  /** Optional model identifier (e.g., "claude-sonnet-4-5-20250514") */
  model?: string;
  /** Optional max response tokens */
  maxTokens?: number;
  /** Optional temperature (0-1) */
  temperature?: number;
  /** Pin to specific provider by name (routing override) */
  provider?: string;
  /** Override routing strategy for this request */
  strategy?: RoutingStrategy;

  // Agent support fields
  /** Multi-turn conversation history. Takes precedence over prompt if both provided. */
  messages?: ConversationMessage[];
  /** Available tool definitions for the model */
  tools?: ToolDefinition[];
  /** System-level instruction (separate from conversation messages) */
  systemPrompt?: string;

  // Structured output
  /** Response format hint. 'text' (default) = no validation. 'json' = valid JSON required.
   *  JSON Schema object = validated against schema. */
  responseFormat?: ResponseFormat;
}

/** Response from a model provider */
export interface ModelResponse {
  /** The completion text */
  text: string;
  /** Model that generated the response */
  model: string;
  /** Provider that handled the request */
  provider: string;
  /** Token usage */
  usage: {
    promptTokens: number;
    completionTokens: number;
  };

  // Agent support fields
  /** Tool calls requested by the model. Present when model requests tool use. */
  toolCalls?: ToolCallRequest[];

  // Structured output
  /** Deserialized JSON value when responseFormat is 'json' or a schema.
   *  Not present when responseFormat is 'text' or omitted. */
  parsed?: unknown;
}

/**
 * Create a ModelStream that wraps a ModelResponse as a single text_delta event.
 * Used as a fallback when a provider doesn't support native streaming.
 * The `.response` resolves immediately since the full response is already known.
 */
export function createFallbackStream(response: ModelResponse): ModelStream {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
      if (response.text) {
        yield { type: 'text_delta', text: response.text };
      }
      if (response.toolCalls) {
        for (const toolCall of response.toolCalls) {
          yield { type: 'tool_call', toolCall };
        }
      }
    },
    response: Promise.resolve(response),
  };
}

/** Pluggable adapter interface for LLM providers */
export interface ModelProvider {
  /** Provider identifier (e.g., "anthropic", "mock") */
  readonly name: string;
  /** Send prompt, receive completion */
  complete(request: ModelRequest): Promise<ModelResponse>;
  /** Stream a response as async-iterable events. Optional — router provides fallback via complete(). */
  stream?(request: ModelRequest): ModelStream;
}
