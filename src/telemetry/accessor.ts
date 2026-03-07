// TelemetryAccessor factory — creates ctx.telemetry for flows

import {
  trace,
  SpanStatusCode,
  type Span,
  type Context,
  type Tracer,
} from '@opentelemetry/api';
import type { TelemetryAccessor } from '../types.js';

/**
 * Create a TelemetryAccessor that delegates to a real span and tracer.
 * Used when telemetry is configured.
 */
export function createTelemetryAccessor(
  span: Span,
  parentContext: Context,
  tracer: Tracer,
): TelemetryAccessor {
  return {
    get activeSpan(): Span {
      return span;
    },

    setAttribute(key: string, value: string | number | boolean): void {
      try {
        span.setAttribute(key, value);
      } catch {
        // Best-effort
      }
    },

    addEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
      try {
        span.addEvent(name, attributes);
      } catch {
        // Best-effort
      }
    },

    async startSpan<T>(name: string, fn: (childSpan: Span) => Promise<T>): Promise<T> {
      const childSpan = tracer.startSpan(name, undefined, parentContext);
      const childCtx = trace.setSpan(parentContext, childSpan);
      try {
        const result = await fn(childSpan);
        childSpan.setStatus({ code: SpanStatusCode.OK });
        childSpan.end();
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        childSpan.setStatus({ code: SpanStatusCode.ERROR, message });
        childSpan.addEvent('exception', { 'exception.message': message });
        childSpan.end();
        throw error;
      }
    },
  };
}

/** No-op span for use when telemetry is not configured */
const NOOP_SPAN = trace.getTracer('noop').startSpan('noop');

/**
 * Create a no-op TelemetryAccessor where all operations silently do nothing.
 * Used when telemetry is not configured.
 */
export function createNoopTelemetryAccessor(): TelemetryAccessor {
  return {
    get activeSpan(): Span {
      return NOOP_SPAN;
    },

    setAttribute(): void {
      // No-op
    },

    addEvent(): void {
      // No-op
    },

    async startSpan<T>(_name: string, fn: (span: Span) => Promise<T>): Promise<T> {
      return fn(NOOP_SPAN);
    },
  };
}
