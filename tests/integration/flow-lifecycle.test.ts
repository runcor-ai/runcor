// Integration tests for full flow lifecycle and model interface
import { describe, it, expect, vi } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import type { ModelProvider } from '../../src/model/provider.js';

function createMockProvider(): ModelProvider {
  return {
    name: 'mock',
    complete: vi.fn().mockResolvedValue({
      text: 'mock response',
      model: 'mock',
      provider: 'mock',
      usage: { promptTokens: 10, completionTokens: 10 },
    }),
  };
}

describe('Flow Lifecycle Integration', () => {
  it('should complete full lifecycle: register → trigger → queued → running → complete → getExecution', async () => {
    const engine = await createEngine({
      model: { provider: createMockProvider() },
    });

    const stateChanges: Array<{ from: string; to: string }> = [];
    engine.on('execution:state_change', (event) => {
      stateChanges.push({ from: event.from, to: event.to });
    });

    const completionPromise = new Promise<any>((resolve) => {
      engine.on('execution:complete', resolve);
    });

    engine.register('greeting', async (ctx) => {
      return `Hello, ${ctx.input}!`;
    });

    const exec = await engine.trigger('greeting', {
      idempotencyKey: 'greet-1',
      input: 'World',
    });

    expect(exec.flowName).toBe('greeting');
    expect(exec.idempotencyKey).toBe('greet-1');

    const completionEvent = await completionPromise;
    expect(completionEvent.state).toBe('complete');
    expect(completionEvent.result).toBe('Hello, World!');

    // Verify state transitions
    expect(stateChanges).toContainEqual({ from: 'queued', to: 'running' });
    expect(stateChanges).toContainEqual({ from: 'running', to: 'complete' });

    // Verify getExecution returns the final result
    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    expect(final!.result).toBe('Hello, World!');
    expect(final!.timestamps.started).not.toBeNull();
    expect(final!.timestamps.completed).not.toBeNull();

    await engine.shutdown();
  });

  it('should emit state_change events with correct payload', async () => {
    const engine = await createEngine({
      model: { provider: createMockProvider() },
    });

    const events: any[] = [];
    engine.on('execution:state_change', (event) => {
      events.push(event);
    });

    engine.register('test', async () => 42);
    const exec = await engine.trigger('test', { idempotencyKey: 'key-1' });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', () => resolve());
    });

    for (const event of events) {
      expect(event.executionId).toBe(exec.id);
      expect(event.timestamp).toBeInstanceOf(Date);
      expect(typeof event.from).toBe('string');
      expect(typeof event.to).toBe('string');
    }

    await engine.shutdown();
  });

  it('should handle execution:complete event for failed executions', async () => {
    const engine = await createEngine({
      model: { provider: createMockProvider() },
    });

    engine.register('fail', async () => {
      throw new Error('intentional failure');
    }, { maxRetries: 0 });

    const completionPromise = new Promise<any>((resolve) => {
      engine.on('execution:complete', resolve);
    });

    const exec = await engine.trigger('fail', { idempotencyKey: 'fail-1' });
    const event = await completionPromise;

    expect(event.state).toBe('failed');
    expect(event.error).toBeDefined();
    expect(event.executionId).toBe(exec.id);

    await engine.shutdown();
  });
});

// Integration test for model interface
describe('Model Interface Integration', () => {
  it('should allow flow to call ctx.model.complete() with MockProvider', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    engine.register('model-flow', async (ctx) => {
      const response = await ctx.model.complete({ prompt: 'Hello AI' });
      return response.text;
    });

    const exec = await engine.trigger('model-flow', {
      idempotencyKey: 'model-1',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', () => resolve());
    });

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    expect(final!.result).toBe('Mock response to: Hello AI');

    await engine.shutdown();
  });

  it('should work with mocked AnthropicProvider (SC-003: byte-identical flow code)', async () => {
    // Same flow source code works with any provider — proving SC-003
    const flowHandler = async (ctx: any) => {
      const response = await ctx.model.complete({ prompt: 'Summarize' });
      return response.text;
    };

    // Test with MockProvider
    const engine1 = await createEngine({
      model: { provider: new MockProvider() },
    });
    engine1.register('universal-flow', flowHandler);
    const exec1 = await engine1.trigger('universal-flow', { idempotencyKey: 'k1' });
    await new Promise<void>((resolve) => engine1.on('execution:complete', () => resolve()));
    const r1 = await engine1.getExecution(exec1.id);
    expect(r1!.state).toBe('complete');
    await engine1.shutdown();

    // Test with a mock that mimics Anthropic response shape
    const fakeAnthropic: ModelProvider = {
      name: 'anthropic',
      complete: vi.fn().mockResolvedValue({
        text: 'Anthropic response',
        model: 'claude-sonnet-4-5-20250514',
        provider: 'anthropic',
        usage: { promptTokens: 9, completionTokens: 18 },
      }),
    };

    const engine2 = await createEngine({
      model: { provider: fakeAnthropic },
    });
    engine2.register('universal-flow', flowHandler);
    const exec2 = await engine2.trigger('universal-flow', { idempotencyKey: 'k2' });
    await new Promise<void>((resolve) => engine2.on('execution:complete', () => resolve()));
    const r2 = await engine2.getExecution(exec2.id);
    expect(r2!.state).toBe('complete');
    expect(r2!.result).toBe('Anthropic response');
    await engine2.shutdown();
  });
});
