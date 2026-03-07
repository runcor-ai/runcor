// ModelRouter class — multi-provider routing with fallback chains

import type { Span, Context } from '@opentelemetry/api';
import type { ModelRequest, ModelResponse, ModelStream, StreamEvent } from './provider.js';
import { createFallbackStream } from './provider.js';
import type { HealthState, ModelInterface, ProviderRegistration, RoutingStrategy } from '../types.js';
import { DEFAULTS } from '../types.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { resolveStrategy } from './strategies.js';
import { AllProvidersFailedError, EngineError } from '../errors.js';
import type { ProviderError } from '../errors.js';
import type { EngineInstrumentation } from '../telemetry/instrumentation.js';

export interface ModelRouterOptions {
  providers: ProviderRegistration[];
  strategy?: RoutingStrategy | 'priority' | 'round-robin' | 'lowest-cost';
  maxFallbackAttempts?: number;
  failureThreshold?: number;
  cooldownMs?: number;
  onHealthChange?: (provider: string, from: HealthState, to: HealthState) => void;
  /** Optional instrumentation for model/provider spans */
  instrumentation?: EngineInstrumentation;
}

export class ModelRouter implements ModelInterface {
  private readonly providers: ProviderRegistration[];
  private readonly strategy: RoutingStrategy;
  private readonly maxFallbackAttempts: number;
  private readonly breakers: Map<string, CircuitBreaker>;
  private readonly instrumentation?: EngineInstrumentation;

  /** Name of the provider that handled the most recent successful request */
  private _lastResolvedProvider: string | null = null;

  constructor(options: ModelRouterOptions) {
    this.providers = options.providers;
    this.strategy = resolveStrategy(options.strategy ?? DEFAULTS.defaultStrategy);
    this.maxFallbackAttempts = options.maxFallbackAttempts ?? (options.providers.length - 1);
    this.instrumentation = options.instrumentation;

    // Create one circuit breaker per provider
    this.breakers = new Map();
    for (const reg of this.providers) {
      this.breakers.set(
        reg.name,
        new CircuitBreaker(reg.name, {
          failureThreshold: options.failureThreshold ?? DEFAULTS.failureThreshold,
          cooldownMs: options.cooldownMs ?? DEFAULTS.cooldownMs,
          onHealthChange: options.onHealthChange,
        }),
      );
    }
  }

  /** Get the name of the provider that handled the most recent request */
  get lastResolvedProvider(): string | null {
    return this._lastResolvedProvider;
  }

  /** Get registered provider configurations (for cost tracking lookups) */
  getProviders(): ReadonlyArray<ProviderRegistration> {
    return this.providers;
  }

  /** Get health state for all providers */
  getProviderHealthMap(): ReadonlyMap<string, HealthState> {
    const map = new Map<string, HealthState>();
    for (const [name, breaker] of this.breakers) {
      map.set(name, breaker.getState());
    }
    return map;
  }

  /**
   * Normalize a request: validate inputs and apply systemPrompt precedence.
   * Returns the cleaned request with routing overrides stripped.
   */
  private normalizeRequest(request: ModelRequest): {
    cleanRequest: ModelRequest;
    providerOverride: string | undefined;
    strategyOverride: ModelRequest['strategy'];
    parentCtx: Context | undefined;
  } {
    // Validate at least one of prompt or messages is provided
    const hasPrompt = request.prompt !== undefined && request.prompt !== '';
    const hasMessages = request.messages !== undefined && request.messages.length > 0;

    if (!hasPrompt && !hasMessages) {
      throw new EngineError(
        'At least one of `prompt` or `messages` must be provided.',
        'INVALID_REQUEST',
      );
    }

    // Extract internal telemetry context if present
    // __otelParentContext is an internal-only field not on the public ModelRequest interface
    const parentCtx: Context | undefined = (request as Record<string, unknown>).__otelParentContext as Context | undefined;

    // Strip routing override fields before passing to providers
    const { provider: providerOverride, strategy: strategyOverride, ...rest } = request;
    // Remove internal telemetry field
    delete (rest as Record<string, unknown>).__otelParentContext;

    let cleanRequest = rest as ModelRequest;

    // systemPrompt takes precedence over system-role messages
    if (cleanRequest.systemPrompt && cleanRequest.messages && cleanRequest.messages.length > 0) {
      cleanRequest = {
        ...cleanRequest,
        messages: cleanRequest.messages.filter(m => m.role !== 'system'),
      };
    }

    return { cleanRequest, providerOverride, strategyOverride, parentCtx };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const { cleanRequest, providerOverride, strategyOverride, parentCtx } = this.normalizeRequest(request);
    const inst = this.instrumentation;

    // Create model span wrapping the entire routing call
    let modelSpan: Span | undefined;
    let modelCtx: Context | undefined = parentCtx;
    if (inst && parentCtx) {
      const result = inst.startModelSpan(parentCtx);
      modelSpan = result.span;
      modelCtx = result.context;
    }
    const modelStart = Date.now();
    let attemptCount = 0;

    try {
      // Provider override — attempt specified provider directly
      if (providerOverride) {
        const registration = this.providers.find((p) => p.name === providerOverride);
        if (!registration) {
          throw new EngineError(
            `Provider "${providerOverride}" is not registered.`,
            'PROVIDER_NOT_FOUND',
          );
        }

        attemptCount++;
        const attemptSpan = this.createAttemptSpan(inst, modelCtx, registration.name, attemptCount);

        try {
          const response = await registration.provider.complete(cleanRequest as ModelRequest);
          const breaker = this.breakers.get(registration.name);
          breaker?.recordSuccess();
          this._lastResolvedProvider = registration.name;
          this.endAttemptSuccess(inst, attemptSpan);
          this.endModelSuccess(inst, modelSpan, response, modelStart);
          return response;
        } catch (err) {
          const breaker = this.breakers.get(registration.name);
          breaker?.recordFailure();
          this.endAttemptError(inst, attemptSpan, err);
          // Fall through to normal routing on failure
        }
      }

      // Get available (healthy + half_open) providers
      const available = this.providers.filter((p) => {
        const breaker = this.breakers.get(p.name);
        return breaker ? breaker.isAvailable() : true;
      });

      if (available.length === 0) {
        throw new EngineError('No healthy providers available.', 'NO_HEALTHY_PROVIDERS');
      }

      // Apply strategy (per-request override or default)
      const activeStrategy = strategyOverride
        ? resolveStrategy(strategyOverride)
        : this.strategy;
      const ordered = activeStrategy(available, cleanRequest as ModelRequest);

      // Try providers in order with fallback
      const errors: ProviderError[] = [];
      const maxAttempts = Math.min(ordered.length, this.maxFallbackAttempts + 1);

      for (let i = 0; i < maxAttempts; i++) {
        const registration = ordered[i];
        const breaker = this.breakers.get(registration.name);

        attemptCount++;
        const attemptSpan = this.createAttemptSpan(inst, modelCtx, registration.name, attemptCount);

        try {
          const response = await registration.provider.complete(cleanRequest as ModelRequest);
          breaker?.recordSuccess();
          this._lastResolvedProvider = registration.name;
          this.endAttemptSuccess(inst, attemptSpan);
          this.endModelSuccess(inst, modelSpan, response, modelStart);
          return response;
        } catch (err) {
          breaker?.recordFailure();
          this.endAttemptError(inst, attemptSpan, err);
          errors.push({
            providerName: registration.name,
            error: err instanceof Error ? err : new Error(String(err)),
            timestamp: new Date(),
          });
        }
      }

      throw new AllProvidersFailedError(errors);
    } catch (error) {
      // End model span with error for unrecoverable failures
      if (modelSpan && inst) {
        inst.endSpanWithError(modelSpan, error instanceof Error ? error : String(error));
      }
      throw error;
    }
  }

  /** Create provider attempt span if instrumentation available */
  private createAttemptSpan(
    inst: EngineInstrumentation | undefined,
    parentCtx: Context | undefined,
    providerName: string,
    attemptNumber: number,
  ): Span | undefined {
    if (!inst || !parentCtx) return undefined;
    return inst.startProviderAttemptSpan(parentCtx, providerName, attemptNumber).span;
  }

  /** End attempt span with success */
  private endAttemptSuccess(inst: EngineInstrumentation | undefined, span: Span | undefined): void {
    if (inst && span) inst.endSpanWithSuccess(span, { 'engine.provider.success': true });
  }

  /** End attempt span with error */
  private endAttemptError(inst: EngineInstrumentation | undefined, span: Span | undefined, err: unknown): void {
    if (inst && span) inst.endSpanWithError(span, err instanceof Error ? err : String(err));
  }

  /** End model span with success and record metric */
  private endModelSuccess(
    inst: EngineInstrumentation | undefined,
    modelSpan: Span | undefined,
    response: ModelResponse,
    startTime: number,
  ): void {
    if (inst && modelSpan) {
      const durationMs = Date.now() - startTime;
      inst.endSpanWithSuccess(modelSpan, {
        'engine.provider.name': response.provider,
        'engine.model.name': response.model,
        'engine.model.prompt_tokens': response.usage.promptTokens,
        'engine.model.completion_tokens': response.usage.completionTokens,
        'engine.model.latency_ms': durationMs,
      });
      inst.recordModelMetric(response.provider, response.model, durationMs);
    }
  }

  /**
   * Stream a model response as async-iterable events.
   * Uses same routing, strategy, and circuit breaker logic as complete().
   * Falls back to createFallbackStream for providers without native streaming.
   * If a provider's stream() throws synchronously (before yielding), falls back to next provider.
   */
  stream(request: ModelRequest): ModelStream {
    const { cleanRequest, providerOverride, strategyOverride, parentCtx } = this.normalizeRequest(request);
    const inst = this.instrumentation;

    // Create model span
    let modelSpan: Span | undefined;
    let modelCtx: Context | undefined = parentCtx;
    if (inst && parentCtx) {
      const result = inst.startModelSpan(parentCtx);
      modelSpan = result.span;
      modelCtx = result.context;
    }
    const modelStart = Date.now();

    // Determine provider ordering
    let orderedProviders: ProviderRegistration[];

    if (providerOverride) {
      const registration = this.providers.find(p => p.name === providerOverride);
      if (!registration) {
        throw new EngineError(
          `Provider "${providerOverride}" is not registered.`,
          'PROVIDER_NOT_FOUND',
        );
      }
      orderedProviders = [registration];
    } else {
      const available = this.providers.filter(p => {
        const breaker = this.breakers.get(p.name);
        return breaker ? breaker.isAvailable() : true;
      });
      if (available.length === 0) {
        throw new EngineError('No healthy providers available.', 'NO_HEALTHY_PROVIDERS');
      }
      const activeStrategy = strategyOverride
        ? resolveStrategy(strategyOverride)
        : this.strategy;
      orderedProviders = activeStrategy(available, cleanRequest as ModelRequest);
    }

    const maxAttempts = Math.min(orderedProviders.length, this.maxFallbackAttempts + 1);
    let lastError: Error | undefined;

    // Try each provider — if stream() throws synchronously, fall back
    for (let i = 0; i < maxAttempts; i++) {
      const registration = orderedProviders[i];
      const breaker = this.breakers.get(registration.name);

      try {
        let stream: ModelStream;
        if (registration.provider.stream) {
          stream = registration.provider.stream(cleanRequest as ModelRequest);
        } else {
          // Provider doesn't support streaming — call complete() and wrap
          const rawPromise = registration.provider.complete(cleanRequest as ModelRequest);
          const self = this;

          // Track success/failure via a shared promise chain (no polling)
          const trackedResponse = rawPromise.then(
            (result) => {
              breaker?.recordSuccess();
              self._lastResolvedProvider = registration.name;
              if (modelSpan && inst) {
                self.endModelSuccess(inst, modelSpan, result, modelStart);
              }
              return result;
            },
            (err) => {
              breaker?.recordFailure();
              const error = err instanceof Error ? err : new Error(String(err));
              if (modelSpan && inst) {
                inst.endSpanWithError(modelSpan, error);
              }
              throw error;
            },
          );

          stream = {
            async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
              const result = await trackedResponse;
              if (result.text) {
                yield { type: 'text_delta', text: result.text };
              }
              if (result.toolCalls) {
                for (const tc of result.toolCalls) {
                  yield { type: 'tool_call', toolCall: tc };
                }
              }
            },
            response: trackedResponse,
          };
        }

        // Provider returned a stream object without throwing — commit to this provider
        this._lastResolvedProvider = registration.name;

        // For streaming providers, record circuit breaker success/failure
        // when the stream's response promise resolves, not immediately
        if (registration.provider.stream) {
          const originalResponse = stream.response;
          const origStream = stream;
          const self = this;
          stream = {
            [Symbol.asyncIterator]: () => origStream[Symbol.asyncIterator](),
            response: originalResponse.then(
              (resp) => {
                breaker?.recordSuccess();
                if (modelSpan && inst) {
                  self.endModelSuccess(inst!, modelSpan!, resp, modelStart);
                }
                return resp;
              },
              (err) => {
                breaker?.recordFailure();
                if (modelSpan && inst) {
                  inst!.endSpanWithError(modelSpan!, err instanceof Error ? err : String(err));
                }
                throw err;
              },
            ),
          };
        } else {
          // Non-streaming fallback path already handles breaker in trackedResponse
          breaker?.recordSuccess();
          if (modelSpan && inst) {
            // Telemetry handled in trackedResponse chain
          }
        }

        return stream;
      } catch (err) {
        breaker?.recordFailure();
        lastError = err instanceof Error ? err : new Error(String(err));
        // Continue to next provider (sync throw before yielding = fallback)
      }
    }

    // All providers failed
    if (modelSpan && inst) {
      inst.endSpanWithError(modelSpan, lastError ?? new Error('All providers failed'));
    }
    throw new AllProvidersFailedError([{
      providerName: orderedProviders[0]?.name ?? 'unknown',
      error: lastError ?? new Error('All providers failed'),
      timestamp: new Date(),
    }]);
  }

  /** Clean up all circuit breaker timers */
  shutdown(): void {
    for (const breaker of this.breakers.values()) {
      breaker.shutdown();
    }
  }
}
