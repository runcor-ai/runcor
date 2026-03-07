// Unit tests for RateLimiter — sliding window log algorithm
// Per spec FR-006, FR-007, FR-017, FR-020

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../../src/policy/rate-limiter.js';
import { EngineError } from '../../../src/errors.js';
import type { RateLimitConfig } from '../../../src/types.js';

function makeConfig(overrides?: Partial<RateLimitConfig>): RateLimitConfig {
  return {
    name: 'test-limit',
    scope: 'user',
    limit: 5,
    windowMs: 60000, // 1 minute
    behavior: 'reject',
    ...overrides,
  };
}

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new RateLimiter();
  });

  afterEach(() => {
    limiter.clear();
    vi.useRealTimers();
  });

  // ── Basic limit enforcement ──

  describe('basic limit enforcement', () => {
    it('should allow requests up to the limit', () => {
      const config = makeConfig({ limit: 3 });

      const r1 = limiter.checkSync(config, 'user-1', 'flow-a');
      expect(r1.allowed).toBe(true);
      expect(r1.currentCount).toBe(1);

      const r2 = limiter.checkSync(config, 'user-1', 'flow-a');
      expect(r2.allowed).toBe(true);
      expect(r2.currentCount).toBe(2);

      const r3 = limiter.checkSync(config, 'user-1', 'flow-a');
      expect(r3.allowed).toBe(true);
      expect(r3.currentCount).toBe(3);
    });

    it('should reject request exceeding the limit', () => {
      const config = makeConfig({ limit: 2 });

      limiter.checkSync(config, 'user-1', 'flow-a');
      limiter.checkSync(config, 'user-1', 'flow-a');

      const r3 = limiter.checkSync(config, 'user-1', 'flow-a');
      expect(r3.allowed).toBe(false);
      expect(r3.currentCount).toBe(2);
    });

    it('should throw EngineError with RATE_LIMITED code on async check when exceeded', async () => {
      const config = makeConfig({ limit: 1, behavior: 'reject' });

      await limiter.check(config, 'user-1', 'flow-a');

      await expect(limiter.check(config, 'user-1', 'flow-a')).rejects.toThrow(
        EngineError,
      );
      await expect(limiter.check(config, 'user-1', 'flow-a')).rejects.toThrow(
        /RATE_LIMITED|Rate limit/,
      );
    });

    it('should include config name in the check result', () => {
      const config = makeConfig({ name: 'my-rate-limit' });
      const result = limiter.checkSync(config, 'user-1', 'flow-a');
      expect(result.configName).toBe('my-rate-limit');
    });
  });

  // ── Window expiration ──

  describe('window expiration', () => {
    it('should allow new requests after window expires', () => {
      const config = makeConfig({ limit: 2, windowMs: 10000 });

      // Exhaust the limit
      limiter.checkSync(config, 'user-1', 'flow-a');
      limiter.checkSync(config, 'user-1', 'flow-a');

      const blocked = limiter.checkSync(config, 'user-1', 'flow-a');
      expect(blocked.allowed).toBe(false);

      // Advance time past the window
      vi.advanceTimersByTime(10001);

      const allowed = limiter.checkSync(config, 'user-1', 'flow-a');
      expect(allowed.allowed).toBe(true);
      expect(allowed.currentCount).toBe(1);
    });

    it('should use sliding window (partial expiration)', () => {
      const config = makeConfig({ limit: 3, windowMs: 10000 });

      // T=0: request 1
      limiter.checkSync(config, 'user-1', 'flow-a');

      // T=4000: request 2
      vi.advanceTimersByTime(4000);
      limiter.checkSync(config, 'user-1', 'flow-a');

      // T=7000: request 3
      vi.advanceTimersByTime(3000);
      limiter.checkSync(config, 'user-1', 'flow-a');

      // T=7000: limit is 3, should be blocked
      const blocked = limiter.checkSync(config, 'user-1', 'flow-a');
      expect(blocked.allowed).toBe(false);

      // T=10001: request 1 expires (was at T=0), request 2 (T=4000) and 3 (T=7000) remain
      vi.advanceTimersByTime(3001);
      const allowed = limiter.checkSync(config, 'user-1', 'flow-a');
      expect(allowed.allowed).toBe(true);
      expect(allowed.currentCount).toBe(3); // requests 2, 3, and the new one
    });
  });

  // ── Per-user scope isolation ──

  describe('per-user scope isolation', () => {
    it('should maintain independent counters per user', () => {
      const config = makeConfig({ scope: 'user', limit: 2 });

      // User A uses 2 requests
      limiter.checkSync(config, 'user-a', 'flow-a');
      limiter.checkSync(config, 'user-a', 'flow-a');

      // User A is blocked
      const blockedA = limiter.checkSync(config, 'user-a', 'flow-a');
      expect(blockedA.allowed).toBe(false);

      // User B is not affected
      const allowedB = limiter.checkSync(config, 'user-b', 'flow-a');
      expect(allowedB.allowed).toBe(true);
      expect(allowedB.currentCount).toBe(1);
    });

    it('should treat null userId as anonymous', () => {
      const config = makeConfig({ scope: 'user', limit: 1 });

      limiter.checkSync(config, null, 'flow-a');

      const blocked = limiter.checkSync(config, null, 'flow-a');
      expect(blocked.allowed).toBe(false);

      // Named user is separate from anonymous
      const allowed = limiter.checkSync(config, 'named-user', 'flow-a');
      expect(allowed.allowed).toBe(true);
    });
  });

  // ── Per-flow scope isolation ──

  describe('per-flow scope isolation', () => {
    it('should maintain independent counters per flow when config.flowName not set', () => {
      const config = makeConfig({ scope: 'flow', limit: 2 });

      // Flow A uses 2 requests
      limiter.checkSync(config, 'user-1', 'flow-a');
      limiter.checkSync(config, 'user-1', 'flow-a');

      // Flow A is blocked
      const blockedA = limiter.checkSync(config, 'user-1', 'flow-a');
      expect(blockedA.allowed).toBe(false);

      // Flow B is not affected
      const allowedB = limiter.checkSync(config, 'user-1', 'flow-b');
      expect(allowedB.allowed).toBe(true);
    });

    it('should share counter across flows when config.flowName is set', () => {
      const config = makeConfig({
        scope: 'flow',
        limit: 2,
        flowName: 'shared-flow',
      });

      // Both flows share the counter because config.flowName is set
      limiter.checkSync(config, 'user-1', 'flow-a');
      limiter.checkSync(config, 'user-1', 'flow-b');

      const blocked = limiter.checkSync(config, 'user-1', 'flow-c');
      expect(blocked.allowed).toBe(false);
    });
  });

  // ── Global scope ──

  describe('global scope', () => {
    it('should share a single counter across all users and flows', () => {
      const config = makeConfig({ scope: 'global', limit: 3 });

      limiter.checkSync(config, 'user-a', 'flow-x');
      limiter.checkSync(config, 'user-b', 'flow-y');
      limiter.checkSync(config, 'user-c', 'flow-z');

      // Global limit reached — blocked for any user/flow
      const blocked = limiter.checkSync(config, 'user-d', 'flow-w');
      expect(blocked.allowed).toBe(false);
      expect(blocked.currentCount).toBe(3);
    });
  });

  // ── Overlapping scopes (most restrictive wins) ──

  describe('overlapping scopes — most restrictive wins', () => {
    it('should enforce the most restrictive limit across multiple configs', async () => {
      const userConfig = makeConfig({
        name: 'user-limit',
        scope: 'user',
        limit: 10,
        behavior: 'reject',
      });
      const globalConfig = makeConfig({
        name: 'global-limit',
        scope: 'global',
        limit: 2,
        behavior: 'reject',
      });

      // First two requests: both limits allow
      await limiter.checkMultiple([userConfig, globalConfig], 'user-1', 'flow-a');
      await limiter.checkMultiple([userConfig, globalConfig], 'user-1', 'flow-a');

      // Third request: global limit (2) exceeded, even though user limit (10) is fine
      await expect(
        limiter.checkMultiple([userConfig, globalConfig], 'user-1', 'flow-a'),
      ).rejects.toThrow(EngineError);
    });
  });

  // ── Timestamp lazy eviction ──

  describe('timestamp lazy eviction', () => {
    it('should evict old timestamps during check', () => {
      const config = makeConfig({ limit: 3, windowMs: 5000 });

      // Fill up
      limiter.checkSync(config, 'user-1', 'flow-a');
      limiter.checkSync(config, 'user-1', 'flow-a');
      limiter.checkSync(config, 'user-1', 'flow-a');

      // All 3 timestamps are within window
      expect(limiter.getCurrentCount(config, 'user-1', 'flow-a')).toBe(3);

      // Advance past the window — old timestamps should be evicted on next check
      vi.advanceTimersByTime(5001);

      // getCurrentCount triggers eviction
      expect(limiter.getCurrentCount(config, 'user-1', 'flow-a')).toBe(0);

      // New requests should be allowed
      const result = limiter.checkSync(config, 'user-1', 'flow-a');
      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(1);
    });

    it('should not evict timestamps within the window', () => {
      const config = makeConfig({ limit: 5, windowMs: 10000 });

      limiter.checkSync(config, 'user-1', 'flow-a');
      vi.advanceTimersByTime(3000);
      limiter.checkSync(config, 'user-1', 'flow-a');
      vi.advanceTimersByTime(3000);
      limiter.checkSync(config, 'user-1', 'flow-a');

      // All 3 requests are within the 10s window — none evicted
      expect(limiter.getCurrentCount(config, 'user-1', 'flow-a')).toBe(3);
    });
  });

  // ── Queue behavior ──

  describe('queue behavior', () => {
    it('should queue requests when behavior is queue and limit exceeded', async () => {
      const config = makeConfig({
        limit: 1,
        windowMs: 5000,
        behavior: 'queue',
        queueTimeoutMs: 30000,
      });

      // First request allowed
      await limiter.check(config, 'user-1', 'flow-a');

      // Second request should be queued (returns a promise that hangs until released)
      const queuedPromise = limiter.check(config, 'user-1', 'flow-a');

      // Verify it was actually queued
      expect(limiter.getQueueDepth(config.name)).toBe(1);

      // Release the queued request explicitly (simulates removeRateLimit / capacity opening)
      limiter.releaseQueued(config.name);

      const queuedResult = await queuedPromise;
      expect(queuedResult.allowed).toBe(true);
      expect(limiter.getQueueDepth(config.name)).toBe(0);
    });

    it('should maintain FIFO ordering for queued requests', async () => {
      const config = makeConfig({
        limit: 1,
        windowMs: 2000,
        behavior: 'queue',
        queueTimeoutMs: 30000,
      });

      const order: number[] = [];

      // First request consumes the limit
      await limiter.check(config, 'user-1', 'flow-a');

      // Queue 3 requests
      const p1 = limiter.check(config, 'user-1', 'flow-a').then(() => order.push(1));
      vi.advanceTimersByTime(100);
      const p2 = limiter.check(config, 'user-1', 'flow-a').then(() => order.push(2));
      vi.advanceTimersByTime(100);
      const p3 = limiter.check(config, 'user-1', 'flow-a').then(() => order.push(3));

      expect(limiter.getQueueDepth(config.name)).toBe(3);

      // Release all by releasing the queue
      limiter.releaseQueued(config.name);

      // Let promises resolve
      await Promise.all([p1, p2, p3]);

      // FIFO order: 1, 2, 3
      expect(order).toEqual([1, 2, 3]);
    });
  });

  // ── maxQueueDepth enforcement ──

  describe('maxQueueDepth enforcement', () => {
    it('should throw when queue depth is exceeded', async () => {
      const config = makeConfig({
        limit: 1,
        windowMs: 60000,
        behavior: 'queue',
        maxQueueDepth: 2,
        queueTimeoutMs: 30000,
      });

      // First request allowed
      await limiter.check(config, 'user-1', 'flow-a');

      // Queue 2 requests (up to maxQueueDepth)
      const _p1 = limiter.check(config, 'user-1', 'flow-a');
      const _p2 = limiter.check(config, 'user-1', 'flow-a');

      expect(limiter.getQueueDepth(config.name)).toBe(2);

      // Third queued request should throw
      await expect(
        limiter.check(config, 'user-1', 'flow-a'),
      ).rejects.toThrow(EngineError);

      // Clean up pending promises
      limiter.releaseQueued(config.name);
      await Promise.all([_p1, _p2]);
    });
  });

  // ── queueTimeoutMs rejection ──

  describe('queueTimeoutMs rejection', () => {
    it('should reject queued request after timeout', async () => {
      const config = makeConfig({
        limit: 1,
        windowMs: 60000,
        behavior: 'queue',
        queueTimeoutMs: 5000,
      });

      // First request allowed
      await limiter.check(config, 'user-1', 'flow-a');

      // Queue a request
      const queuedPromise = limiter.check(config, 'user-1', 'flow-a');

      // Advance past the queue timeout
      vi.advanceTimersByTime(5001);

      await expect(queuedPromise).rejects.toThrow(EngineError);
      await expect(queuedPromise).rejects.toThrow(/timeout/i);

      // Queue should be empty after timeout
      expect(limiter.getQueueDepth(config.name)).toBe(0);
    });

    it('should use default queueTimeoutMs of 30000 when not specified', async () => {
      const config = makeConfig({
        limit: 1,
        windowMs: 60000,
        behavior: 'queue',
        // queueTimeoutMs not specified — default 30000
      });

      await limiter.check(config, 'user-1', 'flow-a');
      const queuedPromise = limiter.check(config, 'user-1', 'flow-a');

      // Not timed out at 29s
      vi.advanceTimersByTime(29000);
      expect(limiter.getQueueDepth(config.name)).toBe(1);

      // Timed out at 30s+
      vi.advanceTimersByTime(1001);
      await expect(queuedPromise).rejects.toThrow(EngineError);
    });
  });

  // ── releaseQueued (removeRateLimit) ──

  describe('releaseQueued', () => {
    it('should resolve all queued requests when called', async () => {
      const config = makeConfig({
        limit: 1,
        windowMs: 60000,
        behavior: 'queue',
        queueTimeoutMs: 30000,
      });

      await limiter.check(config, 'user-1', 'flow-a');

      const results: boolean[] = [];

      const p1 = limiter
        .check(config, 'user-1', 'flow-a')
        .then((r) => results.push(r.allowed));
      const p2 = limiter
        .check(config, 'user-1', 'flow-a')
        .then((r) => results.push(r.allowed));

      expect(limiter.getQueueDepth(config.name)).toBe(2);

      // Release all queued
      limiter.releaseQueued(config.name);

      await Promise.all([p1, p2]);

      expect(results).toEqual([true, true]);
      expect(limiter.getQueueDepth(config.name)).toBe(0);
    });

    it('should be a no-op when no queue exists for the config name', () => {
      // Should not throw
      limiter.releaseQueued('nonexistent-config');
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('should handle limit of 1', () => {
      const config = makeConfig({ limit: 1 });

      const r1 = limiter.checkSync(config, 'user-1', 'flow-a');
      expect(r1.allowed).toBe(true);

      const r2 = limiter.checkSync(config, 'user-1', 'flow-a');
      expect(r2.allowed).toBe(false);
    });

    it('should default behavior to reject when not specified', async () => {
      const config = makeConfig({ limit: 1 });
      delete (config as any).behavior;

      await limiter.check(config, 'user-1', 'flow-a');
      await expect(
        limiter.check(config, 'user-1', 'flow-a'),
      ).rejects.toThrow(EngineError);
    });

    it('should return currentCount accurately', () => {
      const config = makeConfig({ limit: 10 });

      for (let i = 0; i < 7; i++) {
        limiter.checkSync(config, 'user-1', 'flow-a');
      }

      expect(limiter.getCurrentCount(config, 'user-1', 'flow-a')).toBe(7);
    });

    it('should handle clear() during active queue', async () => {
      const config = makeConfig({
        limit: 1,
        windowMs: 60000,
        behavior: 'queue',
        queueTimeoutMs: 30000,
      });

      await limiter.check(config, 'user-1', 'flow-a');
      const queuedPromise = limiter.check(config, 'user-1', 'flow-a');

      limiter.clear();

      await expect(queuedPromise).rejects.toThrow(EngineError);
    });

    it('should return 0 for getCurrentCount when no requests recorded', () => {
      const config = makeConfig();
      expect(limiter.getCurrentCount(config, 'user-1', 'flow-a')).toBe(0);
    });

    it('should return 0 for getQueueDepth when no queue exists', () => {
      expect(limiter.getQueueDepth('nonexistent')).toBe(0);
    });
  });
});

// Rate limiter accuracy test
// Per spec SC-002 — rate limiter must enforce limits within +/-5% accuracy
describe('Rate Limiter — Accuracy (SC-002)', () => {
  it('should enforce limit within ±5% accuracy with limit+10 requests', () => {
    const limiter = new RateLimiter();
    const config: RateLimitConfig = {
      name: 'accuracy-test',
      scope: 'global',
      limit: 100,
      windowMs: 60000,
    };

    let allowed = 0;
    let rejected = 0;
    const totalRequests = 110; // limit + 10

    for (let i = 0; i < totalRequests; i++) {
      const result = limiter.checkSync(config, null, 'test-flow');
      if (result.allowed) {
        allowed++;
      } else {
        rejected++;
      }
    }

    // Should allow exactly 100 (the limit)
    expect(allowed).toBe(100);
    // Should reject exactly 10
    expect(rejected).toBe(10);

    // Verify accuracy is within ±5% of limit
    const accuracy = Math.abs(allowed - config.limit) / config.limit;
    expect(accuracy).toBeLessThanOrEqual(0.05);
  });
});
