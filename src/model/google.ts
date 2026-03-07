// GoogleProvider implementation
// Mirrors AnthropicProvider pattern with Google Gemini API translation

import type { GenerativeModel, GoogleGenerativeAI } from '@google/generative-ai';
import type { ModelProvider, ModelRequest, ModelResponse } from './provider.js';
import type { ToolCallRequest } from '../agent/types.js';
import { classifyProviderError } from './provider-errors.js';

const DEFAULT_MODEL = 'gemini-2.0-flash';
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/** Google Gemini model provider using the official SDK */
export class GoogleProvider implements ModelProvider {
  readonly name: string;
  private readonly ai: GoogleGenerativeAI;
  private readonly defaultModel: string;

  constructor(ai: GoogleGenerativeAI, options?: { name?: string; defaultModel?: string }) {
    this.ai = ai;
    this.defaultModel = options?.defaultModel ?? DEFAULT_MODEL;
    this.name = options?.name ?? `google/${this.defaultModel}`;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    try {
      // Build model config
      const modelConfig: Record<string, unknown> = {
        model: request.model ?? this.defaultModel,
      };

      const generationConfig: Record<string, unknown> = {
        maxOutputTokens: request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      };

      if (request.temperature !== undefined) {
        generationConfig.temperature = request.temperature;
      }

      // Map responseFormat to Gemini generationConfig
      if (request.responseFormat && request.responseFormat !== 'text') {
        generationConfig.responseMimeType = 'application/json';
        if (request.responseFormat !== 'json') {
          generationConfig.responseSchema = request.responseFormat;
        }
      }

      // Extract system instruction
      let systemInstruction: string | undefined;
      if (request.messages && request.messages.length > 0) {
        const systemMsg = request.messages.find((m) => m.role === 'system');
        if (systemMsg) {
          systemInstruction = systemMsg.content;
        }
      }
      if (request.systemPrompt && !systemInstruction) {
        systemInstruction = request.systemPrompt;
      }
      if (systemInstruction) {
        modelConfig.systemInstruction = systemInstruction;
      }

      modelConfig.generationConfig = generationConfig;

      // Translate tools to Gemini format
      if (request.tools && request.tools.length > 0) {
        modelConfig.tools = [{
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        }];
      }

      // SDK types incompatible — getGenerativeModel accepts broader config than declared types
      const model: GenerativeModel = (this.ai as unknown as { getGenerativeModel(c: Record<string, unknown>): GenerativeModel }).getGenerativeModel(modelConfig);

      // Build contents array
      let contents: unknown[];
      if (request.messages && request.messages.length > 0) {
        const nonSystemMsgs = request.messages.filter((m) => m.role !== 'system');
        contents = nonSystemMsgs.map((m) => {
          // Gemini uses 'model' instead of 'assistant'
          const role = m.role === 'assistant' ? 'model' : 'user';

          if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
            // Assistant with tool calls → functionCall parts
            const parts: unknown[] = [];
            if (m.content) {
              parts.push({ text: m.content });
            }
            for (const tc of m.toolCalls) {
              parts.push({
                functionCall: { name: tc.name, args: tc.arguments },
              });
            }
            return { role: 'model', parts };
          }

          if (m.role === 'tool') {
            // Tool results → user message with functionResponse part
            return {
              role: 'user',
              parts: [{
                functionResponse: {
                  name: m.toolName ?? 'unknown',
                  response: { content: m.content },
                },
              }],
            };
          }

          // Regular user/assistant message
          return { role, parts: [{ text: m.content }] };
        });
      } else {
        contents = [{ role: 'user', parts: [{ text: request.prompt }] }];
      }

      // SDK types incompatible — contents array shape varies between SDK versions
      const response = await model.generateContent({ contents } as Parameters<GenerativeModel['generateContent']>[0]);

      const result = ('response' in response ? (response as unknown as Record<string, unknown>).response : response) as Record<string, unknown>;
      const candidates = result.candidates as Array<{ content?: { parts?: Array<Record<string, unknown>> } }> | undefined;
      const candidate = candidates?.[0];
      const parts = candidate?.content?.parts ?? [];

      // Extract text from parts
      const textParts = parts.filter((p: Record<string, unknown>) => p.text);
      const text = textParts.map((p: Record<string, unknown>) => p.text as string).join('');

      // Extract tool calls (Gemini doesn't provide IDs, generate synthetic ones)
      let toolCalls: ToolCallRequest[] | undefined;
      const functionCallParts = parts.filter((p: Record<string, unknown>) => p.functionCall);
      if (functionCallParts.length > 0) {
        toolCalls = functionCallParts.map((p: Record<string, unknown>, i: number) => {
          const fc = p.functionCall as Record<string, unknown>;
          return {
            id: `call_${i}`,
            name: fc.name as string,
            arguments: fc.args as Record<string, unknown>,
          };
        });
      }

      const usageMeta = result.usageMetadata as Record<string, number> | undefined;

      return {
        text,
        model: request.model ?? this.defaultModel,
        provider: 'google',
        usage: {
          promptTokens: usageMeta?.promptTokenCount ?? 0,
          completionTokens: usageMeta?.candidatesTokenCount ?? 0,
        },
        toolCalls,
      };
    } catch (err: unknown) {
      classifyProviderError('Google', err);
    }
  }
}
