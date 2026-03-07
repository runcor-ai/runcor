// Unit tests for GoogleProvider (mocked SDK)
import { describe, it, expect, vi } from 'vitest';
import { GoogleProvider } from '../../../src/model/google.js';

function createMockAI() {
  const generateContent = vi.fn().mockResolvedValue({
    response: {
      candidates: [{
        content: {
          parts: [{ text: 'Hello from Gemini' }],
        },
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
      },
    },
  });

  return {
    getGenerativeModel: vi.fn().mockReturnValue({ generateContent }),
    _generateContent: generateContent,
  };
}

describe('GoogleProvider', () => {
  it('should have name "google/gemini-2.0-flash" by default', () => {
    const ai = createMockAI();
    const provider = new GoogleProvider(ai as any);
    expect(provider.name).toBe('google/gemini-2.0-flash');
  });

  it('should accept custom name and defaultModel', () => {
    const ai = createMockAI();
    const provider = new GoogleProvider(ai as any, { name: 'my-gemini', defaultModel: 'gemini-2.5-pro' });
    expect(provider.name).toBe('my-gemini');
  });

  it('should map ModelRequest to SDK generateContent() call', async () => {
    const ai = createMockAI();
    const provider = new GoogleProvider(ai as any);

    await provider.complete({
      prompt: 'Hello',
      model: 'gemini-2.0-flash',
      maxTokens: 200,
    });

    expect(ai.getGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.0-flash',
        generationConfig: expect.objectContaining({
          maxOutputTokens: 200,
        }),
      }),
    );

    expect(ai._generateContent).toHaveBeenCalledWith({
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    });
  });

  it('should use default model when not specified', async () => {
    const ai = createMockAI();
    const provider = new GoogleProvider(ai as any);

    await provider.complete({ prompt: 'Hello' });

    expect(ai.getGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.0-flash',
      }),
    );
  });

  it('should use default maxOutputTokens when not specified', async () => {
    const ai = createMockAI();
    const provider = new GoogleProvider(ai as any);

    await provider.complete({ prompt: 'Hello' });

    expect(ai.getGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        generationConfig: expect.objectContaining({
          maxOutputTokens: 1024,
        }),
      }),
    );
  });

  it('should map Google response to ModelResponse', async () => {
    const ai = createMockAI();
    const provider = new GoogleProvider(ai as any);

    const response = await provider.complete({ prompt: 'Hello' });

    expect(response.text).toBe('Hello from Gemini');
    expect(response.model).toBe('gemini-2.0-flash');
    expect(response.provider).toBe('google');
    expect(response.usage.promptTokens).toBe(10);
    expect(response.usage.completionTokens).toBe(20);
  });

  it('should classify generic errors as EngineError with PROVIDER_ERROR', async () => {
    const ai = createMockAI();
    ai._generateContent.mockRejectedValue(new Error('Quota exceeded'));
    const provider = new GoogleProvider(ai as any);

    try {
      await provider.complete({ prompt: 'Hello' });
    } catch (err: any) {
      expect(err.name).toBe('EngineError');
      expect(err.code).toBe('PROVIDER_ERROR');
      expect(err.message).toContain('Quota exceeded');
    }
  });

  it('should classify server errors as RetryableError', async () => {
    const ai = createMockAI();
    const serverErr = Object.assign(new Error('Internal server error'), { status: 500 });
    ai._generateContent.mockRejectedValue(serverErr);
    const provider = new GoogleProvider(ai as any);

    try {
      await provider.complete({ prompt: 'Hello' });
    } catch (err: any) {
      expect(err.name).toBe('RetryableError');
    }
  });

  it('should include temperature when provided', async () => {
    const ai = createMockAI();
    const provider = new GoogleProvider(ai as any);

    await provider.complete({ prompt: 'Hello', temperature: 0.7 });

    expect(ai.getGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        generationConfig: expect.objectContaining({
          temperature: 0.7,
        }),
      }),
    );
  });
});
