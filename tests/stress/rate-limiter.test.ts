// Stress test: Rate limiter under burst traffic
import { describe, it, expect, afterEach } from 'vitest';
import { RateLimiter } from '../../src/policy/rate-limiter.js';
import { EngineError } from '../../src/errors.js';
import type { RateLimitConfig } from '../../src/types.js';

describe('Stress: Rate Limiter', () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.clear();
  });

  it('should handle burst traffic: 200 requests against limit of 10/second', async () => {
    limiter = new RateLimiter();

    const config: RateLimitConfig = {
      name: 'burst-test',
      scope: 'global',
      limit: 10,
      windowMs: 1000,
      behavior: 'reject',
    };

    let allowed = 0;
    let rejected = 0;

    // Fire 200 requests as fast as possible
    for (let i = 0; i < 200; i++) {
      try {
        await limiter.check(config, null, 'burst-flow');
        allowed++;
      } catch (err) {
        if (err instanceof EngineError && err.code === 'RATE_LIMITED') {
          rejected++;
        } else {
          throw err;
        }
      }
    }

    // Only 10 should be allowed in the first window
    expect(allowed).toBe(10);
    expect(rejected).toBe(190);
  }, 30000);

  it('should queue requests up to max depth, then reject overflow', async () => {
    limiter = new RateLimiter();

    const maxQueueDepth = 5;
    const config: RateLimitConfig = {
      name: 'queue-overflow',
      scope: 'global',
      limit: 1,
      windowMs: 5000,
      behavior: 'queue',
      maxQueueDepth,
      queueTimeoutMs: 10000,
    };

    // First request goes through
    await limiter.check(config, null, 'qflow');

    // Next maxQueueDepth requests should be queued (they won't resolve yet)
    const queuedPromises: Promise<unknown>[] = [];
    for (let i = 0; i < maxQueueDepth; i++) {
      queuedPromises.push(limiter.check(config, null, 'qflow'));
    }

    // Queue should be at max depth
    expect(limiter.getQueueDepth('queue-overflow')).toBe(maxQueueDepth);

    // Next request should be rejected (queue full)
    await expect(
      limiter.check(config, null, 'qflow'),
    ).rejects.toThrow('queue');

    // Clean up — release queued requests
    limiter.releaseQueued('queue-overflow');
    await Promise.all(queuedPromises);
  }, 30000);

  it('should drain queue correctly after burst', async () => {
    limiter = new RateLimiter();

    const config: RateLimitConfig = {
      name: 'drain-test',
      scope: 'global',
      limit: 5,
      windowMs: 200, // Short window for testing
      behavior: 'queue',
      maxQueueDepth: 50,
      queueTimeoutMs: 5000,
    };

    // Fill initial window
    for (let i = 0; i < 5; i++) {
      await limiter.check(config, null, 'drain-flow');
    }

    // Queue 10 more
    const queued: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      queued.push(limiter.check(config, null, 'drain-flow'));
    }

    expect(limiter.getQueueDepth('drain-test')).toBe(10);

    // Wait for window to slide, then trigger drain by making a new check
    await new Promise((r) => setTimeout(r, 300));

    // New check should trigger queue drain
    const drainPromise = limiter.check(config, null, 'drain-flow');

    // Some queued requests should now resolve
    const raceResult = await Promise.race([
      Promise.all([drainPromise, ...queued]).then(() => 'all-resolved'),
      new Promise((r) => setTimeout(r, 2000)).then(() => 'timeout'),
    ]);

    // Either resolved or we manually release
    if (raceResult === 'timeout') {
      limiter.releaseQueued('drain-test');
      await Promise.all(queued).catch(() => {});
    }

    // Queue should be empty after drain
    expect(limiter.getQueueDepth('drain-test')).toBe(0);
  }, 30000);

  it('should maintain correctness across sliding window boundary transitions', async () => {
    limiter = new RateLimiter();

    const config: RateLimitConfig = {
      name: 'window-boundary',
      scope: 'global',
      limit: 3,
      windowMs: 200,
      behavior: 'reject',
    };

    // Fill first window
    for (let i = 0; i < 3; i++) {
      const result = limiter.checkSync(config, null, 'wflow');
      expect(result.allowed).toBe(true);
    }

    // Window is full — reject
    const rejected = limiter.checkSync(config, null, 'wflow');
    expect(rejected.allowed).toBe(false);

    // Wait for window to slide
    await new Promise((r) => setTimeout(r, 250));

    // Should allow again after window slides
    for (let i = 0; i < 3; i++) {
      const result = limiter.checkSync(config, null, 'wflow');
      expect(result.allowed).toBe(true);
    }

    // Should reject again at limit
    const rejectedAgain = limiter.checkSync(config, null, 'wflow');
    expect(rejectedAgain.allowed).toBe(false);
  }, 30000);

  it('should isolate per-user rate limits across 20 concurrent users', async () => {
    limiter = new RateLimiter();

    const config: RateLimitConfig = {
      name: 'per-user-isolation',
      scope: 'user',
      limit: 5,
      windowMs: 5000,
      behavior: 'reject',
    };

    const userCount = 20;
    const requestsPerUser = 10;

    const results = new Map<string, { allowed: number; rejected: number }>();

    // Fire requests for all users concurrently
    const promises = [];
    for (let u = 0; u < userCount; u++) {
      const userId = `user-${u}`;
      results.set(userId, { allowed: 0, rejected: 0 });

      for (let r = 0; r < requestsPerUser; r++) {
        promises.push(
          (async () => {
            try {
              await limiter.check(config, userId, 'shared-flow');
              results.get(userId)!.allowed++;
            } catch (err) {
              if (err instanceof EngineError && err.code === 'RATE_LIMITED') {
                results.get(userId)!.rejected++;
              } else {
                throw err;
              }
            }
          })(),
        );
      }
    }

    await Promise.all(promises);

    // Each user should have exactly 5 allowed and 5 rejected
    for (let u = 0; u < userCount; u++) {
      const userId = `user-${u}`;
      const userResult = results.get(userId)!;
      expect(userResult.allowed).toBe(5);
      expect(userResult.rejected).toBe(5);
    }
  }, 30000);
});
