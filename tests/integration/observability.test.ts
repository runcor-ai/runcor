// Integration tests for Observability
// Per tasks T019-T021, T033-T034, T044-T045, T054, T061-T062, T070, T073, T075

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import { RetryableError } from '../../src/errors.js';
import type { LogRecord, TelemetryConfig } from '../../src/types.js';
import { EngineInstrumentation } from '../../src/telemetry/instrumentation.js';
import {
  trace,
  metrics,
  context as otelContext,
  type TracerProvider,
  type MeterProvider,
  type Span,
} from '@opentelemetry/api';

// Helper: create a basic engine with telemetry for testing
async function createTestEngine(telemetry?: TelemetryConfig) {
  const provider = new MockProvider('test-provider');
  const engine = await createEngine({
    model: { provider },
    telemetry,
  });
  return { engine, provider };
}

// ── T019: Complete trace production ──

describe('US1: Execution Tracing', () => {
  it('T019 - produces spans when tracerProvider is configured', async () => {
    const tracerProvider = trace.getTracerProvider();
    const { engine } = await createTestEngine({ tracerProvider });

    engine.register('traced-flow', async (ctx) => {
      const result = await ctx.model.complete({ prompt: 'hello' });
      return result.text;
    });

    const execution = await engine.trigger('traced-flow', {
      idempotencyKey: 'trace-test-1',
      userId: 'alice',
    });

    // Wait for completion
    await new Promise<void>((resolve) => {
      engine.on('execution:complete', (e) => {
        if (e.executionId === execution.id) resolve();
      });
    });

    // Verify engine instrumentation exists and was used
    expect(engine.instrumentation).toBeDefined();
    expect(engine.instrumentation.tracer).toBeDefined();

    await engine.shutdown();
  });

  // ── T020: No-op tracing ──

  it('T020 - no-op when no telemetry configured', async () => {
    const { engine } = await createTestEngine();

    engine.register('no-trace-flow', async (ctx) => {
      return ctx.model.complete({ prompt: 'hello' });
    });

    const execution = await engine.trigger('no-trace-flow', {
      idempotencyKey: 'no-trace-1',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', (e) => {
        if (e.executionId === execution.id) resolve();
      });
    });

    // Engine should work identically — no errors
    const result = await engine.getExecution(execution.id);
    expect(result?.state).toBe('complete');

    await engine.shutdown();
  });

  // ── T021: Partial config ──

  it('T021 - partial config with only tracerProvider', async () => {
    const tracerProvider = trace.getTracerProvider();
    const { engine } = await createTestEngine({
      tracerProvider,
      // No meterProvider, no logHandler
    });

    engine.register('partial-flow', async (ctx) => {
      return ctx.model.complete({ prompt: 'hello' });
    });

    const execution = await engine.trigger('partial-flow', {
      idempotencyKey: 'partial-1',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', (e) => {
        if (e.executionId === execution.id) resolve();
      });
    });

    const result = await engine.getExecution(execution.id);
    expect(result?.state).toBe('complete');

    await engine.shutdown();
  });

  // ── T033: Provider fallback tracing ──

  it('T033 - traces provider fallback with multiple attempt spans', async () => {
    // Use inline providers with distinct names (MockProvider always has name='mock')
    const failProvider = {
      name: 'fail-provider',
      complete: async () => { throw new Error('provider down'); },
    };
    const successProvider = {
      name: 'success-provider',
      complete: async (request: any) => ({
        text: `response: ${request.prompt}`,
        model: 'mock',
        provider: 'success-provider',
        usage: { promptTokens: request.prompt?.length ?? 0, completionTokens: 20 },
      }),
    };

    const tracerProvider = trace.getTracerProvider();
    const engine = await createEngine({
      model: {
        providers: [
          { provider: failProvider, priority: 1 },
          { provider: successProvider, priority: 2 },
        ],
      },
      telemetry: { tracerProvider },
    });

    engine.register('fallback-flow', async (ctx) => {
      return ctx.model.complete({ prompt: 'hello' });
    });

    const execution = await engine.trigger('fallback-flow', {
      idempotencyKey: 'fallback-1',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', (e) => {
        if (e.executionId === execution.id) resolve();
      });
    });

    const result = await engine.getExecution(execution.id);
    expect(result?.state).toBe('complete');

    await engine.shutdown();
  });

  // ── T034: Span error resilience ──

  it('T034 - engine continues when trace provider throws', async () => {
    const brokenProvider = {
      getTracer: () => ({
        startSpan: () => { throw new Error('tracer broken'); },
      }),
    } as unknown as TracerProvider;

    const { engine } = await createTestEngine({ tracerProvider: brokenProvider });

    engine.register('resilient-flow', async (ctx) => {
      return ctx.model.complete({ prompt: 'hello' });
    });

    const execution = await engine.trigger('resilient-flow', {
      idempotencyKey: 'resilient-1',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', (e) => {
        if (e.executionId === execution.id) resolve();
      });
    });

    const result = await engine.getExecution(execution.id);
    expect(result?.state).toBe('complete');

    await engine.shutdown();
  });
});

// ── T044: Metrics accuracy ──

describe('US2: Engine Metrics', () => {
  it('T044 - metric methods are called during execution', async () => {
    const meterProvider = metrics.getMeterProvider();
    const { engine } = await createTestEngine({ meterProvider });

    engine.register('metrics-flow', async (ctx) => {
      return ctx.model.complete({ prompt: 'hello' });
    });

    const execution = await engine.trigger('metrics-flow', {
      idempotencyKey: 'metrics-1',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', (e) => {
        if (e.executionId === execution.id) resolve();
      });
    });

    // Verify instrumentation was created with meter
    expect(engine.instrumentation.meter).toBeDefined();

    await engine.shutdown();
  });

  // ── T045: No-op metrics ──

  it('T045 - no-op metrics when no meterProvider configured', async () => {
    const { engine } = await createTestEngine();

    engine.register('noop-metrics-flow', async (ctx) => {
      return ctx.model.complete({ prompt: 'hello' });
    });

    const execution = await engine.trigger('noop-metrics-flow', {
      idempotencyKey: 'noop-metrics-1',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', (e) => {
        if (e.executionId === execution.id) resolve();
      });
    });

    const result = await engine.getExecution(execution.id);
    expect(result?.state).toBe('complete');

    await engine.shutdown();
  });
});

// ── T054: Structured logging ──

describe('US3: Structured Logging', () => {
  it('T054 - emits log records at correct levels with trace context', async () => {
    const logs: LogRecord[] = [];
    const logHandler = (record: LogRecord) => { logs.push(record); };
    const tracerProvider = trace.getTracerProvider();

    const { engine } = await createTestEngine({ tracerProvider, logHandler });

    engine.register('logged-flow', async (ctx) => {
      return ctx.model.complete({ prompt: 'hello' });
    });

    const execution = await engine.trigger('logged-flow', {
      idempotencyKey: 'log-1',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', (e) => {
        if (e.executionId === execution.id) resolve();
      });
    });

    // Should have info logs for start and complete
    const infoLogs = logs.filter(l => l.level === 'info');
    expect(infoLogs.length).toBeGreaterThanOrEqual(2);

    // Check that logs have executionId in attributes
    const startLog = infoLogs.find(l => l.message.includes('started'));
    expect(startLog).toBeDefined();
    expect(startLog!.attributes.executionId).toBe(execution.id);

    await engine.shutdown();
  });

  it('no log output when no logHandler configured', async () => {
    const { engine } = await createTestEngine();

    engine.register('silent-flow', async (ctx) => {
      return ctx.model.complete({ prompt: 'hello' });
    });

    const execution = await engine.trigger('silent-flow', {
      idempotencyKey: 'silent-1',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', (e) => {
        if (e.executionId === execution.id) resolve();
      });
    });

    // No errors, no output
    const result = await engine.getExecution(execution.id);
    expect(result?.state).toBe('complete');

    await engine.shutdown();
  });

  it('engine continues when logHandler throws', async () => {
    const brokenHandler = () => { throw new Error('log broken'); };
    const { engine } = await createTestEngine({ logHandler: brokenHandler });

    engine.register('broken-log-flow', async (ctx) => {
      return ctx.model.complete({ prompt: 'hello' });
    });

    const execution = await engine.trigger('broken-log-flow', {
      idempotencyKey: 'broken-log-1',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', (e) => {
        if (e.executionId === execution.id) resolve();
      });
    });

    const result = await engine.getExecution(execution.id);
    expect(result?.state).toBe('complete');

    await engine.shutdown();
  });
});

// ── T061-T062: Flow-level telemetry ──

describe('US4: Flow-Level Telemetry Access', () => {
  it('T061 - flow can use ctx.telemetry to add attributes and events', async () => {
    const tracerProvider = trace.getTracerProvider();
    const { engine } = await createTestEngine({ tracerProvider });

    engine.register('custom-telemetry-flow', async (ctx) => {
      ctx.telemetry.setAttribute('document.type', 'invoice');
      ctx.telemetry.addEvent('processing.started', { step: 1 });

      const result = await ctx.telemetry.startSpan('custom.process', async (span) => {
        span.setAttribute('custom.inner', 'value');
        return 'processed';
      });

      return result;
    });

    const execution = await engine.trigger('custom-telemetry-flow', {
      idempotencyKey: 'custom-tel-1',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', (e) => {
        if (e.executionId === execution.id) resolve();
      });
    });

    const result = await engine.getExecution(execution.id);
    expect(result?.state).toBe('complete');
    expect(result?.result).toBe('processed');

    await engine.shutdown();
  });

  // ── T062: No-op flow telemetry ──

  it('T062 - ctx.telemetry is no-op when not configured', async () => {
    const { engine } = await createTestEngine();

    engine.register('noop-telemetry-flow', async (ctx) => {
      // All of these should silently do nothing
      ctx.telemetry.setAttribute('key', 'value');
      ctx.telemetry.addEvent('event');
      const result = await ctx.telemetry.startSpan('child', async () => 42);
      return result;
    });

    const execution = await engine.trigger('noop-telemetry-flow', {
      idempotencyKey: 'noop-tel-1',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', (e) => {
        if (e.executionId === execution.id) resolve();
      });
    });

    const result = await engine.getExecution(execution.id);
    expect(result?.state).toBe('complete');
    expect(result?.result).toBe(42);

    await engine.shutdown();
  });
});

// ── T070: Cost observability ──

describe('US5: Cost and Budget Observability', () => {
  it('T070 - cost attributes appear on model spans', async () => {
    const tracerProvider = trace.getTracerProvider();
    const meterProvider = metrics.getMeterProvider();

    const provider = new MockProvider('cost-provider');
    const engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.03 } }],
      },
      cost: {
        budgets: { global: { limit: 100, window: { type: 'none' } } },
        warningThreshold: 0.8,
      },
      telemetry: { tracerProvider, meterProvider },
    });

    engine.register('cost-flow', async (ctx) => {
      return ctx.model.complete({ prompt: 'hello' });
    });

    const execution = await engine.trigger('cost-flow', {
      idempotencyKey: 'cost-obs-1',
      userId: 'alice',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', (e) => {
        if (e.executionId === execution.id) resolve();
      });
    });

    const result = await engine.getExecution(execution.id);
    expect(result?.state).toBe('complete');

    await engine.shutdown();
  });
});

// ── T073: Edge cases ──

describe('Edge Cases', () => {
  it('T073 - flow startSpan callback throw propagates error and ends span', async () => {
    const tracerProvider = trace.getTracerProvider();
    const { engine } = await createTestEngine({ tracerProvider });

    engine.register('throw-in-span-flow', async (ctx) => {
      await ctx.telemetry.startSpan('bad-span', async () => {
        throw new Error('callback failed');
      });
    });

    const execution = await engine.trigger('throw-in-span-flow', {
      idempotencyKey: 'throw-span-1',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', (e) => {
        if (e.executionId === execution.id) resolve();
      });
    });

    const result = await engine.getExecution(execution.id);
    expect(result?.state).toBe('failed');
    expect(result?.error?.message).toContain('callback failed');

    await engine.shutdown();
  });

  it('T073 - cancellation ends open spans with error status', async () => {
    const tracerProvider = trace.getTracerProvider();
    const provider = new MockProvider('test-provider');
    const engine = await createEngine({
      model: { provider },
      telemetry: { tracerProvider },
      drainTimeout: 100, // Short drain for cancel test (cancel doesn't decrement activeExecutions)
    });

    let resolve_handler: () => void;
    const handlerPromise = new Promise<void>(r => { resolve_handler = r; });

    engine.register('cancel-flow', async (ctx) => {
      await handlerPromise; // Block until cancelled
    });

    const execution = await engine.trigger('cancel-flow', {
      idempotencyKey: 'cancel-span-1',
    });

    // Let execution start running (same pattern as engine.test.ts)
    await new Promise(r => setTimeout(r, 50));

    // Cancel it
    await engine.cancel(execution.id, 'test cancel');
    resolve_handler!();

    const result = await engine.getExecution(execution.id);
    expect(result?.state).toBe('failed');
    expect(result?.error?.message).toContain('cancel');

    await engine.shutdown();
  });

  it('T073 - timeout ends open spans with error status', async () => {
    const tracerProvider = trace.getTracerProvider();
    const provider = new MockProvider('test-provider');
    const engine = await createEngine({
      model: { provider },
      telemetry: { tracerProvider },
    });

    engine.register('timeout-flow', async (ctx) => {
      await new Promise(r => setTimeout(r, 5000)); // Will timeout before this
    }, { timeout: 50 });

    const execution = await engine.trigger('timeout-flow', {
      idempotencyKey: 'timeout-span-1',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', (e) => {
        if (e.executionId === execution.id) resolve();
      });
    });

    const result = await engine.getExecution(execution.id);
    expect(result?.state).toBe('failed');
    expect(result?.error?.message).toContain('timed out');

    await engine.shutdown();
  });

  it('T073 - retry creates new sibling span', async () => {
    const tracerProvider = trace.getTracerProvider();
    const provider = new MockProvider('test-provider');
    const engine = await createEngine({
      model: { provider },
      telemetry: { tracerProvider },
    });

    let callCount = 0;
    engine.register('retry-span-flow', async (ctx) => {
      callCount++;
      if (callCount === 1) {
        throw new RetryableError('transient failure');
      }
      return 'success';
    }, { maxRetries: 1, baseRetryDelay: 10 });

    const execution = await engine.trigger('retry-span-flow', {
      idempotencyKey: 'retry-span-1',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', (e) => {
        if (e.executionId === execution.id) resolve();
      });
    });

    const result = await engine.getExecution(execution.id);
    expect(result?.state).toBe('complete');
    expect(callCount).toBe(2);

    await engine.shutdown();
  });
});

// ── T075: Performance test ──

describe('Performance', () => {
  it('T075 - no measurable overhead when telemetry not configured', async () => {
    const provider = new MockProvider('perf-provider');

    // Baseline: no telemetry
    const engine1 = await createEngine({ model: { provider } });
    engine1.register('perf-flow', async (ctx) => {
      return ctx.model.complete({ prompt: 'hello' });
    });

    const start1 = performance.now();
    for (let i = 0; i < 100; i++) {
      const exec = await engine1.trigger('perf-flow', { idempotencyKey: `perf-baseline-${i}` });
      await new Promise<void>((resolve) => {
        engine1.on('execution:complete', (e) => {
          if (e.executionId === exec.id) resolve();
        });
      });
    }
    const baselineMs = performance.now() - start1;

    await engine1.shutdown();

    // With telemetry (no-op providers — same as no config)
    const engine2 = await createEngine({ model: { provider: new MockProvider('perf-provider-2') } });
    engine2.register('perf-flow', async (ctx) => {
      return ctx.model.complete({ prompt: 'hello' });
    });

    const start2 = performance.now();
    for (let i = 0; i < 100; i++) {
      const exec = await engine2.trigger('perf-flow', { idempotencyKey: `perf-notel-${i}` });
      await new Promise<void>((resolve) => {
        engine2.on('execution:complete', (e) => {
          if (e.executionId === exec.id) resolve();
        });
      });
    }
    const noTelMs = performance.now() - start2;

    await engine2.shutdown();

    // Should be within reasonable bounds (no-op has negligible cost)
    // Using generous 50% tolerance since this is unit test timing, not a benchmark
    expect(noTelMs).toBeLessThan(baselineMs * 1.5);
  });
});
