// Unit tests for TelemetryAccessor
// Per tasks T055-T057

import { describe, it, expect, vi } from 'vitest';
import { createTelemetryAccessor, createNoopTelemetryAccessor } from '../../../src/telemetry/accessor.js';
import { trace, context as otelContext, SpanStatusCode } from '@opentelemetry/api';

// ── T055: TelemetryAccessor delegation ──

describe('TelemetryAccessor', () => {
  describe('createTelemetryAccessor', () => {
    it('activeSpan returns the provided span', () => {
      const tracer = trace.getTracer('test');
      const span = tracer.startSpan('test-span');
      const ctx = trace.setSpan(otelContext.active(), span);

      const accessor = createTelemetryAccessor(span, ctx, tracer);

      expect(accessor.activeSpan).toBe(span);
    });

    it('setAttribute delegates to the span', () => {
      const tracer = trace.getTracer('test');
      const span = tracer.startSpan('test-span');
      const ctx = trace.setSpan(otelContext.active(), span);
      const setAttributeSpy = vi.spyOn(span, 'setAttribute');

      const accessor = createTelemetryAccessor(span, ctx, tracer);
      accessor.setAttribute('my.key', 'my-value');

      expect(setAttributeSpy).toHaveBeenCalledWith('my.key', 'my-value');
    });

    it('setAttribute handles numeric values', () => {
      const tracer = trace.getTracer('test');
      const span = tracer.startSpan('test-span');
      const ctx = trace.setSpan(otelContext.active(), span);
      const setAttributeSpy = vi.spyOn(span, 'setAttribute');

      const accessor = createTelemetryAccessor(span, ctx, tracer);
      accessor.setAttribute('my.count', 42);

      expect(setAttributeSpy).toHaveBeenCalledWith('my.count', 42);
    });

    it('setAttribute handles boolean values', () => {
      const tracer = trace.getTracer('test');
      const span = tracer.startSpan('test-span');
      const ctx = trace.setSpan(otelContext.active(), span);
      const setAttributeSpy = vi.spyOn(span, 'setAttribute');

      const accessor = createTelemetryAccessor(span, ctx, tracer);
      accessor.setAttribute('my.flag', true);

      expect(setAttributeSpy).toHaveBeenCalledWith('my.flag', true);
    });

    it('addEvent delegates to the span', () => {
      const tracer = trace.getTracer('test');
      const span = tracer.startSpan('test-span');
      const ctx = trace.setSpan(otelContext.active(), span);
      const addEventSpy = vi.spyOn(span, 'addEvent');

      const accessor = createTelemetryAccessor(span, ctx, tracer);
      accessor.addEvent('my.event', { detail: 'info' });

      expect(addEventSpy).toHaveBeenCalledWith('my.event', { detail: 'info' });
    });

    it('addEvent works without attributes', () => {
      const tracer = trace.getTracer('test');
      const span = tracer.startSpan('test-span');
      const ctx = trace.setSpan(otelContext.active(), span);

      const accessor = createTelemetryAccessor(span, ctx, tracer);
      expect(() => accessor.addEvent('simple.event')).not.toThrow();
    });
  });

  // ── T056: startSpan ──

  describe('startSpan', () => {
    it('creates a child span and executes callback', async () => {
      const tracer = trace.getTracer('test');
      const parentSpan = tracer.startSpan('parent');
      const ctx = trace.setSpan(otelContext.active(), parentSpan);

      const accessor = createTelemetryAccessor(parentSpan, ctx, tracer);
      const result = await accessor.startSpan('child-op', async (childSpan) => {
        expect(childSpan).toBeDefined();
        return 'child-result';
      });

      expect(result).toBe('child-result');
    });

    it('ends child span with OK status on success', async () => {
      const tracer = trace.getTracer('test');
      const parentSpan = tracer.startSpan('parent');
      const ctx = trace.setSpan(otelContext.active(), parentSpan);

      const accessor = createTelemetryAccessor(parentSpan, ctx, tracer);
      // Should not throw — span is ended internally
      await accessor.startSpan('success-op', async () => 'ok');
    });

    it('ends child span with error status on callback throw', async () => {
      const tracer = trace.getTracer('test');
      const parentSpan = tracer.startSpan('parent');
      const ctx = trace.setSpan(otelContext.active(), parentSpan);

      const accessor = createTelemetryAccessor(parentSpan, ctx, tracer);

      await expect(
        accessor.startSpan('fail-op', async () => {
          throw new Error('callback error');
        }),
      ).rejects.toThrow('callback error');
    });

    it('propagates the error from callback', async () => {
      const tracer = trace.getTracer('test');
      const parentSpan = tracer.startSpan('parent');
      const ctx = trace.setSpan(otelContext.active(), parentSpan);

      const accessor = createTelemetryAccessor(parentSpan, ctx, tracer);

      try {
        await accessor.startSpan('err-op', async () => {
          throw new Error('specific error');
        });
        expect.unreachable('should have thrown');
      } catch (err: any) {
        expect(err.message).toBe('specific error');
      }
    });
  });

  // ── T057: No-op TelemetryAccessor ──

  describe('createNoopTelemetryAccessor', () => {
    it('activeSpan returns a span object', () => {
      const accessor = createNoopTelemetryAccessor();
      expect(accessor.activeSpan).toBeDefined();
    });

    it('setAttribute silently does nothing', () => {
      const accessor = createNoopTelemetryAccessor();
      expect(() => accessor.setAttribute('key', 'value')).not.toThrow();
    });

    it('addEvent silently does nothing', () => {
      const accessor = createNoopTelemetryAccessor();
      expect(() => accessor.addEvent('event', { k: 'v' })).not.toThrow();
    });

    it('startSpan executes callback and returns result', async () => {
      const accessor = createNoopTelemetryAccessor();
      const result = await accessor.startSpan('noop-child', async (span) => {
        expect(span).toBeDefined();
        return 42;
      });
      expect(result).toBe(42);
    });

    it('startSpan propagates callback errors', async () => {
      const accessor = createNoopTelemetryAccessor();
      await expect(
        accessor.startSpan('noop-err', async () => {
          throw new Error('noop error');
        }),
      ).rejects.toThrow('noop error');
    });
  });
});
