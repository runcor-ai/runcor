// Unit tests for CostTracker — basic cost recording
// Per spec FR-001, FR-002, FR-015, FR-016, FR-018

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CostTracker } from '../../../src/cost/tracker.js';
import { InMemoryCostLedger } from '../../../src/cost/ledger.js';
import type { CostConfig, ProviderRegistration } from '../../../src/types.js';
import type { ModelRequest, ModelResponse, ModelStream, StreamEvent } from '../../../src/model/provider.js';
import { createFallbackStream } from '../../../src/model/provider.js';
import { ModelRouter } from '../../../src/model/router.js';

/** Create a mock ModelRouter that returns a canned response and exposes lastResolvedProvider */
function createMockRouter(
  response: ModelResponse,
  providerRegistrations: ProviderRegistration[],
): ModelRouter {
  const router = new ModelRouter({
    providers: providerRegistrations,
  });
  // Override complete to return canned response
  vi.spyOn(router, 'complete').mockResolvedValue(response);
  // Set lastResolvedProvider to the response's provider
  (router as any)._lastResolvedProvider = response.provider;
  return router;
}

function makeMockProvider(name: string) {
  return {
    name,
    complete: vi.fn().mockResolvedValue({
      text: 'hello',
      model: 'test-model',
      provider: name,
      usage: { promptTokens: 100, completionTokens: 50 },
    }),
  };
}

describe('CostTracker', () => {
  let ledger: InMemoryCostLedger;
  let costConfig: CostConfig;

  const defaultResponse: ModelResponse = {
    text: 'hello',
    model: 'test-model',
    provider: 'provider-a',
    usage: { promptTokens: 100, completionTokens: 50 },
  };

  const providerA = makeMockProvider('provider-a');
  const providerB = makeMockProvider('provider-b');

  const registrations: ProviderRegistration[] = [
    {
      name: 'provider-a',
      provider: providerA,
      priority: 1,
      costPerToken: { input: 0.01, output: 0.03 },
      models: null,
    },
    {
      name: 'provider-b',
      provider: providerB,
      priority: 2,
      costPerToken: { input: 0.005, output: 0.015 },
      models: null,
    },
  ];

  beforeEach(() => {
    ledger = new InMemoryCostLedger();
    costConfig = {};
    vi.restoreAllMocks();
  });

  describe('wrapComplete()', () => {
    it('records CostEntry after successful model.complete()', async () => {
      const router = createMockRouter(defaultResponse, registrations);
      const tracker = new CostTracker(router, ledger, costConfig, registrations);

      await tracker.wrapComplete(
        { prompt: 'test' },
        { executionId: 'exec-1', flowName: 'test-flow', userId: null },
      );

      expect(ledger.getCount()).toBe(1);
      const entries = ledger.query({});
      expect(entries[0].provider).toBe('provider-a');
      expect(entries[0].promptTokens).toBe(100);
      expect(entries[0].completionTokens).toBe(50);
      // cost = (100 * 0.01) + (50 * 0.03) = 1.0 + 1.5 = 2.5
      expect(entries[0].cost).toBeCloseTo(2.5);
    });

    it('calculates cost using correct provider costPerToken', async () => {
      const responseB: ModelResponse = {
        text: 'hi',
        model: 'model-b',
        provider: 'provider-b',
        usage: { promptTokens: 200, completionTokens: 100 },
      };
      const router = createMockRouter(responseB, registrations);
      const tracker = new CostTracker(router, ledger, costConfig, registrations);

      await tracker.wrapComplete(
        { prompt: 'test' },
        { executionId: 'exec-1', flowName: 'test-flow', userId: null },
      );

      const entries = ledger.query({});
      // cost = (200 * 0.005) + (100 * 0.015) = 1.0 + 1.5 = 2.5
      expect(entries[0].cost).toBeCloseTo(2.5);
      expect(entries[0].provider).toBe('provider-b');
    });

    it('records zero cost when provider has no costPerToken', async () => {
      const noCostReg: ProviderRegistration[] = [
        {
          name: 'free-provider',
          provider: makeMockProvider('free-provider'),
          priority: 1,
          costPerToken: null,
          models: null,
        },
      ];
      const freeResponse: ModelResponse = {
        text: 'free',
        model: 'free-model',
        provider: 'free-provider',
        usage: { promptTokens: 100, completionTokens: 50 },
      };
      const router = createMockRouter(freeResponse, noCostReg);
      const tracker = new CostTracker(router, ledger, costConfig, noCostReg);

      await tracker.wrapComplete(
        { prompt: 'test' },
        { executionId: 'exec-1', flowName: 'test-flow', userId: null },
      );

      const entries = ledger.query({});
      expect(entries[0].cost).toBe(0);
      expect(entries[0].promptTokens).toBe(100);
      expect(entries[0].completionTokens).toBe(50);
    });

    it('accumulates multiple requests within same execution', async () => {
      const router = createMockRouter(defaultResponse, registrations);
      const tracker = new CostTracker(router, ledger, costConfig, registrations);
      const ctx = { executionId: 'exec-1', flowName: 'test-flow', userId: null };

      await tracker.wrapComplete({ prompt: 'one' }, ctx);
      await tracker.wrapComplete({ prompt: 'two' }, ctx);
      await tracker.wrapComplete({ prompt: 'three' }, ctx);

      const entries = ledger.query({ executionId: 'exec-1' });
      expect(entries).toHaveLength(3);
      const total = ledger.getTotal({ executionId: 'exec-1' });
      expect(total).toBeCloseTo(7.5); // 2.5 * 3
    });

    it('records correct CostEntry fields', async () => {
      const router = createMockRouter(defaultResponse, registrations);
      const tracker = new CostTracker(router, ledger, costConfig, registrations);

      await tracker.wrapComplete(
        { prompt: 'test' },
        { executionId: 'exec-42', flowName: 'my-flow', userId: 'alice' },
      );

      const entry = ledger.query({})[0];
      expect(entry.id).toBeDefined();
      expect(entry.id).toMatch(/^[0-9a-f-]+$/); // UUID format
      expect(entry.timestamp).toBeInstanceOf(Date);
      expect(entry.provider).toBe('provider-a');
      expect(entry.model).toBe('test-model');
      expect(entry.promptTokens).toBe(100);
      expect(entry.completionTokens).toBe(50);
      expect(entry.cost).toBeCloseTo(2.5);
      expect(entry.executionId).toBe('exec-42');
      expect(entry.flowName).toBe('my-flow');
      expect(entry.userId).toBe('alice');
    });

    it('returns the original response unchanged', async () => {
      const router = createMockRouter(defaultResponse, registrations);
      const tracker = new CostTracker(router, ledger, costConfig, registrations);

      const result = await tracker.wrapComplete(
        { prompt: 'test' },
        { executionId: 'exec-1', flowName: 'flow', userId: null },
      );

      expect(result).toBe(defaultResponse);
    });

    it('gracefully handles ledger recording failure (FR-018)', async () => {
      const brokenLedger = new InMemoryCostLedger();
      vi.spyOn(brokenLedger, 'record').mockImplementation(() => {
        throw new Error('storage failure');
      });

      const router = createMockRouter(defaultResponse, registrations);
      const tracker = new CostTracker(router, brokenLedger, costConfig, registrations);

      // Should NOT throw — request still succeeds
      const result = await tracker.wrapComplete(
        { prompt: 'test' },
        { executionId: 'exec-1', flowName: 'flow', userId: null },
      );

      expect(result).toBe(defaultResponse);
    });
  });

  // T026: CostTracker.wrapStream() tests (US3)
  describe('wrapStream()', () => {
    it('records CostEntry after stream completes successfully', async () => {
      const router = createMockRouter(defaultResponse, registrations);
      // Mock router.stream() to return a fallback stream from the default response
      vi.spyOn(router, 'stream').mockImplementation(() => createFallbackStream(defaultResponse));
      (router as any)._lastResolvedProvider = 'provider-a';

      const tracker = new CostTracker(router, ledger, costConfig, registrations);

      const stream = tracker.wrapStream(
        { prompt: 'test' },
        { executionId: 'exec-s1', flowName: 'stream-flow', userId: null },
      );

      // Consume the stream
      for await (const _ of stream) { /* consume */ }
      // Await the wrapped response to trigger cost recording
      await stream.response;

      expect(ledger.getCount()).toBe(1);
      const entries = ledger.query({});
      expect(entries[0].provider).toBe('provider-a');
      expect(entries[0].promptTokens).toBe(100);
      expect(entries[0].completionTokens).toBe(50);
      expect(entries[0].cost).toBeCloseTo(2.5);
      expect(entries[0].executionId).toBe('exec-s1');
      expect(entries[0].flowName).toBe('stream-flow');
    });

    it('does not record cost when stream errors', async () => {
      const router = createMockRouter(defaultResponse, registrations);
      // Mock router.stream() to return a stream that errors
      vi.spyOn(router, 'stream').mockImplementation(() => {
        const errorStream: ModelStream = {
          async *[Symbol.asyncIterator]() {
            throw new Error('stream failed');
          },
          response: Promise.reject(new Error('stream failed')),
        };
        return errorStream;
      });

      const tracker = new CostTracker(router, ledger, costConfig, registrations);

      const stream = tracker.wrapStream(
        { prompt: 'test' },
        { executionId: 'exec-s2', flowName: 'stream-flow', userId: null },
      );

      // Stream response should reject
      try {
        await stream.response;
      } catch {
        // Expected
      }

      // No cost entry recorded
      expect(ledger.getCount()).toBe(0);
    });

    it('computes prompt length from messages when prompt absent (FR-010)', async () => {
      const router = createMockRouter(defaultResponse, registrations);
      vi.spyOn(router, 'stream').mockImplementation(() => createFallbackStream(defaultResponse));
      (router as any)._lastResolvedProvider = 'provider-a';

      const tracker = new CostTracker(router, ledger, costConfig, registrations);

      const stream = tracker.wrapStream(
        { messages: [{ role: 'user', content: 'Hello world' }] },
        { executionId: 'exec-s3', flowName: 'stream-flow', userId: null },
      );

      for await (const _ of stream) { /* consume */ }
      await stream.response;

      // Cost entry recorded — prompt length computed from messages
      expect(ledger.getCount()).toBe(1);
    });

    it('emits cost:request event after stream completes', async () => {
      const router = createMockRouter(defaultResponse, registrations);
      vi.spyOn(router, 'stream').mockImplementation(() => createFallbackStream(defaultResponse));
      (router as any)._lastResolvedProvider = 'provider-a';

      const costEvents: Array<{ type: string; payload: unknown }> = [];
      const onCostEvent = vi.fn((type: string, payload: unknown) => {
        costEvents.push({ type, payload });
      });

      const tracker = new CostTracker(router, ledger, costConfig, registrations, onCostEvent);

      const stream = tracker.wrapStream(
        { prompt: 'test' },
        { executionId: 'exec-s4', flowName: 'stream-flow', userId: null },
      );

      for await (const _ of stream) { /* consume */ }
      await stream.response;

      const requestEvents = costEvents.filter(e => e.type === 'cost:request');
      expect(requestEvents).toHaveLength(1);
    });
  });
});
