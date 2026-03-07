// ExecutionContext factory — extended with memory and routing support

import { trace, type Context } from '@opentelemetry/api';
import type { BudgetScopeConfig, CostAccessor, ExecutionContext, MemoryAccessor, MemoryStore, ModelInterface, ScopedMemory, ToolsAccessor, ResponseFormat, ValidationRetryEvent } from './types.js';
import { ScopedMemoryImpl } from './memory/scoped.js';
import { EngineError, ValidationError } from './errors.js';
import type { ValidationErrorDetail } from './errors.js';
import type { CostTracker } from './cost/tracker.js';
import { createCostAccessor } from './cost/tracker.js';
import type { EngineInstrumentation } from './telemetry/instrumentation.js';
import { createTelemetryAccessor, createNoopTelemetryAccessor } from './telemetry/accessor.js';
import { validateRequestFormat, validateResponse, buildRetryHint } from './model/validation.js';
import type { ModelRequest, ModelResponse } from './model/provider.js';

/** Options for creating an execution context with memory support */
export interface ContextOptions {
  executionId: string;
  input: unknown;
  /** ModelRouter (or any ModelInterface) — routing is transparent to flows */
  modelRouter: ModelInterface;
  memoryStore: MemoryStore;
  flowName: string;
  userId?: string;
  sessionId?: string;
  /** CostTracker for cost-aware model wrapping */
  costTracker?: CostTracker;
  /** Per-flow budget override */
  flowBudget?: BudgetScopeConfig;
  /** EngineInstrumentation for telemetry */
  instrumentation?: EngineInstrumentation;
  /** Parent span context for span nesting */
  parentContext?: Context;
  /** Data from engine.resume() — undefined for initial invocations */
  resumeData?: unknown;
  /** ToolsAccessor for adapter tool access. Undefined when no adapters. */
  toolsAccessor?: ToolsAccessor;
  /** Callback for model:validation_retry event emission */
  onValidationRetry?: (event: ValidationRetryEvent) => void;
}

/** Create an isolated execution context for a flow handler */
export function createExecutionContext(options: ContextOptions): ExecutionContext {
  const { executionId, input, modelRouter, memoryStore, flowName, userId, sessionId, costTracker, flowBudget, instrumentation, parentContext } = options;

  // Helper: call underlying model with instrumentation + cost tracking
  const callModel = (request: ModelRequest): Promise<ModelResponse> => {
    const instrumentedRequest = (instrumentation && parentContext)
      ? Object.assign({}, request, { __otelParentContext: parentContext })
      : request;
    return costTracker
      ? costTracker.wrapComplete(instrumentedRequest, {
          executionId,
          flowName,
          userId: userId ?? null,
          flowBudget,
        })
      : modelRouter.complete(instrumentedRequest);
  };

  const model: ModelInterface = {
    complete: async (request) => {
      // Validate schema at request time
      validateRequestFormat(request.responseFormat);

      const responseFormat = request.responseFormat;

      // Make initial model call
      let response = await callModel(request);

      // Text mode / no format — return as-is (no parsed key)
      if (!responseFormat || responseFormat === 'text') {
        return response;
      }

      // toolCalls present — skip validation
      if (response.toolCalls && response.toolCalls.length > 0) {
        return response;
      }

      // Validate response and retry up to 2 times
      const maxRetries = 2;
      let currentRequest = request;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const parsed = validateResponse(response.text, responseFormat);
          return { ...response, parsed };
        } catch (err) {
          if (!(err instanceof ValidationError)) throw err;
          if (attempt === maxRetries) throw err;

          // Emit validation retry event
          options.onValidationRetry?.({
            attempt: attempt + 1,
            errors: err.errors,
            rawText: err.rawText,
            executionId,
            flowName,
          });

          // Build retry hint and construct retry request pinned to same provider
          const hint = buildRetryHint(err.errors);
          const retryRequest: ModelRequest = { ...currentRequest, provider: response.provider };
          if (retryRequest.messages) {
            retryRequest.messages = [
              ...retryRequest.messages,
              { role: 'assistant' as const, content: response.text },
              { role: 'user' as const, content: hint },
            ];
          } else if (retryRequest.prompt) {
            retryRequest.prompt = `${retryRequest.prompt}\n\n${hint}`;
          }

          // Retry (goes through cost tracker)
          response = await callModel(retryRequest);
          currentRequest = retryRequest;

          // toolCalls on retry — skip validation
          if (response.toolCalls && response.toolCalls.length > 0) {
            return response;
          }
        }
      }

      return response; // Unreachable, satisfies TypeScript
    },
    stream: (request) => {
      // Validate schema at request time
      validateRequestFormat(request.responseFormat);

      const instrumentedRequest = (instrumentation && parentContext)
        ? Object.assign({}, request, { __otelParentContext: parentContext })
        : request;

      const innerStream = costTracker
        ? costTracker.wrapStream(instrumentedRequest, {
            executionId,
            flowName,
            userId: userId ?? null,
            flowBudget,
          })
        : modelRouter.stream(instrumentedRequest);

      const responseFormat = request.responseFormat;

      // Text mode / no format — return stream as-is (no parsed key)
      if (!responseFormat || responseFormat === 'text') {
        return innerStream;
      }

      // Wrap .response to validate and set parsed (no retries for streaming)
      const wrappedResponse = innerStream.response.then((response) => {
        // toolCalls present — skip validation
        if (response.toolCalls && response.toolCalls.length > 0) {
          return response;
        }
        const parsed = validateResponse(response.text, responseFormat);
        return { ...response, parsed };
      });

      return {
        [Symbol.asyncIterator]: () => innerStream[Symbol.asyncIterator](),
        response: wrappedResponse,
      };
    },
  };

  // Pass instrumentation for opt-in memory spans (memorySpans=true)
  const memInst = (instrumentation?.memorySpans && parentContext) ? instrumentation : undefined;
  const memCtx = (instrumentation?.memorySpans && parentContext) ? parentContext : undefined;

  // Tool scope is always available — namespace: "tool:{flowName}"
  const toolMemory: ScopedMemory = new ScopedMemoryImpl(memoryStore, `tool:${flowName}`, memInst, memCtx);

  // User and session scopes use lazy getters that throw if ID not provided
  const memory: MemoryAccessor = {
    tool: toolMemory,
    get user(): ScopedMemory {
      if (!userId) {
        throw new EngineError(
          'User ID is required for user-scoped memory. Provide userId in trigger options.',
          'MISSING_USER_ID',
        );
      }
      return new ScopedMemoryImpl(memoryStore, `user:${userId}`, memInst, memCtx);
    },
    get session(): ScopedMemory {
      if (!sessionId) {
        throw new EngineError(
          'Session ID is required for session-scoped memory. Provide sessionId in trigger options.',
          'MISSING_SESSION_ID',
        );
      }
      return new ScopedMemoryImpl(memoryStore, `session:${sessionId}`, memInst, memCtx);
    },
  };

  // Cost accessor: lazily computed from CostTracker's ledger, or zero-default if no tracking
  const cost: CostAccessor = costTracker
    ? createCostAccessor(costTracker.getLedger(), executionId)
    : { executionTotal: 0, requestCount: 0 };

  // Telemetry accessor: real if instrumentation + context provided, otherwise no-op
  const telemetry = (instrumentation && parentContext)
    ? createTelemetryAccessor(
        trace.getSpan(parentContext) ?? trace.getTracer('noop').startSpan('noop'),
        parentContext,
        instrumentation.tracer,
      )
    : createNoopTelemetryAccessor();

  const ctx: ExecutionContext = {
    executionId,
    input,
    model,
    memory,
    cost,
    telemetry,
  };

  // Inject ToolsAccessor when provided
  if (options.toolsAccessor) {
    ctx.tools = options.toolsAccessor;
  }

  // Only set resumeData when provided (undefined = initial invocation)
  if (options.resumeData !== undefined) {
    ctx.resumeData = options.resumeData;
  }

  return ctx;
}
