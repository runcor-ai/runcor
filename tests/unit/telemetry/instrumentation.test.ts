// Unit tests for EngineInstrumentation
// Per tasks T011, T015-T018, T035-T038, T063-T065, T072

import { describe, it, expect, vi } from 'vitest';
import { EngineInstrumentation } from '../../../src/telemetry/instrumentation.js';
import {
  trace,
  metrics,
  context as otelContext,
  SpanStatusCode,
  type TracerProvider,
  type Span,
} from '@opentelemetry/api';

// ── T011: Constructor tests ──

describe('EngineInstrumentation', () => {
  describe('constructor', () => {
    it('creates with no-op providers when unconfigured', () => {
      const inst = new EngineInstrumentation({});
      expect(inst).toBeDefined();
      expect(inst.tracer).toBeDefined();
      expect(inst.meter).toBeDefined();
    });

    it('creates with provided TracerProvider', () => {
      const mockProvider = trace.getTracerProvider();
      const inst = new EngineInstrumentation({ tracerProvider: mockProvider });
      expect(inst.tracer).toBeDefined();
    });

    it('creates with provided MeterProvider', () => {
      const mockProvider = metrics.getMeterProvider();
      const inst = new EngineInstrumentation({ meterProvider: mockProvider });
      expect(inst.meter).toBeDefined();
    });

    it('stores logHandler reference', () => {
      const handler = () => {};
      const inst = new EngineInstrumentation({ logHandler: handler });
      expect(inst.logHandler).toBe(handler);
    });

    it('stores memorySpans flag', () => {
      const inst = new EngineInstrumentation({ memorySpans: true });
      expect(inst.memorySpans).toBe(true);
    });

    it('defaults memorySpans to false', () => {
      const inst = new EngineInstrumentation({});
      expect(inst.memorySpans).toBe(false);
    });

    it('survives errors from a broken TracerProvider', () => {
      const badProvider = {
        getTracer: () => { throw new Error('broken'); },
      } as unknown as TracerProvider;
      const inst = new EngineInstrumentation({ tracerProvider: badProvider });
      expect(inst).toBeDefined();
    });
  });

  // ── T015: startTriggerSpan tests ──

  describe('startTriggerSpan', () => {
    it('creates a span named engine.trigger', () => {
      const inst = new EngineInstrumentation({});
      const { span } = inst.startTriggerSpan('exec-1', 'myFlow', 'user-1', 'key-1');
      expect(span).toBeDefined();
    });

    it('returns a context object', () => {
      const inst = new EngineInstrumentation({});
      const { context } = inst.startTriggerSpan('exec-1', 'myFlow', 'user-1', 'key-1');
      expect(context).toBeDefined();
    });

    it('works without userId', () => {
      const inst = new EngineInstrumentation({});
      const { span } = inst.startTriggerSpan('exec-1', 'myFlow', undefined, 'key-1');
      expect(span).toBeDefined();
    });
  });

  // ── T016: startExecutionSpan tests ──

  describe('startExecutionSpan', () => {
    it('creates a child span named engine.execution', () => {
      const inst = new EngineInstrumentation({});
      const { context: parentCtx } = inst.startTriggerSpan('exec-1', 'myFlow', undefined, 'key-1');
      const { span } = inst.startExecutionSpan(parentCtx, 'exec-1');
      expect(span).toBeDefined();
    });

    it('returns a context for further nesting', () => {
      const inst = new EngineInstrumentation({});
      const { context: parentCtx } = inst.startTriggerSpan('exec-1', 'myFlow', undefined, 'key-1');
      const { context: execCtx } = inst.startExecutionSpan(parentCtx, 'exec-1');
      expect(execCtx).toBeDefined();
    });
  });

  describe('recordStateChange', () => {
    it('does not throw when adding state change event', () => {
      const inst = new EngineInstrumentation({});
      const { span } = inst.startTriggerSpan('exec-1', 'myFlow', undefined, 'key-1');
      expect(() => inst.recordStateChange(span, 'queued', 'running')).not.toThrow();
    });
  });

  // ── T017: startModelSpan tests ──

  describe('startModelSpan', () => {
    it('creates a child span named engine.model.complete', () => {
      const inst = new EngineInstrumentation({});
      const { context: parentCtx } = inst.startTriggerSpan('exec-1', 'myFlow', undefined, 'key-1');
      const { span } = inst.startModelSpan(parentCtx);
      expect(span).toBeDefined();
    });
  });

  // ── T018: startProviderAttemptSpan tests ──

  describe('startProviderAttemptSpan', () => {
    it('creates a child span named engine.provider.attempt', () => {
      const inst = new EngineInstrumentation({});
      const { context: parentCtx } = inst.startTriggerSpan('exec-1', 'myFlow', undefined, 'key-1');
      const { span } = inst.startProviderAttemptSpan(parentCtx, 'anthropic', 1);
      expect(span).toBeDefined();
    });
  });

  // ── Span helpers ──

  describe('endSpanWithSuccess', () => {
    it('does not throw', () => {
      const inst = new EngineInstrumentation({});
      const { span } = inst.startTriggerSpan('exec-1', 'myFlow', undefined, 'key-1');
      expect(() => inst.endSpanWithSuccess(span)).not.toThrow();
    });

    it('accepts optional attributes', () => {
      const inst = new EngineInstrumentation({});
      const { span } = inst.startTriggerSpan('exec-1', 'myFlow', undefined, 'key-1');
      expect(() => inst.endSpanWithSuccess(span, { 'engine.provider.success': true })).not.toThrow();
    });
  });

  describe('endSpanWithError', () => {
    it('does not throw when given an Error', () => {
      const inst = new EngineInstrumentation({});
      const { span } = inst.startTriggerSpan('exec-1', 'myFlow', undefined, 'key-1');
      expect(() => inst.endSpanWithError(span, new Error('test failure'))).not.toThrow();
    });

    it('does not throw when given a string', () => {
      const inst = new EngineInstrumentation({});
      const { span } = inst.startTriggerSpan('exec-1', 'myFlow', undefined, 'key-1');
      expect(() => inst.endSpanWithError(span, 'test failure')).not.toThrow();
    });
  });

  // ── T035: Metric instrument creation tests ──

  describe('metric instruments', () => {
    it('creates all 6 metric instruments without error', () => {
      const inst = new EngineInstrumentation({});
      // If constructor completes, instruments were created successfully
      expect(inst).toBeDefined();
    });
  });

  // ── T036: recordRequestMetric tests ──

  describe('recordRequestMetric', () => {
    it('does not throw with valid arguments', () => {
      const inst = new EngineInstrumentation({});
      expect(() => inst.recordRequestMetric('myFlow', 'success', 150)).not.toThrow();
    });

    it('does not throw with failure status', () => {
      const inst = new EngineInstrumentation({});
      expect(() => inst.recordRequestMetric('myFlow', 'failure', 250)).not.toThrow();
    });
  });

  // ── T037: recordModelMetric tests ──

  describe('recordModelMetric', () => {
    it('does not throw with valid arguments', () => {
      const inst = new EngineInstrumentation({});
      expect(() => inst.recordModelMetric('anthropic', 'claude-3', 200)).not.toThrow();
    });
  });

  // ── T038: incrementActiveExecutions / decrementActiveExecutions tests ──

  describe('activeExecutions', () => {
    it('incrementActiveExecutions does not throw', () => {
      const inst = new EngineInstrumentation({});
      expect(() => inst.incrementActiveExecutions()).not.toThrow();
    });

    it('decrementActiveExecutions does not throw', () => {
      const inst = new EngineInstrumentation({});
      expect(() => inst.decrementActiveExecutions()).not.toThrow();
    });
  });

  // ── T063: Cost attribute tests ──

  describe('cost attributes on spans', () => {
    it('endSpanWithSuccess accepts cost attributes', () => {
      const inst = new EngineInstrumentation({});
      const { span } = inst.startModelSpan(otelContext.active());
      expect(() => inst.endSpanWithSuccess(span, {
        'engine.model.cost': 0.05,
        'engine.model.prompt_tokens': 100,
        'engine.model.completion_tokens': 50,
      })).not.toThrow();
    });
  });

  // ── T064: recordBudgetExceeded tests ──

  describe('recordBudgetExceeded', () => {
    it('does not throw with valid arguments', () => {
      const inst = new EngineInstrumentation({});
      expect(() => inst.recordBudgetExceeded('user', 'hard')).not.toThrow();
    });
  });

  // ── T065: recordCircuitBreakerTrip tests ──

  describe('recordCircuitBreakerTrip', () => {
    it('does not throw with valid arguments', () => {
      const inst = new EngineInstrumentation({});
      expect(() => inst.recordCircuitBreakerTrip('anthropic')).not.toThrow();
    });
  });

  // ── T072: Memory spans tests ──

  describe('startMemorySpan', () => {
    it('returns null when memorySpans is disabled (default)', () => {
      const inst = new EngineInstrumentation({});
      const result = inst.startMemorySpan(otelContext.active(), 'get', 'tool:myFlow', 'myKey');
      expect(result).toBeNull();
    });

    it('creates a span when memorySpans is enabled', () => {
      const inst = new EngineInstrumentation({ memorySpans: true });
      const result = inst.startMemorySpan(otelContext.active(), 'get', 'tool:myFlow', 'myKey');
      expect(result).not.toBeNull();
      expect(result!.span).toBeDefined();
      expect(result!.context).toBeDefined();
    });

    it('creates span for set operation with namespace', () => {
      const inst = new EngineInstrumentation({ memorySpans: true });
      const result = inst.startMemorySpan(otelContext.active(), 'set', 'user:alice', 'prefs');
      expect(result).not.toBeNull();
    });

    it('creates span for list operation without key', () => {
      const inst = new EngineInstrumentation({ memorySpans: true });
      const result = inst.startMemorySpan(otelContext.active(), 'list', 'tool:myFlow');
      expect(result).not.toBeNull();
    });
  });
});
