// Rate limiter — sliding window log algorithm with queue management

import type {
  RateLimitConfig,
  RateLimitEntry,
  RateLimitQueueEntry,
} from '../types.js';
import { EngineError } from '../errors.js';

/** Result of a synchronous rate limit check */
export interface RateLimitCheckResult {
  allowed: boolean;
  currentCount: number;
  configName: string;
}

/**
 * In-memory sliding window log rate limiter.
 *
 * Algorithm: stores request timestamps in an array per scope key.
 * On each request: evict timestamps outside the window, count remaining,
 * compare to limit. Lazy eviction keeps memory bounded without background timers.
 *
 * Key convention: `ratelimit:{scope}:{identifier}`
 *   - user scope: identifier = userId
 *   - flow scope: identifier = flowName (or '*' if config.flowName not set)
 *   - global scope: identifier = 'global'
 */
export class RateLimiter {
  /** Sliding window timestamp logs, keyed by rate limit key */
  private readonly entries = new Map<string, RateLimitEntry>();

  /** Queued requests per config name, keyed by config name */
  private readonly queues = new Map<string, RateLimitQueueEntry[]>();

  /**
   * Build the rate limit key for a given config, userId, and flowName.
   *
   * Key convention: `ratelimit:{scope}:{identifier}`
   *   - user scope: identifier = userId
   *   - flow scope: identifier = config.flowName ?? flowName (or '*' if neither set)
   *   - global scope: identifier = 'global'
   */
  private buildKey(
    config: RateLimitConfig,
    userId: string | null,
    flowName: string,
  ): string {
    switch (config.scope) {
      case 'user':
        return `ratelimit:user:${userId ?? 'anonymous'}`;
      case 'flow': {
        // If config has a flowName set, use that (shared counter across invocations).
        // If config.flowName is null/undefined, use the runtime flowName (separate per flow).
        const flowId = config.flowName ?? flowName ?? '*';
        return `ratelimit:flow:${flowId}`;
      }
      case 'global':
        return `ratelimit:global:global`;
      default:
        return `ratelimit:unknown:unknown`;
    }
  }

  /**
   * Evict timestamps outside the sliding window and return the remaining count.
   * This is the core of the sliding window log algorithm.
   */
  private evictAndCount(key: string, windowMs: number, now: number): number {
    const entry = this.entries.get(key);
    if (!entry) {
      return 0;
    }

    const windowStart = now - windowMs;

    // Remove timestamps outside the window (lazy eviction)
    entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);

    if (entry.timestamps.length === 0) {
      this.entries.delete(key);
      return 0;
    }

    return entry.timestamps.length;
  }

  /**
   * Record a timestamp for a successful request.
   */
  private recordTimestamp(key: string, now: number): void {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, timestamps: [] };
      this.entries.set(key, entry);
    }
    entry.timestamps.push(now);
  }

  /**
   * Synchronous rate limit check. Returns whether the request is allowed
   * without queuing or throwing. Records the timestamp if allowed.
   */
  checkSync(
    config: RateLimitConfig,
    userId: string | null,
    flowName: string,
  ): RateLimitCheckResult {
    const now = Date.now();
    const key = this.buildKey(config, userId, flowName);
    const currentCount = this.evictAndCount(key, config.windowMs, now);

    if (currentCount >= config.limit) {
      return {
        allowed: false,
        currentCount,
        configName: config.name,
      };
    }

    // Record the new request timestamp
    this.recordTimestamp(key, now);

    return {
      allowed: true,
      currentCount: currentCount + 1,
      configName: config.name,
    };
  }

  /**
   * Check rate limit for a request.
   *
   * - behavior 'reject' (default): throws EngineError with code RATE_LIMITED when exceeded
   * - behavior 'queue': returns a Promise that resolves when capacity opens (FIFO)
   *
   * @returns Promise that resolves with check result when request is allowed
   * @throws EngineError with code RATE_LIMITED when exceeded and behavior is 'reject'
   */
  async check(
    config: RateLimitConfig,
    userId: string | null,
    flowName: string,
  ): Promise<RateLimitCheckResult> {
    const behavior = config.behavior ?? 'reject';
    const result = this.checkSync(config, userId, flowName);

    if (result.allowed) {
      // Also try to drain any queued requests for this config
      this.drainQueue(config, userId, flowName);
      return result;
    }

    // Not allowed — decide based on behavior
    if (behavior === 'reject') {
      throw new EngineError(
        `Rate limit "${config.name}" exceeded: ${result.currentCount}/${config.limit} requests in ${config.windowMs}ms window`,
        'RATE_LIMITED',
      );
    }

    // behavior === 'queue' — enqueue the request
    return this.enqueue(config, userId, flowName);
  }

  /**
   * Check multiple rate limit configs. Returns the most restrictive result.
   * If any config rejects, throws. If any config queues, waits for all.
   */
  async checkMultiple(
    configs: RateLimitConfig[],
    userId: string | null,
    flowName: string,
  ): Promise<RateLimitCheckResult> {
    // Check all configs synchronously first to find the most restrictive
    const results: RateLimitCheckResult[] = [];

    for (const config of configs) {
      const result = this.checkSync(config, userId, flowName);
      results.push(result);
    }

    // If all allowed, return the one with highest utilization (most restrictive)
    const allAllowed = results.every((r) => r.allowed);
    if (allAllowed) {
      // Return the result with the highest current count ratio
      let mostRestrictive = results[0];
      let highestRatio = 0;
      for (let i = 0; i < results.length; i++) {
        const ratio = results[i].currentCount / configs[i].limit;
        if (ratio > highestRatio) {
          highestRatio = ratio;
          mostRestrictive = results[i];
        }
      }
      return mostRestrictive;
    }

    // Some are not allowed — we need to undo the ones that were recorded
    // and then apply the normal check logic per config
    for (let i = 0; i < results.length; i++) {
      if (results[i].allowed) {
        // Undo the recorded timestamp
        const key = this.buildKey(configs[i], userId, flowName);
        const entry = this.entries.get(key);
        if (entry) {
          entry.timestamps.pop();
          if (entry.timestamps.length === 0) {
            this.entries.delete(key);
          }
        }
      }
    }

    // Find the first non-allowed config and apply its behavior
    for (let i = 0; i < results.length; i++) {
      if (!results[i].allowed) {
        // Delegate to the normal check method which handles reject/queue
        return this.check(configs[i], userId, flowName);
      }
    }

    // Should not reach here
    return results[0];
  }

  /**
   * Enqueue a request that exceeded the rate limit.
   * Returns a Promise that resolves when capacity becomes available.
   */
  private enqueue(
    config: RateLimitConfig,
    userId: string | null,
    flowName: string,
  ): Promise<RateLimitCheckResult> {
    const maxQueueDepth = config.maxQueueDepth ?? 100;
    const queueTimeoutMs = config.queueTimeoutMs ?? 30000;

    let queue = this.queues.get(config.name);
    if (!queue) {
      queue = [];
      this.queues.set(config.name, queue);
    }

    // Enforce max queue depth
    if (queue.length >= maxQueueDepth) {
      throw new EngineError(
        `Rate limit queue "${config.name}" is full: ${queue.length}/${maxQueueDepth}`,
        'RATE_LIMITED',
      );
    }

    return new Promise<RateLimitCheckResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this entry from the queue on timeout
        const idx = queue!.indexOf(entry);
        if (idx !== -1) {
          queue!.splice(idx, 1);
        }
        reject(
          new EngineError(
            `Rate limit queue timeout for "${config.name}" after ${queueTimeoutMs}ms`,
            'RATE_LIMITED',
          ),
        );
      }, queueTimeoutMs);

      const entry: RateLimitQueueEntry = {
        resolve: () => {
          clearTimeout(timer);
          // Record the timestamp for this dequeued request
          const now = Date.now();
          const key = this.buildKey(config, userId, flowName);
          this.recordTimestamp(key, now);
          const currentCount = this.evictAndCount(key, config.windowMs, now);
          resolve({
            allowed: true,
            currentCount,
            configName: config.name,
          });
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
        enqueuedAt: Date.now(),
      };

      queue!.push(entry);
    });
  }

  /**
   * Try to drain queued requests for a config when capacity may have opened up.
   * Checks the sliding window and releases the oldest queued request if under limit.
   */
  private drainQueue(
    config: RateLimitConfig,
    userId: string | null,
    flowName: string,
  ): void {
    const queue = this.queues.get(config.name);
    if (!queue || queue.length === 0) {
      return;
    }

    const now = Date.now();
    const key = this.buildKey(config, userId, flowName);

    // Keep releasing while under the limit and queue is not empty
    while (queue.length > 0) {
      const currentCount = this.evictAndCount(key, config.windowMs, now);
      if (currentCount >= config.limit) {
        break;
      }

      // FIFO — release the oldest entry
      const entry = queue.shift()!;
      entry.resolve();
    }

    // Clean up empty queues
    if (queue.length === 0) {
      this.queues.delete(config.name);
    }
  }

  /**
   * Release all queued requests for a config name.
   * Called when a rate limit is removed (removeRateLimit).
   * All queued requests are resolved immediately.
   */
  releaseQueued(configName: string): void {
    const queue = this.queues.get(configName);
    if (!queue) {
      return;
    }

    // Resolve all queued entries
    while (queue.length > 0) {
      const entry = queue.shift()!;
      entry.resolve();
    }

    this.queues.delete(configName);
  }

  /**
   * Clear all entries and queues. Queued requests are rejected.
   * Used for cleanup/testing.
   */
  clear(): void {
    this.entries.clear();

    for (const [name, queue] of this.queues) {
      for (const entry of queue) {
        clearTimeout(entry.timer);
        entry.reject(
          new EngineError(
            `Rate limiter cleared — queue "${name}" flushed`,
            'RATE_LIMITED',
          ),
        );
      }
    }
    this.queues.clear();
  }

  /**
   * Get the current count for a specific config/user/flow combination
   * without recording a new timestamp. Useful for monitoring.
   */
  getCurrentCount(
    config: RateLimitConfig,
    userId: string | null,
    flowName: string,
  ): number {
    const now = Date.now();
    const key = this.buildKey(config, userId, flowName);
    return this.evictAndCount(key, config.windowMs, now);
  }

  /**
   * Get the current queue depth for a config name.
   */
  getQueueDepth(configName: string): number {
    const queue = this.queues.get(configName);
    return queue ? queue.length : 0;
  }
}
