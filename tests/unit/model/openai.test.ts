// Unit tests for OpenAIProvider (mocked SDK)
import { describe, it, expect, vi } from 'vitest';
import { OpenAIProvider } from '../../../src/model/openai.js';

function createMockClient() {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{
            message: {
              content: 'Hello from GPT',
              tool_calls: null,
            },
          }],
          model: 'gpt-4o',
          usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
          },
        }),
      },
    },
  };
}

describe('OpenAIProvider', () => {
  it('should have name "openai/gpt-4o" by default', () => {
    const client = createMockClient();
    const provider = new OpenAIProvider(client as any);
    expect(provider.name).toBe('openai/gpt-4o');
  });

  it('should accept custom name and defaultModel', () => {
    const client = createMockClient();
    const provider = new OpenAIProvider(client as any, { name: 'my-openai', defaultModel: 'gpt-4o-mini' });
    expect(provider.name).toBe('my-openai');
  });

  it('should map ModelRequest to SDK chat.completions.create() call', async () => {
    const client = createMockClient();
    const provider = new OpenAIProvider(client as any);

    await provider.complete({
      prompt: 'Hello',
      model: 'gpt-4o',
      maxTokens: 200,
    });

    expect(client.chat.completions.create).toHaveBeenCalledWith({
      model: 'gpt-4o',
      max_tokens: 200,
      messages: [{ role: 'user', content: 'Hello' }],
    });
  });

  it('should use default model when not specified', async () => {
    const client = createMockClient();
    const provider = new OpenAIProvider(client as any);

    await provider.complete({ prompt: 'Hello' });

    expect(client.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o',
      }),
    );
  });

  it('should use default maxTokens when not specified', async () => {
    const client = createMockClient();
    const provider = new OpenAIProvider(client as any);

    await provider.complete({ prompt: 'Hello' });

    expect(client.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 1024,
      }),
    );
  });

  it('should map OpenAI response to ModelResponse', async () => {
    const client = createMockClient();
    const provider = new OpenAIProvider(client as any);

    const response = await provider.complete({ prompt: 'Hello' });

    expect(response.text).toBe('Hello from GPT');
    expect(response.model).toBe('gpt-4o');
    expect(response.provider).toBe('openai');
    expect(response.usage.promptTokens).toBe(10);
    expect(response.usage.completionTokens).toBe(20);
  });

  it('should classify rate limit errors as RetryableError', async () => {
    const client = createMockClient();
    client.chat.completions.create.mockRejectedValue(new Error('API rate limited'));
    const provider = new OpenAIProvider(client as any);

    await expect(provider.complete({ prompt: 'Hello' })).rejects.toThrow('OpenAI rate limited');
    try {
      await provider.complete({ prompt: 'Hello' });
    } catch (err: any) {
      expect(err.name).toBe('RetryableError');
    }
  });

  it('should classify auth errors as EngineError with PROVIDER_AUTH_ERROR', async () => {
    const client = createMockClient();
    const authErr = Object.assign(new Error('Invalid API key'), { status: 401 });
    client.chat.completions.create.mockRejectedValue(authErr);
    const provider = new OpenAIProvider(client as any);

    try {
      await provider.complete({ prompt: 'Hello' });
    } catch (err: any) {
      expect(err.name).toBe('EngineError');
      expect(err.code).toBe('PROVIDER_AUTH_ERROR');
    }
  });

  it('should classify unknown errors as EngineError with PROVIDER_ERROR', async () => {
    const client = createMockClient();
    client.chat.completions.create.mockRejectedValue(new Error('Something unexpected'));
    const provider = new OpenAIProvider(client as any);

    try {
      await provider.complete({ prompt: 'Hello' });
    } catch (err: any) {
      expect(err.name).toBe('EngineError');
      expect(err.code).toBe('PROVIDER_ERROR');
    }
  });

  it('should include temperature when provided', async () => {
    const client = createMockClient();
    const provider = new OpenAIProvider(client as any);

    await provider.complete({ prompt: 'Hello', temperature: 0.7 });

    expect(client.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.7,
      }),
    );
  });
});
