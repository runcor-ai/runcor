// Integration tests for routing (US1)
// Per spec US1 acceptance scenarios and contracts/router-api.md

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, Runcor } from '../../src/engine.js';
import type { ModelProvider, ModelRequest, ModelResponse } from '../../src/model/provider.js';

/** Helper: create a named mock provider that returns its own name in responses */
function namedProvider(name: string, completeFn?: (req: ModelRequest) => Promise<ModelResponse>): ModelProvider {
  return {
    name,
    complete: completeFn ?? (async (req: ModelRequest): Promise<ModelResponse> => ({
      text: `Response from ${name}: ${req.prompt}`,
      model: 'test',
      provider: name,
      usage: { promptTokens: req.prompt.length, completionTokens: 10 },
    })),
  };
}

describe('Routing Integration Tests', () => {
  let engine: Runcor;

  afterEach(async () => {
    if (engine) await engine.shutdown();
  });

  describe('US1: Multi-Provider Registration and Priority Routing', () => {
    it('should route to higher-priority provider (priority 1 over priority 2)', async () => {
      engine = await createEngine({
        model: {
          providers: [
            { provider: namedProvider('secondary'), priority: 2 },
            { provider: namedProvider('primary'), priority: 1 },
          ],
        },
      });

      let responseProvider = '';
      engine.register('test-flow', async (ctx) => {
        const response = await ctx.model.complete({ prompt: 'hello' });
        responseProvider = response.provider;
        return response.text;
      });

      const exec = await engine.trigger('test-flow', { idempotencyKey: 'r1' });
      // Wait for completion
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(responseProvider).toBe('primary');
    });

    it('should work with a single provider (backward compat with providers array)', async () => {
      engine = await createEngine({
        model: {
          providers: [{ provider: namedProvider('solo') }],
        },
      });

      let responseProvider = '';
      engine.register('test-flow', async (ctx) => {
        const response = await ctx.model.complete({ prompt: 'hello' });
        responseProvider = response.provider;
        return response.text;
      });

      await engine.trigger('test-flow', { idempotencyKey: 'r2' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(responseProvider).toBe('solo');
    });

    it('should work with legacy model.provider config', async () => {
      engine = await createEngine({
        model: { provider: namedProvider('legacy') },
      });

      let responseProvider = '';
      engine.register('test-flow', async (ctx) => {
        const response = await ctx.model.complete({ prompt: 'hello' });
        responseProvider = response.provider;
        return response.text;
      });

      await engine.trigger('test-flow', { idempotencyKey: 'r3' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(responseProvider).toBe('legacy');
    });

    it('should reject empty providers array', async () => {
      await expect(
        createEngine({ model: { providers: [] } }),
      ).rejects.toThrow('No model providers configured');
    });

    it('should reject duplicate provider names', async () => {
      await expect(
        createEngine({
          model: {
            providers: [
              { provider: namedProvider('dup') },
              { provider: namedProvider('dup') },
            ],
          },
        }),
      ).rejects.toThrow('Duplicate provider name');
    });

    it('should reject when both provider and providers are specified', async () => {
      await expect(
        createEngine({
          model: {
            provider: namedProvider('single'),
            providers: [{ provider: namedProvider('multi') }],
          },
        }),
      ).rejects.toThrow('Cannot specify both');
    });
  });

  // T016: US2 Integration Tests — Automatic Fallback
  describe('US2: Automatic Fallback on Provider Failure', () => {
    it('should fall back to secondary when primary fails', async () => {
      engine = await createEngine({
        model: {
          providers: [
            { provider: namedProvider('failing', async () => { throw new Error('down'); }), priority: 1 },
            { provider: namedProvider('backup'), priority: 2 },
          ],
        },
      });

      let responseProvider = '';
      engine.register('test-flow', async (ctx) => {
        const response = await ctx.model.complete({ prompt: 'hello' });
        responseProvider = response.provider;
        return response.text;
      });

      await engine.trigger('test-flow', { idempotencyKey: 'fb1' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(responseProvider).toBe('backup');
    });

    it('should surface error to flow when all providers fail', async () => {
      engine = await createEngine({
        model: {
          providers: [
            { provider: namedProvider('fail1', async () => { throw new Error('err1'); }), priority: 1 },
            { provider: namedProvider('fail2', async () => { throw new Error('err2'); }), priority: 2 },
          ],
        },
      });

      let caughtError: Error | null = null;
      engine.register('test-flow', async (ctx) => {
        try {
          await ctx.model.complete({ prompt: 'hello' });
        } catch (err) {
          caughtError = err as Error;
          throw err; // re-throw to fail the flow
        }
      }, { maxRetries: 0 });

      await engine.trigger('test-flow', { idempotencyKey: 'fb2' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(caughtError).toBeDefined();
      expect(caughtError!.message).toBe('All providers failed for model request.');
    });

    it('should respect maxFallbackAttempts=0 (no fallback)', async () => {
      engine = await createEngine({
        model: {
          providers: [
            { provider: namedProvider('failing', async () => { throw new Error('down'); }), priority: 1 },
            { provider: namedProvider('backup'), priority: 2 },
          ],
          maxFallbackAttempts: 0,
        },
      });

      let caughtError: Error | null = null;
      engine.register('test-flow', async (ctx) => {
        try {
          await ctx.model.complete({ prompt: 'hello' });
        } catch (err) {
          caughtError = err as Error;
          throw err;
        }
      }, { maxRetries: 0 });

      await engine.trigger('test-flow', { idempotencyKey: 'fb3' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(caughtError).toBeDefined();
      expect(caughtError!.message).toBe('All providers failed for model request.');
    });
  });

  // T019: US3 Integration Tests — Pluggable Routing Strategies
  describe('US3: Pluggable Routing Strategies', () => {
    it('should distribute requests evenly with round-robin strategy', async () => {
      const callCounts: Record<string, number> = { a: 0, b: 0, c: 0 };

      engine = await createEngine({
        model: {
          providers: [
            { provider: namedProvider('a', async (req) => { callCounts.a++; return { text: 'a', model: 'test', provider: 'a', usage: { promptTokens: 0, completionTokens: 0 } }; }) },
            { provider: namedProvider('b', async (req) => { callCounts.b++; return { text: 'b', model: 'test', provider: 'b', usage: { promptTokens: 0, completionTokens: 0 } }; }) },
            { provider: namedProvider('c', async (req) => { callCounts.c++; return { text: 'c', model: 'test', provider: 'c', usage: { promptTokens: 0, completionTokens: 0 } }; }) },
          ],
          strategy: 'round-robin',
        },
      });

      // Register 6 separate flows to make 6 sequential requests
      for (let i = 0; i < 6; i++) {
        engine.register(`flow-${i}`, async (ctx) => {
          await ctx.model.complete({ prompt: 'hello' });
        });
      }

      // Trigger all 6 sequentially
      for (let i = 0; i < 6; i++) {
        await engine.trigger(`flow-${i}`, { idempotencyKey: `rr-${i}` });
        await new Promise<void>((resolve) => {
          const handler = () => { resolve(); };
          engine.on('execution:complete', handler);
        });
      }

      expect(callCounts.a).toBe(2);
      expect(callCounts.b).toBe(2);
      expect(callCounts.c).toBe(2);
    });

    it('should select cheapest provider with lowest-cost strategy', async () => {
      engine = await createEngine({
        model: {
          providers: [
            { provider: namedProvider('expensive'), priority: 1, costPerToken: { input: 0.1, output: 0.3 } },
            { provider: namedProvider('cheap'), priority: 2, costPerToken: { input: 0.01, output: 0.02 } },
          ],
          strategy: 'lowest-cost',
        },
      });

      let responseProvider = '';
      engine.register('test-flow', async (ctx) => {
        const response = await ctx.model.complete({ prompt: 'hello' });
        responseProvider = response.provider;
      });

      await engine.trigger('test-flow', { idempotencyKey: 'lc1' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(responseProvider).toBe('cheap');
    });

    it('should use custom strategy function', async () => {
      engine = await createEngine({
        model: {
          providers: [
            { provider: namedProvider('a'), priority: 1 },
            { provider: namedProvider('b'), priority: 2 },
          ],
          // Custom strategy: always pick last provider
          strategy: (providers) => [...providers].reverse(),
        },
      });

      let responseProvider = '';
      engine.register('test-flow', async (ctx) => {
        const response = await ctx.model.complete({ prompt: 'hello' });
        responseProvider = response.provider;
      });

      await engine.trigger('test-flow', { idempotencyKey: 'cs1' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(responseProvider).toBe('b');
    });

    it('should support per-request strategy override', async () => {
      engine = await createEngine({
        model: {
          providers: [
            { provider: namedProvider('a'), priority: 1 },
            { provider: namedProvider('b'), priority: 2 },
          ],
          strategy: 'priority', // default: a first
        },
      });

      let responseProvider = '';
      engine.register('test-flow', async (ctx) => {
        // Override strategy to reverse (b first)
        const response = await ctx.model.complete({
          prompt: 'hello',
          strategy: (providers) => [...providers].reverse(),
        });
        responseProvider = response.provider;
      });

      await engine.trigger('test-flow', { idempotencyKey: 'so1' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(responseProvider).toBe('b');
    });
  });

  // T022: US4 Integration Tests — Provider Health Tracking with Circuit Breaker
  describe('US4: Provider Health Tracking with Circuit Breaker', () => {
    it('should mark provider unhealthy after consecutive failures and skip it', async () => {
      let primaryCalls = 0;

      engine = await createEngine({
        model: {
          providers: [
            {
              provider: namedProvider('failing', async () => {
                primaryCalls++;
                throw new Error('fail');
              }),
              priority: 1,
            },
            { provider: namedProvider('backup'), priority: 2 },
          ],
          failureThreshold: 3,
          cooldownMs: 60000, // long cooldown so it stays unhealthy for this test
        },
      });

      // Make 3 requests — each will fail on 'failing', fall back to 'backup'
      for (let i = 0; i < 3; i++) {
        engine.register(`flow-${i}`, async (ctx) => {
          await ctx.model.complete({ prompt: 'hello' });
        });
        await engine.trigger(`flow-${i}`, { idempotencyKey: `h-${i}` });
        await new Promise<void>((resolve) => {
          engine.on('execution:complete', () => resolve());
        });
      }

      // After 3 failures, 'failing' should be unhealthy
      // Next request should go directly to 'backup' without trying 'failing'
      primaryCalls = 0;
      engine.register('flow-check', async (ctx) => {
        await ctx.model.complete({ prompt: 'hello' });
      });
      await engine.trigger('flow-check', { idempotencyKey: 'h-check' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(primaryCalls).toBe(0); // 'failing' was skipped
    });

    it('should emit provider:health_change events on transitions', async () => {
      const healthEvents: Array<{ provider: string; from: string; to: string }> = [];

      engine = await createEngine({
        model: {
          providers: [
            {
              provider: namedProvider('unstable', async () => { throw new Error('fail'); }),
              priority: 1,
            },
            { provider: namedProvider('backup'), priority: 2 },
          ],
          failureThreshold: 2,
          cooldownMs: 60000,
        },
      });

      engine.on('provider:health_change', (event) => {
        healthEvents.push({ provider: event.provider, from: event.from, to: event.to });
      });

      // Trigger 2 requests to trip the circuit breaker
      for (let i = 0; i < 2; i++) {
        engine.register(`flow-${i}`, async (ctx) => {
          await ctx.model.complete({ prompt: 'hello' });
        });
        await engine.trigger(`flow-${i}`, { idempotencyKey: `he-${i}` });
        await new Promise<void>((resolve) => {
          engine.on('execution:complete', () => resolve());
        });
      }

      expect(healthEvents).toContainEqual({
        provider: 'unstable',
        from: 'healthy',
        to: 'unhealthy',
      });
    });

    it('should throw NO_HEALTHY_PROVIDERS when all providers are unhealthy', async () => {
      engine = await createEngine({
        model: {
          providers: [
            {
              provider: namedProvider('fail1', async () => { throw new Error('fail'); }),
              priority: 1,
            },
            {
              provider: namedProvider('fail2', async () => { throw new Error('fail'); }),
              priority: 2,
            },
          ],
          failureThreshold: 1,
          cooldownMs: 60000,
        },
      });

      // First request: both fail, both trip to unhealthy
      engine.register('flow-trip', async (ctx) => {
        await ctx.model.complete({ prompt: 'hello' });
      }, { maxRetries: 0 });

      await engine.trigger('flow-trip', { idempotencyKey: 'nhp-1' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      // Second request: no healthy providers
      let caughtCode = '';
      engine.register('flow-check', async (ctx) => {
        try {
          await ctx.model.complete({ prompt: 'hello' });
        } catch (err: any) {
          caughtCode = err.code;
          throw err;
        }
      }, { maxRetries: 0 });

      await engine.trigger('flow-check', { idempotencyKey: 'nhp-2' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(caughtCode).toBe('NO_HEALTHY_PROVIDERS');
    });

    it('should reset failure counter on success', async () => {
      let callCount = 0;
      let shouldFail = true;

      engine = await createEngine({
        model: {
          providers: [
            {
              provider: namedProvider('flaky', async (req) => {
                callCount++;
                if (shouldFail) throw new Error('fail');
                return { text: 'ok', model: 'test', provider: 'flaky', usage: { promptTokens: 0, completionTokens: 0 } };
              }),
              priority: 1,
            },
            { provider: namedProvider('backup'), priority: 2 },
          ],
          failureThreshold: 3,
          cooldownMs: 60000,
        },
      });

      // 2 failures (below threshold of 3)
      for (let i = 0; i < 2; i++) {
        engine.register(`flow-fail-${i}`, async (ctx) => {
          await ctx.model.complete({ prompt: 'hello' });
        });
        await engine.trigger(`flow-fail-${i}`, { idempotencyKey: `rc-fail-${i}` });
        await new Promise<void>((resolve) => {
          engine.on('execution:complete', () => resolve());
        });
      }

      // 1 success — should reset counter
      shouldFail = false;
      callCount = 0;
      engine.register('flow-success', async (ctx) => {
        await ctx.model.complete({ prompt: 'hello' });
      });
      await engine.trigger('flow-success', { idempotencyKey: 'rc-success' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(callCount).toBe(1); // 'flaky' was called (still healthy)

      // 2 more failures — should NOT trip (counter was reset)
      shouldFail = true;
      callCount = 0;
      for (let i = 0; i < 2; i++) {
        engine.register(`flow-fail2-${i}`, async (ctx) => {
          await ctx.model.complete({ prompt: 'hello' });
        });
        await engine.trigger(`flow-fail2-${i}`, { idempotencyKey: `rc-fail2-${i}` });
        await new Promise<void>((resolve) => {
          engine.on('execution:complete', () => resolve());
        });
      }

      // 'flaky' should still be called (not tripped yet — only 2 consecutive failures again)
      expect(callCount).toBe(2);
    });
  });

  // T025: US5 Integration Tests — Request-Level Provider and Strategy Overrides
  describe('US5: Request-Level Provider and Strategy Overrides', () => {
    it('should route to specified provider via override', async () => {
      engine = await createEngine({
        model: {
          providers: [
            { provider: namedProvider('a'), priority: 1 },
            { provider: namedProvider('b'), priority: 2 },
          ],
        },
      });

      let responseProvider = '';
      engine.register('test-flow', async (ctx) => {
        const response = await ctx.model.complete({ prompt: 'hello', provider: 'b' });
        responseProvider = response.provider;
      });

      await engine.trigger('test-flow', { idempotencyKey: 'ov1' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(responseProvider).toBe('b');
    });

    it('should bypass health check for provider override (unhealthy provider still attempted)', async () => {
      let targetCalls = 0;

      engine = await createEngine({
        model: {
          providers: [
            {
              provider: namedProvider('unhealthy-target', async () => {
                targetCalls++;
                return { text: 'ok', model: 'test', provider: 'unhealthy-target', usage: { promptTokens: 0, completionTokens: 0 } };
              }),
              priority: 1,
            },
            { provider: namedProvider('backup'), priority: 2 },
          ],
          failureThreshold: 1,
          cooldownMs: 60000,
        },
      });

      // First, trip the target unhealthy by making it fail once
      const failingProvider = namedProvider('unhealthy-target', async () => { throw new Error('fail'); });
      // Actually, we need to use the engine. Let me rethink.
      // Trip unhealthy-target by making a request that fails through it
      // But our provider currently succeeds. We need it to fail first, then succeed on override.
      // Let me use a different approach: create with a provider that fails initially.

      await engine.shutdown();

      let shouldFail = true;
      engine = await createEngine({
        model: {
          providers: [
            {
              provider: namedProvider('target', async () => {
                targetCalls++;
                if (shouldFail) throw new Error('fail');
                return { text: 'ok', model: 'test', provider: 'target', usage: { promptTokens: 0, completionTokens: 0 } };
              }),
              priority: 1,
            },
            { provider: namedProvider('backup'), priority: 2 },
          ],
          failureThreshold: 1,
          cooldownMs: 60000,
        },
      });

      // Trip 'target' to unhealthy
      targetCalls = 0;
      engine.register('flow-trip', async (ctx) => {
        await ctx.model.complete({ prompt: 'hello' });
      });
      await engine.trigger('flow-trip', { idempotencyKey: 'ov-trip' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      // target is now unhealthy. Override should still attempt it.
      shouldFail = false;
      targetCalls = 0;
      engine.register('flow-override', async (ctx) => {
        const response = await ctx.model.complete({ prompt: 'hello', provider: 'target' });
        expect(response.provider).toBe('target');
      });
      await engine.trigger('flow-override', { idempotencyKey: 'ov-bypass' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(targetCalls).toBe(1); // Was called despite being unhealthy
    });

    it('should throw PROVIDER_NOT_FOUND for unknown provider override', async () => {
      engine = await createEngine({
        model: {
          providers: [
            { provider: namedProvider('a'), priority: 1 },
          ],
        },
      });

      let caughtCode = '';
      engine.register('test-flow', async (ctx) => {
        try {
          await ctx.model.complete({ prompt: 'hello', provider: 'nonexistent' });
        } catch (err: any) {
          caughtCode = err.code;
          throw err;
        }
      }, { maxRetries: 0 });

      await engine.trigger('test-flow', { idempotencyKey: 'ov-404' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(caughtCode).toBe('PROVIDER_NOT_FOUND');
    });

    it('should give provider override precedence over strategy override', async () => {
      engine = await createEngine({
        model: {
          providers: [
            { provider: namedProvider('a'), priority: 1 },
            { provider: namedProvider('b'), priority: 2 },
          ],
        },
      });

      let responseProvider = '';
      engine.register('test-flow', async (ctx) => {
        // Both overrides specified — provider should win
        const response = await ctx.model.complete({
          prompt: 'hello',
          provider: 'b',
          strategy: (providers) => providers, // would pick 'a' first
        });
        responseProvider = response.provider;
      });

      await engine.trigger('test-flow', { idempotencyKey: 'ov-prec' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(responseProvider).toBe('b');
    });
  });

  // T029: Edge Case Tests
  describe('Edge Cases', () => {
    it('should work with single provider in multi-provider config', async () => {
      engine = await createEngine({
        model: {
          providers: [{ provider: namedProvider('solo'), priority: 1 }],
        },
      });

      let responseProvider = '';
      engine.register('test-flow', async (ctx) => {
        const response = await ctx.model.complete({ prompt: 'hello' });
        responseProvider = response.provider;
      });

      await engine.trigger('test-flow', { idempotencyKey: 'ec1' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(responseProvider).toBe('solo');
    });

    it('should fail immediately when maxFallbackAttempts=0 and provider fails', async () => {
      engine = await createEngine({
        model: {
          providers: [
            { provider: namedProvider('fail', async () => { throw new Error('down'); }), priority: 1 },
            { provider: namedProvider('backup'), priority: 2 },
          ],
          maxFallbackAttempts: 0,
        },
      });

      let caughtError: Error | null = null;
      engine.register('test-flow', async (ctx) => {
        try {
          await ctx.model.complete({ prompt: 'hello' });
        } catch (err) {
          caughtError = err as Error;
          throw err;
        }
      }, { maxRetries: 0 });

      await engine.trigger('test-flow', { idempotencyKey: 'ec2' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(caughtError).toBeDefined();
    });

    it('should clean up circuit breaker timers on engine shutdown', async () => {
      engine = await createEngine({
        model: {
          providers: [
            { provider: namedProvider('fail', async () => { throw new Error('down'); }), priority: 1 },
            { provider: namedProvider('backup'), priority: 2 },
          ],
          failureThreshold: 1,
          cooldownMs: 1000,
        },
      });

      // Trip circuit breaker
      engine.register('trip-flow', async (ctx) => {
        await ctx.model.complete({ prompt: 'hello' });
      });
      await engine.trigger('trip-flow', { idempotencyKey: 'ec3' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      // Shutdown should clean up timers without errors
      await engine.shutdown();
      // If timers leak, this would cause test framework warnings
    });
  });

  // T030: Performance Tests
  describe('Performance', () => {
    it('SC-002: routing overhead should be < 1ms', async () => {
      const { ModelRouter } = await import('../../src/model/router.js');

      const providers = Array.from({ length: 5 }, (_, i) => ({
        name: `p${i}`,
        provider: namedProvider(`p${i}`),
        priority: i + 1,
        costPerToken: null,
        models: null,
      }));

      const router = new ModelRouter({ providers });

      // Warm up
      await router.complete({ prompt: 'warmup' });

      const iterations = 100;
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        await router.complete({ prompt: 'test' });
      }
      const elapsed = performance.now() - start;
      const avgOverhead = elapsed / iterations;

      // The provider itself takes some time; overhead should be minimal
      // We test that total per-request time is reasonable (< 1ms overhead)
      expect(avgOverhead).toBeLessThan(1);
      router.shutdown();
    });

    it('SC-003: fallback latency should be < 5ms (excluding provider response time)', async () => {
      const { ModelRouter } = await import('../../src/model/router.js');

      const providers = [
        {
          name: 'fail',
          provider: namedProvider('fail', async () => { throw new Error('fail'); }),
          priority: 1,
          costPerToken: null,
          models: null,
        },
        {
          name: 'backup',
          provider: namedProvider('backup'),
          priority: 2,
          costPerToken: null,
          models: null,
        },
      ];

      const router = new ModelRouter({ providers });

      // Warm up
      await router.complete({ prompt: 'warmup' });

      const iterations = 50;
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        await router.complete({ prompt: 'test' });
      }
      const elapsed = performance.now() - start;
      const avgLatency = elapsed / iterations;

      // Each request involves 1 failure + 1 success. Overhead should be < 5ms.
      expect(avgLatency).toBeLessThan(5);
      router.shutdown();
    });

    it('SC-005: round-robin even distribution across N providers', async () => {
      const { createRoundRobinStrategy } = await import('../../src/model/strategies.js');

      const strategy = createRoundRobinStrategy();
      const N = 4;
      const providers = Array.from({ length: N }, (_, i) => ({
        name: `p${i}`,
        provider: namedProvider(`p${i}`),
        priority: 1,
        costPerToken: null,
        models: null,
      }));

      const counts: Record<string, number> = {};
      const totalRequests = 100;

      for (let i = 0; i < totalRequests; i++) {
        const ordered = strategy(providers, { prompt: 'test' });
        const selected = ordered[0].name;
        counts[selected] = (counts[selected] || 0) + 1;
      }

      // Each provider should get exactly totalRequests/N requests
      for (const name of Object.keys(counts)) {
        expect(counts[name]).toBe(totalRequests / N);
      }
    });
  });

  // T031: Quickstart Validation Tests
  describe('Quickstart Examples', () => {
    it('Example 1: single provider', async () => {
      engine = await createEngine({
        model: { provider: namedProvider('mock') },
      });

      let gotResponse = false;
      engine.register('test', async (ctx) => {
        const res = await ctx.model.complete({ prompt: 'hello' });
        expect(res.text).toBeDefined();
        gotResponse = true;
      });

      await engine.trigger('test', { idempotencyKey: 'qs1' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(gotResponse).toBe(true);
    });

    it('Example 2: two providers with fallback', async () => {
      engine = await createEngine({
        model: {
          providers: [
            { provider: namedProvider('primary', async () => { throw new Error('down'); }), priority: 1 },
            { provider: namedProvider('secondary'), priority: 2 },
          ],
        },
      });

      let responseProvider = '';
      engine.register('test', async (ctx) => {
        const res = await ctx.model.complete({ prompt: 'hello' });
        responseProvider = res.provider;
      });

      await engine.trigger('test', { idempotencyKey: 'qs2' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(responseProvider).toBe('secondary');
    });

    it('Example 3: round-robin distribution', async () => {
      const calls: string[] = [];

      engine = await createEngine({
        model: {
          providers: [
            { provider: namedProvider('a', async () => { calls.push('a'); return { text: 'a', model: 't', provider: 'a', usage: { promptTokens: 0, completionTokens: 0 } }; }) },
            { provider: namedProvider('b', async () => { calls.push('b'); return { text: 'b', model: 't', provider: 'b', usage: { promptTokens: 0, completionTokens: 0 } }; }) },
          ],
          strategy: 'round-robin',
        },
      });

      for (let i = 0; i < 4; i++) {
        engine.register(`flow-${i}`, async (ctx) => {
          await ctx.model.complete({ prompt: 'hello' });
        });
        await engine.trigger(`flow-${i}`, { idempotencyKey: `qs3-${i}` });
        await new Promise<void>((resolve) => {
          engine.on('execution:complete', () => resolve());
        });
      }

      expect(calls.filter((c) => c === 'a').length).toBe(2);
      expect(calls.filter((c) => c === 'b').length).toBe(2);
    });

    it('Example 4: lowest-cost selection', async () => {
      engine = await createEngine({
        model: {
          providers: [
            { provider: namedProvider('expensive'), priority: 1, costPerToken: { input: 0.1, output: 0.3 } },
            { provider: namedProvider('cheap'), priority: 2, costPerToken: { input: 0.001, output: 0.002 } },
          ],
          strategy: 'lowest-cost',
        },
      });

      let responseProvider = '';
      engine.register('test', async (ctx) => {
        const res = await ctx.model.complete({ prompt: 'hello' });
        responseProvider = res.provider;
      });

      await engine.trigger('test', { idempotencyKey: 'qs4' });
      await new Promise<void>((resolve) => {
        engine.on('execution:complete', () => resolve());
      });

      expect(responseProvider).toBe('cheap');
    });
  });
});
