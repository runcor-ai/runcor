// Contract tests for provider-specific responseFormat mapping
// Verifies each provider transforms responseFormat into its native API format

import { describe, it, expect, vi } from 'vitest';
import type { ModelRequest } from '../../src/model/provider.js';

// ── T031: OpenAI Provider Mapping ──

describe('OpenAI Provider: responseFormat mapping', () => {
  it('should map schema mode to json_schema response_format', async () => {
    // Mock OpenAI SDK
    const capturedParams: any[] = [];
    const mockClient = {
      chat: {
        completions: {
          create: vi.fn(async (params: any) => {
            capturedParams.push(params);
            return {
              choices: [{ message: { content: '{}' } }],
              model: 'gpt-4o',
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            };
          }),
        },
      },
    };

    const { OpenAIProvider } = await import('../../src/model/openai.js');
    const provider = new OpenAIProvider(mockClient as any);

    await provider.complete({
      prompt: 'test',
      responseFormat: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    });

    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'response',
        strict: true,
        schema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
    });
  });

  it('should map json mode to json_object response_format', async () => {
    const capturedParams: any[] = [];
    const mockClient = {
      chat: {
        completions: {
          create: vi.fn(async (params: any) => {
            capturedParams.push(params);
            return {
              choices: [{ message: { content: '{}' } }],
              model: 'gpt-4o',
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            };
          }),
        },
      },
    };

    const { OpenAIProvider } = await import('../../src/model/openai.js');
    const provider = new OpenAIProvider(mockClient as any);

    await provider.complete({
      prompt: 'test',
      responseFormat: 'json',
    });

    expect(capturedParams[0].response_format).toEqual({ type: 'json_object' });
  });

  it('should not set response_format for text mode', async () => {
    const capturedParams: any[] = [];
    const mockClient = {
      chat: {
        completions: {
          create: vi.fn(async (params: any) => {
            capturedParams.push(params);
            return {
              choices: [{ message: { content: 'hello' } }],
              model: 'gpt-4o',
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            };
          }),
        },
      },
    };

    const { OpenAIProvider } = await import('../../src/model/openai.js');
    const provider = new OpenAIProvider(mockClient as any);

    await provider.complete({
      prompt: 'test',
      responseFormat: 'text',
    });

    expect(capturedParams[0].response_format).toBeUndefined();
  });
});

// ── T032: Anthropic Provider Mapping ──

describe('Anthropic Provider: responseFormat mapping', () => {
  it('should add __structured_output tool and tool_choice for schema mode', async () => {
    const capturedParams: any[] = [];
    const mockClient = {
      messages: {
        create: vi.fn(async (params: any) => {
          capturedParams.push(params);
          return {
            content: [{ type: 'tool_use', id: 'tc-1', name: '__structured_output', input: { name: 'John' } }],
            model: 'claude-sonnet-4-5-20250514',
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        }),
      },
    };

    const { AnthropicProvider } = await import('../../src/model/anthropic.js');
    const provider = new AnthropicProvider(mockClient as any);

    const response = await provider.complete({
      prompt: 'test',
      responseFormat: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    });

    const params = capturedParams[0];
    // Should have __structured_output tool
    const soTool = params.tools?.find((t: any) => t.name === '__structured_output');
    expect(soTool).toBeDefined();
    expect(soTool.input_schema).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    // Should have forced tool_choice
    expect(params.tool_choice).toEqual({ type: 'tool', name: '__structured_output' });
    // Response text should be the tool call arguments as JSON
    expect(response.text).toBe('{"name":"John"}');
  });

  it('should append system prompt hint for json mode', async () => {
    const capturedParams: any[] = [];
    const mockClient = {
      messages: {
        create: vi.fn(async (params: any) => {
          capturedParams.push(params);
          return {
            content: [{ type: 'text', text: '{}' }],
            model: 'claude-sonnet-4-5-20250514',
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        }),
      },
    };

    const { AnthropicProvider } = await import('../../src/model/anthropic.js');
    const provider = new AnthropicProvider(mockClient as any);

    await provider.complete({
      prompt: 'test',
      responseFormat: 'json',
    });

    // Should have system prompt with JSON hint
    expect(capturedParams[0].system).toContain('Respond with valid JSON');
  });

  it('should not modify request for text mode', async () => {
    const capturedParams: any[] = [];
    const mockClient = {
      messages: {
        create: vi.fn(async (params: any) => {
          capturedParams.push(params);
          return {
            content: [{ type: 'text', text: 'hello' }],
            model: 'claude-sonnet-4-5-20250514',
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        }),
      },
    };

    const { AnthropicProvider } = await import('../../src/model/anthropic.js');
    const provider = new AnthropicProvider(mockClient as any);

    await provider.complete({
      prompt: 'test',
      responseFormat: 'text',
    });

    expect(capturedParams[0].tool_choice).toBeUndefined();
    // Should not have __structured_output tool
    const soTool = capturedParams[0].tools?.find((t: any) => t.name === '__structured_output');
    expect(soTool).toBeUndefined();
  });
});

// ── T033: Google Provider Mapping ──

describe('Google Provider: responseFormat mapping', () => {
  it('should set responseMimeType and responseSchema for schema mode', async () => {
    const capturedConfig: any[] = [];
    const mockModel = {
      generateContent: vi.fn(async () => ({
        response: {
          candidates: [{ content: { parts: [{ text: '{"name":"John"}' }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      })),
    };
    const mockAI = {
      getGenerativeModel: vi.fn((config: any) => {
        capturedConfig.push(config);
        return mockModel;
      }),
    };

    const { GoogleProvider } = await import('../../src/model/google.js');
    const provider = new GoogleProvider(mockAI as any);

    await provider.complete({
      prompt: 'test',
      responseFormat: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    });

    const genConfig = capturedConfig[0].generationConfig;
    expect(genConfig.responseMimeType).toBe('application/json');
    expect(genConfig.responseSchema).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
  });

  it('should set responseMimeType for json mode', async () => {
    const capturedConfig: any[] = [];
    const mockModel = {
      generateContent: vi.fn(async () => ({
        response: {
          candidates: [{ content: { parts: [{ text: '{}' }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      })),
    };
    const mockAI = {
      getGenerativeModel: vi.fn((config: any) => {
        capturedConfig.push(config);
        return mockModel;
      }),
    };

    const { GoogleProvider } = await import('../../src/model/google.js');
    const provider = new GoogleProvider(mockAI as any);

    await provider.complete({
      prompt: 'test',
      responseFormat: 'json',
    });

    const genConfig = capturedConfig[0].generationConfig;
    expect(genConfig.responseMimeType).toBe('application/json');
    expect(genConfig.responseSchema).toBeUndefined();
  });

  it('should not set responseMimeType for text mode', async () => {
    const capturedConfig: any[] = [];
    const mockModel = {
      generateContent: vi.fn(async () => ({
        response: {
          candidates: [{ content: { parts: [{ text: 'hello' }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      })),
    };
    const mockAI = {
      getGenerativeModel: vi.fn((config: any) => {
        capturedConfig.push(config);
        return mockModel;
      }),
    };

    const { GoogleProvider } = await import('../../src/model/google.js');
    const provider = new GoogleProvider(mockAI as any);

    await provider.complete({
      prompt: 'test',
      responseFormat: 'text',
    });

    const genConfig = capturedConfig[0].generationConfig;
    expect(genConfig.responseMimeType).toBeUndefined();
    expect(genConfig.responseSchema).toBeUndefined();
  });
});
