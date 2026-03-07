// Stress test: Throughput — baseline performance under sustained load
import { describe, it, expect, afterEach } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import type { Runcor } from '../../src/engine.js';

describe('Stress: Throughput', () => {
  let engine: Runcor;

  afterEach(async () => {
    await engine?.shutdown();
  });

  it('should measure executions/second at concurrency 1, 10, 50, 100', async () => {
    const results: Array<{ concurrency: number; opsPerSec: number }> = [];
    const runsPerLevel = 200;

    for (const concurrency of [1, 10, 50, 100]) {
      engine = await createEngine({
        model: { provider: new MockProvider() },
        concurrency,
      });

      engine.register('fast', async () => 'ok', { maxRetries: 0, timeout: 0 });

      let completed = 0;
      const allDone = new Promise<void>((resolve) => {
        engine.on('execution:complete', () => {
          completed++;
          if (completed >= runsPerLevel) resolve();
        });
      });

      const start = performance.now();
      for (let i = 0; i < runsPerLevel; i++) {
        await engine.trigger('fast', { idempotencyKey: `tp-${concurrency}-${i}` });
      }
      await allDone;
      const elapsed = performance.now() - start;

      results.push({
        concurrency,
        opsPerSec: Math.round((runsPerLevel / elapsed) * 1000),
      });

      await engine.shutdown();
    }

    // All concurrency levels should complete successfully
    for (const r of results) {
      expect(r.opsPerSec).toBeGreaterThan(0);
    }

    // Higher concurrency should not be dramatically slower than lower
    // (within same order of magnitude)
    expect(results[3].opsPerSec).toBeGreaterThan(results[0].opsPerSec / 10);
  }, 30000);

  it('should maintain stable latency percentiles (p50, p95, p99) under sustained load', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 50,
    });

    engine.register('latency-test', async () => 'ok', { maxRetries: 0, timeout: 0 });

    const latencies: number[] = [];
    const count = 500;

    let completed = 0;
    const allDone = new Promise<void>((resolve) => {
      engine.on('execution:complete', () => {
        completed++;
        if (completed >= count) resolve();
      });
    });

    for (let i = 0; i < count; i++) {
      const start = performance.now();
      await engine.trigger('latency-test', { idempotencyKey: `lat-${i}` });
      latencies.push(performance.now() - start);
    }

    await allDone;

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(count * 0.5)];
    const p95 = latencies[Math.floor(count * 0.95)];
    const p99 = latencies[Math.floor(count * 0.99)];

    // Trigger latency should be sub-100ms for in-memory mock operations
    expect(p50).toBeLessThan(50);
    expect(p95).toBeLessThan(100);
    expect(p99).toBeLessThan(200);
  }, 30000);

  it('should show no degradation over 1000+ sequential executions', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 1,
    });

    engine.register('seq', async () => 'ok', { maxRetries: 0, timeout: 0 });

    const count = 1000;
    const batchSize = 100;
    const batchTimes: number[] = [];

    let completed = 0;
    const allDone = new Promise<void>((resolve) => {
      engine.on('execution:complete', () => {
        completed++;
        if (completed >= count) resolve();
      });
    });

    for (let batch = 0; batch < count / batchSize; batch++) {
      const batchStart = performance.now();
      for (let i = 0; i < batchSize; i++) {
        const idx = batch * batchSize + i;
        await engine.trigger('seq', { idempotencyKey: `seq-${idx}` });
      }
      batchTimes.push(performance.now() - batchStart);
    }

    await allDone;

    // Last batch should not be more than 3x slower than first batch
    const firstBatch = batchTimes[0];
    const lastBatch = batchTimes[batchTimes.length - 1];
    expect(lastBatch).toBeLessThan(firstBatch * 3);
  }, 30000);

  it('should handle mixed flow types (fast/medium/slow handlers) under load', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      concurrency: 50,
    });

    engine.register('fast-flow', async () => 'fast', { maxRetries: 0, timeout: 0 });
    engine.register('medium-flow', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 'medium';
    }, { maxRetries: 0, timeout: 5000 });
    engine.register('slow-flow', async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 'slow';
    }, { maxRetries: 0, timeout: 5000 });

    const total = 150;
    const flows = ['fast-flow', 'medium-flow', 'slow-flow'];

    let completed = 0;
    const allDone = new Promise<void>((resolve) => {
      engine.on('execution:complete', () => {
        completed++;
        if (completed >= total) resolve();
      });
    });

    const executions = [];
    for (let i = 0; i < total; i++) {
      const flowName = flows[i % 3];
      const exec = await engine.trigger(flowName, { idempotencyKey: `mix-${i}` });
      executions.push(exec);
    }

    await allDone;

    // Small settle delay
    await new Promise((r) => setTimeout(r, 100));

    // Verify all completed with correct results
    let fastCount = 0;
    let medCount = 0;
    let slowCount = 0;
    for (const exec of executions) {
      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');
      if (final!.result === 'fast') fastCount++;
      else if (final!.result === 'medium') medCount++;
      else if (final!.result === 'slow') slowCount++;
    }

    expect(fastCount).toBe(50);
    expect(medCount).toBe(50);
    expect(slowCount).toBe(50);
  }, 30000);
});
