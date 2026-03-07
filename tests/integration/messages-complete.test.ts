// Integration tests for messages-based complete() with all subsystems
// Feature 015, US4: Transparent Subsystem Compatibility

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, Runcor } from '../../src/engine.js';
import type { ModelProvider, ModelRequest, ModelResponse } from '../../src/model/provider.js';
import type { CostRequestEvent } from '../../src/types.js';

// ── Helpers ──

function createMessagesProvider(name: string): ModelProvider {
  return {
    name,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const promptLen = request.messages
        ? request.messages.map(m => m.content).join('').length
        : (request.prompt?.length ?? 0);
      return {
        text: `Response from ${name}`,
        model: `${name}-model`,
        provider: name,
        usage: { promptTokens: promptLen, completionTokens: 20 },
      };
    },
  };
}

describe('Messages-based complete() integration (US4)', () => {
  let engine: Runcor;

  afterEach(async () => {
    if (engine) await engine.shutdown();
  });

  it('should track cost correctly for messages-based requests (US4-AS1)', async () => {
    const costEvents: CostRequestEvent[] = [];

    engine = await createEngine({
      model: {
        providers: [{
          provider: createMessagesProvider('test'),
          priority: 1,
          costPerToken: { input: 0.01, output: 0.03 },
        }],
      },
      cost: {},
    });

    engine.on('cost:request', (event: CostRequestEvent) => {
      costEvents.push(event);
    });

    engine.register('messages-flow', async (ctx) => {
      return await ctx.model.complete({
        messages: [
          { role: 'user', content: 'Hello world' },
        ],
      });
    });

    await engine.trigger('messages-flow', { idempotencyKey: 'msg-cost-1' });
    await new Promise((r) => setTimeout(r, 200));

    expect(costEvents).toHaveLength(1);
    expect(costEvents[0].provider).toBe('test');
    // "Hello world" = 11 chars
    expect(costEvents[0].promptTokens).toBe(11);
    expect(costEvents[0].completionTokens).toBe(20);
  });

  it('should work with routing fallback for messages-based requests (US4-AS2)', async () => {
    const failingProvider: ModelProvider = {
      name: 'failing',
      async complete() { throw new Error('down'); },
    };

    engine = await createEngine({
      model: {
        providers: [
          { provider: failingProvider, priority: 1 },
          { provider: createMessagesProvider('backup'), priority: 2 },
        ],
      },
    });

    engine.register('fallback-flow', async (ctx) => {
      const result = await ctx.model.complete({
        messages: [{ role: 'user', content: 'Test' }],
      });
      return result;
    });

    const exec = await engine.trigger('fallback-flow', { idempotencyKey: 'msg-fallback-1' });
    await new Promise((r) => setTimeout(r, 200));

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    expect((final!.result as ModelResponse).provider).toBe('backup');
  });

  it('should maintain backward compatibility with prompt-based requests', async () => {
    engine = await createEngine({
      model: {
        providers: [{
          provider: createMessagesProvider('compat'),
          priority: 1,
          costPerToken: { input: 0.01, output: 0.03 },
        }],
      },
      cost: {},
    });

    engine.register('prompt-flow', async (ctx) => {
      return await ctx.model.complete({ prompt: 'Hello' });
    });

    const exec = await engine.trigger('prompt-flow', { idempotencyKey: 'compat-1' });
    await new Promise((r) => setTimeout(r, 200));

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
  });

  it('should apply policy rules identically for messages requests (US4-AS3)', async () => {
    engine = await createEngine({
      model: {
        providers: [{ provider: createMessagesProvider('pol'), priority: 1 }],
      },
      policy: {
        rules: [{
          name: 'deny-messages-flow',
          priority: 1,
          operations: ['trigger'],
          evaluate: (ctx) => {
            if (ctx.flowName === 'denied-flow') {
              return { action: 'deny', reason: 'blocked' };
            }
            return { action: 'allow', reason: null };
          },
        }],
      },
    });

    engine.register('denied-flow', async (ctx) => {
      return await ctx.model.complete({
        messages: [{ role: 'user', content: 'Should not reach' }],
      });
    });

    await expect(
      engine.trigger('denied-flow', { idempotencyKey: 'deny-1' }),
    ).rejects.toThrow();
  });

  it('should evaluate messages-based results identically (US4-AS4)', async () => {
    const evalResults: Array<{ executionId: string; overallScore: number }> = [];

    engine = await createEngine({
      model: {
        providers: [{ provider: createMessagesProvider('eval'), priority: 1 }],
      },
      evaluation: {
        evaluators: [{
          name: 'test-eval',
          priority: 1,
          evaluate: () => ({
            scores: { quality: 0.9 },
          }),
        }],
      },
    });

    engine.on('eval:complete', (event: any) => {
      evalResults.push({ executionId: event.executionId, overallScore: event.overallScore });
    });

    engine.register('eval-flow', async (ctx) => {
      return await ctx.model.complete({
        messages: [{ role: 'user', content: 'Evaluate me' }],
      });
    });

    await engine.trigger('eval-flow', { idempotencyKey: 'eval-1' });
    // Evaluation runs fire-and-forget after execution — wait for it
    await new Promise((r) => setTimeout(r, 500));

    expect(evalResults).toHaveLength(1);
    expect(evalResults[0].overallScore).toBe(0.9);
  });
});
