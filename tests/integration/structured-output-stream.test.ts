// Integration tests for streaming + validation
// Tests stream with schema: validation on .response promise, parsed field available
// Stream with invalid JSON: ValidationError thrown from .response promise (no retry)
// Stream with text mode: unchanged behavior

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, Runcor } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import { ValidationError } from '../../src/errors.js';
import type { ModelProvider, ModelRequest, ModelResponse, ModelStream, StreamEvent } from '../../src/model/provider.js';

// ── Helpers ──

async function waitForCompletion(engine: Runcor, executionId: string, timeout = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for completion')), timeout);
    const check = async () => {
      const exec = await engine.getExecution(executionId);
      if (exec && (exec.state === 'complete' || exec.state === 'failed')) {
        clearTimeout(timer);
        resolve();
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });
}

const userSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number' },
  },
  required: ['name', 'age'],
};

describe('Streaming + Validation ', () => {
  let engine: Runcor;

  afterEach(async () => {
    if (engine) await engine.shutdown();
  });

  it('should set parsed on stream .response when schema validates', async () => {
    const provider = new MockProvider();
    provider.queueResponses([{ text: '{"name":"John","age":30}' }]);

    engine = await createEngine({
      model: { providers: [{ provider, priority: 1 }] },
    });

    let streamedParsed: unknown;
    let streamedText = '';
    engine.register('test', async (ctx) => {
      const stream = ctx.model.stream({
        prompt: 'Extract user info',
        responseFormat: userSchema,
      });

      // Consume the stream
      for await (const event of stream) {
        if (event.type === 'text_delta') {
          streamedText += event.text;
        }
      }

      // Get the final response
      const response = await stream.response;
      streamedParsed = response.parsed;
      return response.parsed;
    });

    const exec = await engine.trigger('test', { idempotencyKey: 's1', input: 'test' });
    await waitForCompletion(engine, exec.id);

    expect(streamedText).toBe('{"name":"John","age":30}');
    expect(streamedParsed).toEqual({ name: 'John', age: 30 });
  });

  it('should throw ValidationError from stream .response when JSON is invalid (no retry)', async () => {
    const provider = new MockProvider();
    provider.queueResponses([{ text: 'not valid json' }]);

    engine = await createEngine({
      model: { providers: [{ provider, priority: 1 }] },
    });

    let caughtError: unknown;
    engine.register('test', async (ctx) => {
      const stream = ctx.model.stream({
        prompt: 'Extract user info',
        responseFormat: userSchema,
      });

      // Consume the stream
      for await (const event of stream) {
        // consume
      }

      try {
        await stream.response;
      } catch (err) {
        caughtError = err;
        throw err;
      }
    });

    const exec = await engine.trigger('test', { idempotencyKey: 's2', input: 'test' });
    await waitForCompletion(engine, exec.id);
    expect(caughtError).toBeInstanceOf(ValidationError);
  });

  it('should not set parsed when stream uses text mode', async () => {
    const provider = new MockProvider('Stream text: {prompt}');

    engine = await createEngine({
      model: { providers: [{ provider, priority: 1 }] },
    });

    let hasParsedKey: boolean | undefined;
    engine.register('test', async (ctx) => {
      const stream = ctx.model.stream({
        prompt: 'Hello world',
        responseFormat: 'text',
      });

      for await (const event of stream) {
        // consume
      }

      const response = await stream.response;
      hasParsedKey = 'parsed' in response;
      return response.text;
    });

    const exec = await engine.trigger('test', { idempotencyKey: 's3', input: 'test' });
    await waitForCompletion(engine, exec.id);
    expect(hasParsedKey).toBe(false);
  });

  it('should not set parsed when stream has no responseFormat', async () => {
    const provider = new MockProvider('Response: {prompt}');

    engine = await createEngine({
      model: { providers: [{ provider, priority: 1 }] },
    });

    let hasParsedKey: boolean | undefined;
    engine.register('test', async (ctx) => {
      const stream = ctx.model.stream({
        prompt: 'Hello world',
      });

      for await (const event of stream) {
        // consume
      }

      const response = await stream.response;
      hasParsedKey = 'parsed' in response;
      return response.text;
    });

    const exec = await engine.trigger('test', { idempotencyKey: 's4', input: 'test' });
    await waitForCompletion(engine, exec.id);
    expect(hasParsedKey).toBe(false);
  });
});
