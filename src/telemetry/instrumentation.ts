// EngineInstrumentation — centralized span/metric/log operations

import {
  trace,
  metrics,
  context as otelContext,
  SpanStatusCode,
  type Tracer,
  type Meter,
  type Span,
  type Context,
  type Counter,
  type Histogram,
  type UpDownCounter,
} from '@opentelemetry/api';
import type { TelemetryConfig, LogHandler, LogLevel } from '../types.js';

const DEFAULT_SERVICE_NAME = 'runcor';
const DEFAULT_SERVICE_VERSION = '0.1.0';

/**
 * Centralized telemetry operations for the engine.
 * All OTel API calls go through this class, which catches and swallows
 * any telemetry errors so engine operation is never affected.
 */
export class EngineInstrumentation {
  readonly tracer: Tracer;
  readonly meter: Meter;
  readonly logHandler: LogHandler | null;
  readonly memorySpans: boolean;

  // Metric instruments (created lazily in initMetrics)
  private _requestCounter!: Counter;
  private _requestDuration!: Histogram;
  private _modelDuration!: Histogram;
  private _activeExecutions!: UpDownCounter;
  private _budgetExceeded!: Counter;
  private _circuitBreakerTrips!: Counter;

  constructor(config: TelemetryConfig) {
    const serviceName = config.serviceName ?? DEFAULT_SERVICE_NAME;
    const serviceVersion = config.serviceVersion ?? DEFAULT_SERVICE_VERSION;
    this.logHandler = config.logHandler ?? null;
    this.memorySpans = config.memorySpans ?? false;

    // Create tracer — use provided provider or fall back to no-op global
    try {
      this.tracer = config.tracerProvider
        ? config.tracerProvider.getTracer(serviceName, serviceVersion)
        : trace.getTracer(serviceName, serviceVersion);
    } catch {
      // Best-effort: fall back to no-op tracer
      this.tracer = trace.getTracer(serviceName, serviceVersion);
    }

    // Create meter — use provided provider or fall back to no-op global
    try {
      this.meter = config.meterProvider
        ? config.meterProvider.getMeter(serviceName, serviceVersion)
        : metrics.getMeter(serviceName, serviceVersion);
    } catch {
      this.meter = metrics.getMeter(serviceName, serviceVersion);
    }

    this.initMetrics();
  }

  /** Initialize all 6 metric instruments */
  private initMetrics(): void {
    try {
      this._requestCounter = this.meter.createCounter('engine.requests', {
        description: 'Total flow executions',
        unit: '{request}',
      });
      this._requestDuration = this.meter.createHistogram('engine.request.duration', {
        description: 'End-to-end execution time',
        unit: 'ms',
      });
      this._modelDuration = this.meter.createHistogram('engine.model.duration', {
        description: 'Per-provider model call time',
        unit: 'ms',
      });
      this._activeExecutions = this.meter.createUpDownCounter('engine.active_executions', {
        description: 'Currently running executions',
        unit: '{execution}',
      });
      this._budgetExceeded = this.meter.createCounter('engine.budget.exceeded', {
        description: 'Budget exceeded events',
        unit: '{event}',
      });
      this._circuitBreakerTrips = this.meter.createCounter('engine.circuit_breaker.trips', {
        description: 'Circuit breaker trips',
        unit: '{trip}',
      });
    } catch {
      // Best-effort — metrics are non-critical
    }
  }

  // ── Span operations ──

  /** Create root span for a trigger call */
  startTriggerSpan(
    executionId: string,
    flowName: string,
    userId: string | undefined,
    idempotencyKey: string,
  ): { span: Span; context: Context } {
    try {
      const span = this.tracer.startSpan('engine.trigger', undefined, otelContext.active());
      span.setAttribute('engine.execution.id', executionId);
      span.setAttribute('engine.flow.name', flowName);
      if (userId) span.setAttribute('engine.user.id', userId);
      span.setAttribute('engine.idempotency_key', idempotencyKey);

      const ctx = trace.setSpan(otelContext.active(), span);
      return { span, context: ctx };
    } catch {
      return { span: trace.getTracer('noop').startSpan('noop'), context: otelContext.active() };
    }
  }

  /** Create child span for execution lifecycle */
  startExecutionSpan(parentCtx: Context, executionId: string): { span: Span; context: Context } {
    try {
      const span = this.tracer.startSpan('engine.execution', undefined, parentCtx);
      span.setAttribute('engine.execution.id', executionId);
      span.setAttribute('engine.execution.state', 'running');

      const ctx = trace.setSpan(parentCtx, span);
      return { span, context: ctx };
    } catch {
      return { span: trace.getTracer('noop').startSpan('noop'), context: otelContext.active() };
    }
  }

  /** Record a state change event on an execution span */
  recordStateChange(span: Span, from: string, to: string): void {
    try {
      span.addEvent('execution.state_change', { from, to });
      span.setAttribute('engine.execution.state', to);
    } catch {
      // Best-effort
    }
  }

  /** Create child span for a model.complete() call */
  startModelSpan(parentCtx: Context): { span: Span; context: Context } {
    try {
      const span = this.tracer.startSpan('engine.model.complete', undefined, parentCtx);
      const ctx = trace.setSpan(parentCtx, span);
      return { span, context: ctx };
    } catch {
      return { span: trace.getTracer('noop').startSpan('noop'), context: otelContext.active() };
    }
  }

  /** Create child span for a provider attempt */
  startProviderAttemptSpan(
    parentCtx: Context,
    providerName: string,
    attemptNumber: number,
  ): { span: Span; context: Context } {
    try {
      const span = this.tracer.startSpan('engine.provider.attempt', undefined, parentCtx);
      span.setAttribute('engine.provider.name', providerName);
      span.setAttribute('engine.provider.attempt_number', attemptNumber);

      const ctx = trace.setSpan(parentCtx, span);
      return { span, context: ctx };
    } catch {
      return { span: trace.getTracer('noop').startSpan('noop'), context: otelContext.active() };
    }
  }

  /** Create child span for a memory operation (opt-in) */
  startMemorySpan(parentCtx: Context, operation: string, namespace: string, key?: string): { span: Span; context: Context } | null {
    if (!this.memorySpans) return null;
    try {
      const span = this.tracer.startSpan(`engine.memory.${operation}`, undefined, parentCtx);
      span.setAttribute('engine.memory.namespace', namespace);
      if (key) span.setAttribute('engine.memory.key', key);
      const ctx = trace.setSpan(parentCtx, span);
      return { span, context: ctx };
    } catch {
      return null;
    }
  }

  /** End a span with success status */
  endSpanWithSuccess(span: Span, attributes?: Record<string, string | number | boolean>): void {
    try {
      if (attributes) {
        for (const [key, value] of Object.entries(attributes)) {
          span.setAttribute(key, value);
        }
      }
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    } catch {
      // Best-effort
    }
  }

  /** End a span with error status */
  endSpanWithError(span: Span, error: Error | string): void {
    try {
      const message = typeof error === 'string' ? error : error.message;
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      span.addEvent('exception', {
        'exception.message': message,
      });
      span.end();
    } catch {
      // Best-effort
    }
  }

  // ── Metric operations ──

  /** Record a completed request metric */
  recordRequestMetric(flow: string, status: string, durationMs: number): void {
    try {
      this._requestCounter.add(1, { flow, status });
      this._requestDuration.record(durationMs, { flow });
    } catch {
      // Best-effort
    }
  }

  /** Record model call duration metric */
  recordModelMetric(provider: string, model: string, durationMs: number): void {
    try {
      this._modelDuration.record(durationMs, { provider, model });
    } catch {
      // Best-effort
    }
  }

  /** Increment active executions gauge */
  incrementActiveExecutions(): void {
    try {
      this._activeExecutions.add(1);
    } catch {
      // Best-effort
    }
  }

  /** Decrement active executions gauge */
  decrementActiveExecutions(): void {
    try {
      this._activeExecutions.add(-1);
    } catch {
      // Best-effort
    }
  }

  /** Record a budget exceeded event */
  recordBudgetExceeded(scope: string, enforcement: string): void {
    try {
      this._budgetExceeded.add(1, { scope, enforcement });
    } catch {
      // Best-effort
    }
  }

  /** Record a circuit breaker trip */
  recordCircuitBreakerTrip(provider: string): void {
    try {
      this._circuitBreakerTrips.add(1, { provider });
    } catch {
      // Best-effort
    }
  }

  // ── Policy span operations ──

  /** Create parent span for all policy checks on one operation */
  startPolicyEvaluateSpan(parentCtx: Context, operation: string): { span: Span; context: Context } {
    try {
      const span = this.tracer.startSpan('engine.policy.evaluate', undefined, parentCtx);
      span.setAttribute('engine.policy.operation', operation);
      const ctx = trace.setSpan(parentCtx, span);
      return { span, context: ctx };
    } catch {
      return { span: trace.getTracer('noop').startSpan('noop'), context: otelContext.active() };
    }
  }

  /** Create child span for access control check */
  startAccessControlSpan(parentCtx: Context): { span: Span; context: Context } {
    try {
      const span = this.tracer.startSpan('engine.policy.access_control', undefined, parentCtx);
      const ctx = trace.setSpan(parentCtx, span);
      return { span, context: ctx };
    } catch {
      return { span: trace.getTracer('noop').startSpan('noop'), context: otelContext.active() };
    }
  }

  /** Create child span for rate limit check */
  startRateLimitSpan(parentCtx: Context): { span: Span; context: Context } {
    try {
      const span = this.tracer.startSpan('engine.policy.rate_limit', undefined, parentCtx);
      const ctx = trace.setSpan(parentCtx, span);
      return { span, context: ctx };
    } catch {
      return { span: trace.getTracer('noop').startSpan('noop'), context: otelContext.active() };
    }
  }

  /** Create child span for policy rules check */
  startPolicyRulesSpan(parentCtx: Context): { span: Span; context: Context } {
    try {
      const span = this.tracer.startSpan('engine.policy.rules', undefined, parentCtx);
      const ctx = trace.setSpan(parentCtx, span);
      return { span, context: ctx };
    } catch {
      return { span: trace.getTracer('noop').startSpan('noop'), context: otelContext.active() };
    }
  }

  /** Create child span for a guardrail check (input or output) */
  startGuardrailSpan(parentCtx: Context, phase: 'input' | 'output'): { span: Span; context: Context } {
    try {
      const span = this.tracer.startSpan(`engine.policy.guardrail.${phase}`, undefined, parentCtx);
      const ctx = trace.setSpan(parentCtx, span);
      return { span, context: ctx };
    } catch {
      return { span: trace.getTracer('noop').startSpan('noop'), context: otelContext.active() };
    }
  }

  // ── Evaluation span operations ──

  private _evaluationCounter?: Counter;
  private _evaluationDuration?: Histogram;
  private _evaluationFlags?: Counter;

  /** Create parent span for a post-execution evaluation */
  startEvaluationSpan(
    executionId: string,
    flowName: string,
    evaluatorCount: number,
  ): { span: Span; context: Context } {
    try {
      if (!this._evaluationCounter) {
        this._evaluationCounter = this.meter.createCounter('engine.evaluations', {
          description: 'Total evaluations completed',
          unit: '{evaluation}',
        });
        this._evaluationDuration = this.meter.createHistogram('engine.evaluation.duration', {
          description: 'Evaluation duration',
          unit: 'ms',
        });
        this._evaluationFlags = this.meter.createCounter('engine.evaluation.flags', {
          description: 'Evaluation flags created',
          unit: '{flag}',
        });
      }
      const span = this.tracer.startSpan('engine.evaluation', undefined, otelContext.active());
      span.setAttribute('engine.execution.id', executionId);
      span.setAttribute('engine.flow.name', flowName);
      span.setAttribute('engine.evaluator.count', evaluatorCount);
      const ctx = trace.setSpan(otelContext.active(), span);
      return { span, context: ctx };
    } catch {
      return { span: trace.getTracer('noop').startSpan('noop'), context: otelContext.active() };
    }
  }

  /** Create child span for a single evaluator execution */
  startEvaluatorSpan(
    parentCtx: Context,
    evaluatorName: string,
    priority: number,
  ): { span: Span; context: Context } {
    try {
      const span = this.tracer.startSpan('engine.evaluation.evaluator', undefined, parentCtx);
      span.setAttribute('engine.evaluator.name', evaluatorName);
      span.setAttribute('engine.evaluator.priority', priority);
      const ctx = trace.setSpan(parentCtx, span);
      return { span, context: ctx };
    } catch {
      return { span: trace.getTracer('noop').startSpan('noop'), context: otelContext.active() };
    }
  }

  /** Record evaluation completion metrics */
  recordEvaluationMetric(flow: string, confidence: string, durationMs: number): void {
    try {
      this._evaluationCounter?.add(1, { flow, confidence });
      this._evaluationDuration?.record(durationMs, { flow });
    } catch {
      // Best-effort
    }
  }

  /** Record evaluation flag creation */
  recordEvaluationFlag(flow: string, source: string): void {
    try {
      this._evaluationFlags?.add(1, { flow, source });
    } catch {
      // Best-effort
    }
  }

  // ── Adapter span operations ──

  private _adapterToolCalls?: Counter;
  private _adapterToolCallDuration?: Histogram;
  private _adapterConnections?: UpDownCounter;
  private _adapterReconnections?: Counter;

  /** Create root span for an adapter connection attempt */
  startAdapterConnectSpan(adapterName: string, transport: string): { span: Span; context: Context } {
    try {
      const span = this.tracer.startSpan('engine.adapter.connect', undefined, otelContext.active());
      span.setAttribute('adapter.name', adapterName);
      span.setAttribute('adapter.transport', transport);
      const ctx = trace.setSpan(otelContext.active(), span);
      return { span, context: ctx };
    } catch {
      return { span: trace.getTracer('noop').startSpan('noop'), context: otelContext.active() };
    }
  }

  /** Create child span for an adapter tool call */
  startAdapterToolCallSpan(
    parentCtx: Context,
    adapterName: string,
    toolName: string,
  ): { span: Span; context: Context } {
    try {
      const span = this.tracer.startSpan('engine.adapter.tool_call', undefined, parentCtx);
      span.setAttribute('adapter.name', adapterName);
      span.setAttribute('adapter.tool', toolName);
      span.setAttribute('adapter.qualified_name', `${adapterName}.${toolName}`);
      const ctx = trace.setSpan(parentCtx, span);
      return { span, context: ctx };
    } catch {
      return { span: trace.getTracer('noop').startSpan('noop'), context: otelContext.active() };
    }
  }

  /** Create child span for an adapter resource read */
  startAdapterResourceReadSpan(
    parentCtx: Context,
    adapterName: string,
    uri: string,
  ): { span: Span; context: Context } {
    try {
      const span = this.tracer.startSpan('engine.adapter.resource_read', undefined, parentCtx);
      span.setAttribute('adapter.name', adapterName);
      span.setAttribute('adapter.resource_uri', uri);
      const ctx = trace.setSpan(parentCtx, span);
      return { span, context: ctx };
    } catch {
      return { span: trace.getTracer('noop').startSpan('noop'), context: otelContext.active() };
    }
  }

  /** Create root span for an adapter health check */
  startAdapterHealthCheckSpan(adapterName: string): { span: Span; context: Context } {
    try {
      const span = this.tracer.startSpan('engine.adapter.health_check', undefined, otelContext.active());
      span.setAttribute('adapter.name', adapterName);
      const ctx = trace.setSpan(otelContext.active(), span);
      return { span, context: ctx };
    } catch {
      return { span: trace.getTracer('noop').startSpan('noop'), context: otelContext.active() };
    }
  }

  // ── Adapter metric operations ──

  /** Record an adapter tool call metric (counter + duration histogram) */
  recordAdapterToolCall(adapter: string, tool: string, status: string, durationMs: number): void {
    try {
      if (!this._adapterToolCalls) {
        this._adapterToolCalls = this.meter.createCounter('engine.adapter.tool_calls', {
          description: 'Total adapter tool calls',
          unit: '{call}',
        });
        this._adapterToolCallDuration = this.meter.createHistogram('engine.adapter.tool_call.duration', {
          description: 'Adapter tool call duration',
          unit: 'ms',
        });
      }
      this._adapterToolCalls.add(1, { adapter, tool, status });
      this._adapterToolCallDuration!.record(durationMs, { adapter, tool });
    } catch {
      // Best-effort
    }
  }

  /** Increment active adapter connections gauge */
  incrementAdapterConnections(): void {
    try {
      if (!this._adapterConnections) {
        this._adapterConnections = this.meter.createUpDownCounter('engine.adapter.connections', {
          description: 'Active adapter connections',
          unit: '{connection}',
        });
      }
      this._adapterConnections.add(1);
    } catch {
      // Best-effort
    }
  }

  /** Decrement active adapter connections gauge */
  decrementAdapterConnections(): void {
    try {
      if (!this._adapterConnections) {
        this._adapterConnections = this.meter.createUpDownCounter('engine.adapter.connections', {
          description: 'Active adapter connections',
          unit: '{connection}',
        });
      }
      this._adapterConnections.add(-1);
    } catch {
      // Best-effort
    }
  }

  /** Record an adapter reconnection event */
  recordAdapterReconnection(adapter: string): void {
    try {
      if (!this._adapterReconnections) {
        this._adapterReconnections = this.meter.createCounter('engine.adapter.reconnections', {
          description: 'Adapter reconnection attempts',
          unit: '{reconnection}',
        });
      }
      this._adapterReconnections.add(1, { adapter });
    } catch {
      // Best-effort
    }
  }

  // ── Log operations ──

  /** Emit a structured log record */
  log(level: LogLevel, message: string, attributes: Record<string, unknown>, span?: Span): void {
    if (!this.logHandler) return;
    try {
      let traceId: string | null = null;
      let spanId: string | null = null;
      if (span) {
        const spanCtx = span.spanContext();
        traceId = spanCtx.traceId;
        spanId = spanCtx.spanId;
      }
      this.logHandler({
        level,
        message,
        attributes,
        traceId,
        spanId,
        timestamp: new Date(),
      });
    } catch {
      // Log handler failures silently absorbed
    }
  }
}
