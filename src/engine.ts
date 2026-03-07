// Runcor class

import { EventEmitter } from 'node:events';
import type {
  CostBudgetExceededEvent,
  CostBudgetWarningEvent,
  CostRequestEvent,
  EngineConfig,
  EngineStatus,
  ExecutionContext,
  ExecutionState,
  Flow,
  FlowConfig,
  FlowHandler,
  HealthState,
  ProviderRegistration,
  ResolvedFlowConfig,
  StateFilter,
  TriggerOptions,
} from './types.js';
import { DEFAULTS } from './types.js';
import {
  type Execution,
  createExecution,
  transitionExecution,
} from './execution.js';
import { createExecutionContext } from './execution-context.js';
import { InMemoryStateStore, type StateStore } from './state-store.js';
import { SQLiteStateStore } from './sqlite-state-store.js';
import { InMemoryStore } from './memory/store.js';
import type { MemoryStore } from './types.js';
import { ModelRouter } from './model/router.js';
import { EngineError, RetryableError } from './errors.js';
import { ObjectiveRegistry } from './discernment/objectives.js';
import { DiscernmentEngine, type EnforceCallbacks } from './discernment/engine.js';
import { SignalCollector } from './discernment/collector.js';
import { SignalAccumulator } from './discernment/accumulator.js';
import { FlowProfiler } from './discernment/profiler.js';
import { HeuristicAnalyzer } from './discernment/heuristics.js';
import { ModelAnalyzer } from './discernment/analyzer.js';
import type {
  Objective,
  ObjectiveDeclaration,
  CycleReport,
  Recommendation,
  RecommendationFilter,
  CustomHeuristic,
  DiscernmentConfig,
} from './discernment/types.js';
import { isWaitSignal } from './wait-signal.js';
import { CostTracker } from './cost/tracker.js';
import { InMemoryCostLedger } from './cost/ledger.js';
import type { CostLedgerStore } from './types.js';
import { EngineInstrumentation } from './telemetry/instrumentation.js';
import type { Span, Context } from '@opentelemetry/api';
import { PolicyEngine } from './policy/policy-engine.js';
import { EvaluationEngine } from './evaluation/evaluation-engine.js';
import { AdapterManager } from './adapter/adapter-manager.js';
import { MCPServerAdapter } from './server/mcp-server-adapter.js';
import type { MCPServerConfig } from './server/types.js';
import { CronScheduler } from './scheduler/cron-scheduler.js';
import { loadConfig } from './config/loader.js';
import type { ProviderFactory, EvaluatorFactory } from './config/factories.js';
import type {
  PolicyRule,
  Guardrail,
  RateLimitConfig,
  AccessPolicy,
  TenantConfig,
  PolicyContext,
  GuardrailContext,
  Evaluator,
  FlagStatus,
  FlagFilter,
  AdapterConfig,
  AdapterInfo,
  AdapterToolInfo,
  ToolCallResult,
  ResourceContent,
} from './types.js';

export interface EngineEvents {
  ready: [];
  shutdown: [];
  'execution:state_change': [{ executionId: string; from: ExecutionState; to: ExecutionState; timestamp: Date }];
  'execution:complete': [{ executionId: string; state: ExecutionState; result?: unknown; error?: unknown }];
  'provider:health_change': [{ provider: string; from: HealthState; to: HealthState; timestamp: Date }];
  // Cost events
  'cost:request': [CostRequestEvent];
  'cost:budget_warning': [CostBudgetWarningEvent];
  'cost:budget_exceeded': [CostBudgetExceededEvent];
  // Policy events
  'policy:violation': [{
    ruleName: string;
    operation: import('./types.js').OperationType;
    flowName: string;
    userId: string | null;
    tenantId: string | null;
    reason: string;
    timestamp: Date;
  }];
  'policy:warning': [{
    guardrailName: string;
    phase: 'input' | 'output';
    flowName: string;
    userId: string | null;
    tenantId: string | null;
    reason: string | null;
    timestamp: Date;
  }];
  'policy:rate_limited': [{
    rateLimitName: string;
    scope: 'user' | 'flow' | 'global';
    flowName: string;
    userId: string | null;
    tenantId: string | null;
    limit: number;
    windowMs: number;
    currentCount: number;
    behavior: 'reject' | 'queue';
    timestamp: Date;
  }];
  // Evaluation events
  'eval:score': [import('./types.js').EvalScoreEvent];
  'eval:complete': [import('./types.js').EvalCompleteEvent];
  'eval:flagged': [import('./types.js').EvalFlaggedEvent];
  // Adapter events
  'adapter:connected': [{ name: string }];
  'adapter:disconnected': [{ name: string; reason?: string }];
  'adapter:error': [{ name: string; error: string }];
  'adapter:tools_discovered': [{ name: string; tools: string[] }];
  'adapter:tool_call': [{ adapter: string; tool: string; durationMs: number; success: boolean }];
  // Flow registration events
  'flow:registered': [{ name: string }];
  'flow:unregistered': [{ name: string }];
  // Scheduler events
  'scheduler:trigger': [{ flowName: string; scheduledTime: Date; idempotencyKey: string; executionId: string }];
  'scheduler:skip': [{ flowName: string; scheduledTime: Date; reason: string; activeExecutionId: string | null }];
  'scheduler:registered': [{ flowName: string; cronExpression: string; timezone: string; nextFireTime: Date | null }];
  'scheduler:removed': [{ flowName: string }];
  // Structured output events
  'model:validation_retry': [import('./types.js').ValidationRetryEvent];
  // Discernment events
  'discernment:signal': [import('./discernment/types.js').Signal];
  'discernment:recommendation': [import('./discernment/types.js').Recommendation];
  'discernment:cycle': [import('./discernment/types.js').CycleReport];
}

export class Runcor extends EventEmitter<EngineEvents> {
  private status: EngineStatus = 'initializing';
  private readonly flowRegistry = new Map<string, Flow>();
  private readonly stateStore: StateStore;
  private readonly memoryStore: MemoryStore;
  private readonly modelRouter: ModelRouter;
  private readonly concurrency: number;
  private readonly drainTimeout: number;
  private activeExecutions = 0;

  // Track timers for cleanup
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Wait timeout timers — separate from execution timeout
  private readonly waitTimeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Remaining execution timeout when paused during wait
  private readonly executionTimeoutRemaining = new Map<string, number>();

  // Store flow handler references for waiting executions so resume works
  // even after flow unregistration
  private readonly flowHandlerMap = new Map<string, Flow>();

  // Track trigger options per execution for memory context during retries
  private readonly triggerOptionsMap = new Map<string, TriggerOptions>();

  // Cost tracking
  private readonly costTracker: CostTracker | null = null;
  private readonly costLedger: CostLedgerStore | null = null;

  // Telemetry
  readonly instrumentation: EngineInstrumentation;

  // Policy
  private readonly policyEngine: PolicyEngine;

  // Adapter
  private readonly adapterManager: AdapterManager;

  // MCP Server
  private mcpServerAdapter: MCPServerAdapter | null = null;
  private readonly config: EngineConfig;

  // Scheduler
  private cronScheduler: CronScheduler | null = null;

  // Discernment
  private objectiveRegistry: ObjectiveRegistry | null = null;
  private discernmentEngine: DiscernmentEngine | null = null;
  private heuristicAnalyzer: HeuristicAnalyzer | null = null;
  private signalAccumulator: SignalAccumulator | null = null;
  private _pendingDiscernmentConfig?: DiscernmentConfig;
  private _pendingDiscernmentDeps?: {
    objRegistry: ObjectiveRegistry;
    accumulator: SignalAccumulator;
    heurAnalyzer: HeuristicAnalyzer;
  };
  private readonly enforceableFlows = new Set<string>();

  // Evaluation
  private readonly evaluationEngine: EvaluationEngine;
  private readonly executionSpans = new Map<string, {
    triggerSpan: Span;
    triggerCtx: Context;
    execSpan: Span | null;
    execCtx: Context | null;
    startTime: number;
  }>();

  constructor(config: EngineConfig, registrations: ProviderRegistration[]) {
    super();
    this.config = config;

    // Create instrumentation first (needed by router and callbacks)
    this.instrumentation = new EngineInstrumentation(config.telemetry ?? {});

    this.modelRouter = new ModelRouter({
      providers: registrations,
      strategy: config.model.strategy,
      maxFallbackAttempts: config.model.maxFallbackAttempts,
      failureThreshold: config.model.failureThreshold,
      cooldownMs: config.model.cooldownMs,
      instrumentation: this.instrumentation,
      onHealthChange: (provider, from, to) => {
        try {
          this.emit('provider:health_change', { provider, from, to, timestamp: new Date() });
        } catch {
          // Events are best-effort
        }
        // Log and record circuit breaker state changes
        this.instrumentation.log('warn', 'Circuit breaker state change', { provider, from, to });
        if (to === 'unhealthy') {
          this.instrumentation.recordCircuitBreakerTrip(provider);
        }
      },
    });

    this.concurrency = config.concurrency ?? DEFAULTS.concurrency;
    this.drainTimeout = config.drainTimeout ?? DEFAULTS.drainTimeout;
    this.memoryStore = config.memoryStore ?? new InMemoryStore();

    const retentionPeriod = config.retentionPeriod ?? DEFAULTS.retentionPeriod;
    if (config.state?.type === 'sqlite') {
      this.stateStore = new SQLiteStateStore({
        path: config.state.path!,
        retentionPeriod,
        onOrphanedExecution: config.state.onOrphanedExecution,
      });
    } else {
      this.stateStore = new InMemoryStateStore(retentionPeriod);
    }

    // Policy Engine
    this.policyEngine = new PolicyEngine(
      config.policy,
      this.instrumentation,
      (type, payload) => {
        this.emitUnchecked(type, payload);
      },
    );

    // Evaluation Engine
    this.evaluationEngine = new EvaluationEngine(
      config.evaluation,
      this.instrumentation,
      (type, payload) => {
        this.emitUnchecked(type, payload);
      },
    );

    // Adapter Manager
    this.adapterManager = new AdapterManager(
      config.adapters,
      this.instrumentation,
      (type, payload) => {
        this.emitUnchecked(type, payload);
      },
    );

    // Discernment — create ObjectiveRegistry and DiscernmentEngine if enabled
    if (config.discernment?.enabled) {
      const objRegistry = new ObjectiveRegistry();
      this.objectiveRegistry = objRegistry;

      // Auto-register objectives from config
      if (config.discernment.objectives) {
        for (const obj of config.discernment.objectives) {
          objRegistry.addObjective(obj);
        }
      }

      // Create SignalAccumulator and attach to event bus
      const accumulator = new SignalAccumulator();
      this.signalAccumulator = accumulator;
      accumulator.attach(this);

      // Create HeuristicAnalyzer (saved for custom heuristic management)
      const heurAnalyzer = new HeuristicAnalyzer(config.discernment.thresholds);
      this.heuristicAnalyzer = heurAnalyzer;

      // DiscernmentEngine deps will be finalized after CostTracker construction below
      this._pendingDiscernmentConfig = config.discernment;
      this._pendingDiscernmentDeps = {
        objRegistry,
        accumulator,
        heurAnalyzer,
      };
    }

    // Cost Tracking — create CostTracker if cost config or any provider has costPerToken
    const hasCostConfig = !!config.cost;
    const hasCostPerToken = registrations.some((r) => r.costPerToken !== null);
    if (hasCostConfig || hasCostPerToken) {
      const costConfig = config.cost ?? {};
      this.costLedger = costConfig.ledgerStore ?? new InMemoryCostLedger(costConfig.maxLedgerEntries);
      this.costTracker = new CostTracker(
        this.modelRouter,
        this.costLedger,
        costConfig,
        registrations,
        (type, payload) => {
          this.emitUnchecked(type, payload);
          // Log events and record metrics/span events
          if (type === 'cost:request') {
            const p = payload as CostRequestEvent;
            // Add cost span event on execution span for cost visibility
            const spanData = this.executionSpans.get(p.executionId);
            if (spanData?.execSpan) {
              try {
                spanData.execSpan.addEvent('engine.cost.request', {
                  'engine.cost.amount': p.cost,
                  'engine.cost.provider': p.provider,
                  'engine.cost.model': p.model,
                  'engine.cost.prompt_tokens': p.promptTokens,
                  'engine.cost.completion_tokens': p.completionTokens,
                });
              } catch {
                // Best-effort
              }
            }
          }
          if (type === 'cost:budget_warning') {
            this.instrumentation.log('warn', 'Budget warning', payload as unknown as Record<string, unknown>);
          }
          if (type === 'cost:budget_exceeded') {
            const p = payload as CostBudgetExceededEvent;
            this.instrumentation.log('error', 'Budget exceeded', payload as unknown as Record<string, unknown>);
            this.instrumentation.recordBudgetExceeded(p.scope, p.enforcement);
          }
        },
      );
    }

    // Finalize DiscernmentEngine (after CostTracker is available)
    if (this._pendingDiscernmentConfig) {
      const discConfig = this._pendingDiscernmentConfig;
      const pending = this._pendingDiscernmentDeps!;

      const collector = new SignalCollector({
        costLedger: this.costLedger,
        evaluationEngine: this.evaluationEngine,
        stateStore: this.stateStore,
        accumulator: pending.accumulator,
        scheduler: this.cronScheduler ? {
          getSchedule: (flowName: string) => this.cronScheduler!.getSchedule(flowName) ?? null,
        } : null,
        memoryStore: this.memoryStore,
        flowRegistry: this.flowRegistry,
      });

      const profiler = new FlowProfiler();

      const modelAnalyzer = new ModelAnalyzer({
        router: this.modelRouter,
        costTracker: this.costTracker,
        config: discConfig,
      });

      const enforceCallbacks: EnforceCallbacks = {
        enforceableFlows: this.enforceableFlows,
        unregister: (flowName: string) => this.unregister(flowName),
      };

      this.discernmentEngine = new DiscernmentEngine(
        discConfig,
        {
          collector,
          profiler: { buildSystemProfile: profiler.buildSystemProfile.bind(profiler) },
          heuristicAnalyzer: { analyze: pending.heurAnalyzer.analyze.bind(pending.heurAnalyzer) },
          modelAnalyzer: { analyze: modelAnalyzer.analyze.bind(modelAnalyzer) },
          objectiveRegistry: pending.objRegistry,
          flowRegistry: this.flowRegistry,
          emitEvent: (event: string, ...args: unknown[]) => {
            this.emitUnchecked(event, ...args);
          },
        },
        enforceCallbacks,
      );

      this._pendingDiscernmentConfig = undefined;
      this._pendingDiscernmentDeps = undefined;
    }
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  /** Emit an event without TypeScript checking the event name (for dynamic subsystem callbacks) */
  private emitUnchecked(type: string, ...args: unknown[]): void {
    try {
      (this.emit as Function).call(this, type, ...args);
    } catch {
      // Events are best-effort
    }
  }

  /** Get the cost ledger for querying cost data, or null if cost tracking is not active */
  getCostLedger(): CostLedgerStore | null {
    return this.costLedger;
  }

  /** Lazily create the CronScheduler when first needed */
  private ensureScheduler(): CronScheduler {
    if (this.cronScheduler) return this.cronScheduler;

    const defaultTimezone = this.config.scheduler?.defaultTimezone;
    this.cronScheduler = new CronScheduler(
      async (flowName, idempotencyKey, input) => {
        const execution = await this.trigger(flowName, { idempotencyKey, input });
        return execution.id;
      },
      defaultTimezone ?? 'UTC',
    );

    // Wire event callback
    this.cronScheduler.setEventCallback((type, payload) => {
      this.emitUnchecked(type, payload);
    });

    // Wire overlap check callback
    this.cronScheduler.setOverlapCheckCallback(async (flowName) => {
      const blockingStates: ExecutionState[] = ['queued', 'running', 'retrying'];
      for (const state of blockingStates) {
        const executions = await this.stateStore.list({ state, flowName });
        if (executions.length > 0) {
          return executions[0].id;
        }
      }
      return null;
    });

    // Listen for execution state changes to clear active execution tracking
    this.on('execution:state_change', ({ executionId, to }) => {
      if (to === 'complete' || to === 'failed' || to === 'waiting') {
        this.cronScheduler?.clearActiveExecution(executionId);
      }
    });

    return this.cronScheduler;
  }

  /** Register a flow with the engine */
  register(name: string, handler: FlowHandler, config?: FlowConfig): void {
    if (this.status !== 'ready') {
      throw new EngineError(
        'Engine is not ready. Cannot register flows.',
        'ENGINE_NOT_READY',
      );
    }

    if (this.flowRegistry.has(name)) {
      throw new EngineError(
        `Flow "${name}" is already registered.`,
        'DUPLICATE_FLOW',
      );
    }

    // Reject reserved flow name
    if (this.objectiveRegistry && name === '__discernment') {
      throw new EngineError(
        'Flow name "__discernment" is reserved by the discernment subsystem.',
        'RESERVED_FLOW_NAME',
      );
    }

    // Validate objective references when discernment enabled
    if (this.objectiveRegistry && config?.objective) {
      if (!this.objectiveRegistry.hasObjective(config.objective)) {
        throw new EngineError(
          `Objective "${config.objective}" is not declared. Declare it with addObjective() first.`,
          'UNDECLARED_OBJECTIVE',
        );
      }
      if (config.secondaryObjectives) {
        for (const sec of config.secondaryObjectives) {
          if (!this.objectiveRegistry.hasObjective(sec)) {
            throw new EngineError(
              `Secondary objective "${sec}" is not declared. Declare it with addObjective() first.`,
              'UNDECLARED_OBJECTIVE',
            );
          }
        }
      }
    }

    const resolved: ResolvedFlowConfig = {
      timeout: config?.timeout ?? DEFAULTS.timeout,
      maxRetries: config?.maxRetries ?? DEFAULTS.maxRetries,
      baseRetryDelay: config?.baseRetryDelay ?? DEFAULTS.baseRetryDelay,
      maxRetryDelay: config?.maxRetryDelay ?? DEFAULTS.maxRetryDelay,
      waitTimeout: config?.waitTimeout ?? DEFAULTS.waitTimeout,
    };

    this.flowRegistry.set(name, {
      name,
      handler,
      config: resolved,
      budget: config?.budget,
      description: config?.description,
      inputSchema: config?.inputSchema ?? { type: 'object' },
      objective: config?.objective,
      secondaryObjectives: config?.secondaryObjectives,
      expectedCadence: config?.expectedCadence,
      purpose: config?.purpose,
      enforceable: config?.enforceable,
    });

    // Wire up cron schedule if provided
    if (config?.schedule) {
      try {
        const scheduler = this.ensureScheduler();
        scheduler.addSchedule(name, config.schedule, config.timezone);
      } catch (err) {
        // Roll back flow registration on schedule validation failure
        this.flowRegistry.delete(name);
        if (err instanceof EngineError) throw err;
        throw new EngineError(
          (err as Error).message,
          (err as Error).message.includes('timezone') ? 'INVALID_TIMEZONE' : 'INVALID_SCHEDULE',
        );
      }
    }

    // Store flow-objective mapping
    if (this.objectiveRegistry && config?.objective) {
      this.objectiveRegistry.addFlowTag({
        flowName: name,
        primaryObjective: config.objective,
        secondaryObjectives: config.secondaryObjectives ?? [],
        expectedCadence: config.expectedCadence ?? null,
        purpose: config.purpose ?? null,
        enforceable: config.enforceable ?? false,
      });
    }

    // Track enforceable flows for enforce mode
    if (config?.enforceable) {
      this.enforceableFlows.add(name);
    }

    try {
      this.emit('flow:registered', { name });
    } catch {
      // Events are best-effort
    }
  }

  /** Unregister a flow by name */
  unregister(flowName: string): void {
    if (this.status !== 'ready') {
      throw new EngineError(
        'Engine is not ready. Cannot unregister flows.',
        'ENGINE_NOT_READY',
      );
    }

    if (!this.flowRegistry.has(flowName)) {
      throw new EngineError(
        `Flow "${flowName}" is not registered.`,
        'FLOW_NOT_FOUND',
      );
    }

    // Remove schedule before deleting flow
    if (this.cronScheduler) {
      this.cronScheduler.removeSchedule(flowName);
    }

    // Clean up flow-objective mapping
    if (this.objectiveRegistry) {
      this.objectiveRegistry.removeFlowTag(flowName);
    }

    // Remove from enforceable set
    this.enforceableFlows.delete(flowName);

    this.flowRegistry.delete(flowName);

    try {
      this.emit('flow:unregistered', { name: flowName });
    } catch {
      // Events are best-effort
    }
  }

  /** Return all currently registered flows */
  listFlows(): Flow[] {
    return Array.from(this.flowRegistry.values());
  }

  /** Start the MCP server */
  async startServer(config?: MCPServerConfig): Promise<void> {
    if (this.status !== 'ready') {
      throw new EngineError(
        'Engine is not ready. Cannot start MCP server.',
        'ENGINE_NOT_READY',
      );
    }
    if (this.mcpServerAdapter?.isRunning()) {
      throw new EngineError(
        'MCP server is already running.',
        'SERVER_ALREADY_RUNNING',
      );
    }
    const serverConfig = config ?? this.config.server ?? {};
    this.mcpServerAdapter = new MCPServerAdapter(this, serverConfig);
    await this.mcpServerAdapter.start();
  }

  /** Stop the MCP server */
  async stopServer(): Promise<void> {
    if (!this.mcpServerAdapter?.isRunning()) return;
    await this.mcpServerAdapter.stop();
    this.mcpServerAdapter = null;
  }

  /** Trigger execution of a registered flow */
  async trigger(flowName: string, options: TriggerOptions): Promise<Execution> {
    if (this.status === 'shutting_down' || this.status === 'stopped') {
      throw new EngineError(
        'Engine is shutting down. Cannot trigger new executions.',
        'ENGINE_SHUTTING_DOWN',
      );
    }

    if (this.status !== 'ready') {
      throw new EngineError(
        'Engine is not ready. Cannot trigger executions.',
        'ENGINE_NOT_READY',
      );
    }

    if (!options.idempotencyKey || options.idempotencyKey.trim() === '') {
      throw new EngineError(
        'Idempotency key is required and must be non-empty.',
        'MISSING_IDEMPOTENCY_KEY',
      );
    }

    // Check idempotency — return existing execution if key exists
    const existing = await this.stateStore.getByIdempotencyKey(
      options.idempotencyKey,
    );
    if (existing) {
      return existing;
    }

    const flow = this.flowRegistry.get(flowName);
    if (!flow) {
      throw new EngineError(
        `Flow "${flowName}" is not registered.`,
        'FLOW_NOT_FOUND',
      );
    }

    // Policy pre-execution checks (access control → rate limits → policy rules)
    const tenantId = this.policyEngine.resolveTenantId(options.tenantId, options.userId);
    const policyContext: PolicyContext = {
      operation: 'trigger',
      flowName,
      userId: options.userId ?? null,
      tenantId,
      input: options.input ?? null,
      executionId: null,
      metadata: options.metadata ?? {},
    };
    const policyInput = await this.policyEngine.evaluatePreExecution(policyContext);
    // Use potentially modified input from policy rules
    const effectiveInput = policyInput;

    const execution = createExecution(
      flowName,
      options.idempotencyKey,
      effectiveInput ?? null,
      options.userId,
    );

    // Store trigger options for memory context during retries
    this.triggerOptionsMap.set(execution.id, options);

    // Start trigger span and track execution telemetry
    const { span: triggerSpan, context: triggerCtx } = this.instrumentation.startTriggerSpan(
      execution.id, flowName, options.userId, options.idempotencyKey,
    );
    this.executionSpans.set(execution.id, {
      triggerSpan, triggerCtx, execSpan: null, execCtx: null, startTime: Date.now(),
    });
    this.instrumentation.incrementActiveExecutions();
    this.instrumentation.log('info', 'Execution started', {
      executionId: execution.id, flowName,
    }, triggerSpan);

    await this.stateStore.set(execution);
    this.dispatch(execution, flow, options.timeout);

    return execution;
  }

  /** Cancel a running or queued execution */
  async cancel(executionId: string, reason?: string): Promise<void> {
    const execution = await this.stateStore.get(executionId);
    if (!execution) {
      throw new EngineError(
        `Execution "${executionId}" not found.`,
        'EXECUTION_NOT_FOUND',
      );
    }

    if (execution.state === 'complete' || execution.state === 'failed') {
      throw new EngineError(
        `Cannot cancel execution in "${execution.state}" state.`,
        'INVALID_STATE',
      );
    }

    this.clearTimers(executionId);
    this.failExecution(execution, {
      message: reason ?? 'Execution cancelled',
      code: 'CANCELLED',
      retryable: false,
    });
  }

  /** Resume a waiting execution with optional data */
  async resume(executionId: string, resumeData?: unknown): Promise<Execution> {
    const execution = await this.stateStore.get(executionId);
    if (!execution) {
      throw new EngineError(
        `Execution "${executionId}" not found.`,
        'EXECUTION_NOT_FOUND',
      );
    }

    // Idempotent resume: if already terminal or running and data matches, return silently
    if (execution.state !== 'waiting') {
      if (
        (execution.state === 'running' || execution.state === 'complete' || execution.state === 'failed') &&
        JSON.stringify(resumeData) === JSON.stringify(execution.resumeData)
      ) {
        return execution;
      }
      throw new EngineError(
        `Cannot resume execution in "${execution.state}" state.`,
        'INVALID_STATE',
      );
    }

    // Policy pre-execution checks for resume
    const resumeTriggerOpts = this.triggerOptionsMap.get(executionId);
    const resumeTenantId = this.policyEngine.resolveTenantId(resumeTriggerOpts?.tenantId, resumeTriggerOpts?.userId);
    const resumePolicyContext: PolicyContext = {
      operation: 'resume',
      flowName: execution.flowName,
      userId: resumeTriggerOpts?.userId ?? null,
      tenantId: resumeTenantId,
      input: resumeData ?? null,
      executionId,
      metadata: resumeTriggerOpts?.metadata ?? {},
    };
    await this.policyEngine.evaluatePreExecution(resumePolicyContext);

    // Re-read fresh state after async policy evaluation (concurrent resume race)
    const freshExecution = await this.stateStore.get(executionId);
    if (!freshExecution || freshExecution.state !== 'waiting') {
      const currentState = freshExecution?.state ?? 'unknown';
      if (
        freshExecution &&
        (currentState === 'running' || currentState === 'complete' || currentState === 'failed') &&
        JSON.stringify(resumeData) === JSON.stringify(freshExecution.resumeData)
      ) {
        return freshExecution;
      }
      throw new EngineError(
        `Cannot resume execution in "${currentState}" state.`,
        'INVALID_STATE',
      );
    }

    // Cancel wait timeout timer
    const waitTimer = this.waitTimeoutTimers.get(executionId);
    if (waitTimer) {
      clearTimeout(waitTimer);
      this.waitTimeoutTimers.delete(executionId);
    }

    // Store resume data, clear wait context
    freshExecution.resumeData = resumeData ?? null;
    freshExecution.waitContext = null;

    // Transition waiting → running
    this.transitionAndEmit(freshExecution, 'running');
    await this.stateStore.set(freshExecution);

    // Log resume event
    this.instrumentation.log('info', 'Execution resuming', {
      executionId, flowName: freshExecution.flowName,
    });

    // Increment active executions (slot was freed on wait)
    this.activeExecutions++;

    // Retrieve stored flow handler (not registry — works even after unregistration)
    const flow = this.flowHandlerMap.get(executionId);
    if (!flow) {
      // Fallback to registry
      const registryFlow = this.flowRegistry.get(freshExecution.flowName);
      if (!registryFlow) {
        this.failExecution(freshExecution, {
          message: `Flow "${freshExecution.flowName}" not found for resume.`,
          code: 'FLOW_NOT_FOUND',
          retryable: false,
        });
        this.activeExecutions--;
        return freshExecution;
      }
      this.flowHandlerMap.set(executionId, registryFlow);
    }
    const activeFlow = this.flowHandlerMap.get(executionId)!;

    // Calculate remaining execution timeout
    const remaining = this.executionTimeoutRemaining.get(executionId);
    if (remaining !== undefined && remaining <= 0) {
      // Zero/negative remaining timeout — fail immediately
      this.failExecution(freshExecution, {
        message: `Execution timed out (no remaining time after wait)`,
        code: 'TIMEOUT',
        retryable: false,
      });
      this.onExecutionTerminal(freshExecution, activeFlow);
      return freshExecution;
    }

    // Create execution span for resumed invocation with resume attribute
    const spanData = this.executionSpans.get(executionId);
    if (spanData?.triggerCtx) {
      const { span, context } = this.instrumentation.startExecutionSpan(spanData.triggerCtx, executionId);
      spanData.execSpan = span;
      spanData.execCtx = context;
      try {
        span.setAttribute('engine.resume.execution_id', executionId);
      } catch { /* best-effort */ }
      this.instrumentation.recordStateChange(span, 'waiting', 'running');
    }

    // Set execution timeout with remaining time (if applicable)
    if (remaining !== undefined && remaining > 0) {
      const timer = setTimeout(() => {
        if (freshExecution.state !== 'complete' && freshExecution.state !== 'failed') {
          this.clearTimers(executionId);
          this.failExecution(freshExecution, {
            message: `Execution timed out after resumed wait`,
            code: 'TIMEOUT',
            retryable: false,
          });
          this.onExecutionTerminal(freshExecution, activeFlow);
        }
      }, remaining);
      this.timeoutTimers.set(executionId, timer);
    }
    this.executionTimeoutRemaining.delete(executionId);

    // Create fresh execution context with resumeData
    const triggerOpts = this.triggerOptionsMap.get(executionId);
    const execCtx = this.executionSpans.get(executionId)?.execCtx;
    const ctx = createExecutionContext({
      executionId,
      input: freshExecution.input,
      modelRouter: this.modelRouter,
      memoryStore: this.memoryStore,
      flowName: activeFlow.name,
      userId: triggerOpts?.userId,
      sessionId: triggerOpts?.sessionId,
      costTracker: this.costTracker ?? undefined,
      flowBudget: activeFlow.budget,
      instrumentation: this.instrumentation,
      parentContext: execCtx ?? undefined,
      resumeData,
      onValidationRetry: (event) => this.emit('model:validation_retry', event),
    });

    // Re-invoke handler (async — don't await, let it run)
    this.runResumedHandler(freshExecution, activeFlow, ctx);

    return freshExecution;
  }

  /** Run the resumed handler and handle its result/error */
  private async runResumedHandler(
    execution: Execution,
    flow: Flow,
    ctx: ExecutionContext,
  ): Promise<void> {
    try {
      const result = await flow.handler(ctx);

      if (execution.state !== 'running') return;

      // Detect WaitSignal (multi-wait)
      if (isWaitSignal(result)) {
        await this.enterWaitingState(execution, flow, result);
        return;
      }

      // Evaluate output guardrails on resumed execution result
      const resumedTriggerOpts = this.triggerOptionsMap.get(execution.id);
      const resumedTenantId = this.policyEngine.resolveTenantId(resumedTriggerOpts?.tenantId, resumedTriggerOpts?.userId);
      const outputGuardrailCtx: GuardrailContext = {
        executionId: execution.id,
        flowName: flow.name,
        userId: resumedTriggerOpts?.userId ?? null,
        tenantId: resumedTenantId,
        phase: 'output',
      };
      const guardrailedResult = await this.policyEngine.evaluateOutputGuardrails(result, outputGuardrailCtx);

      this.clearTimers(execution.id);
      execution.result = guardrailedResult ?? null;
      this.transitionAndEmit(execution, 'complete');
      await this.stateStore.set(execution);
      this.emitComplete(execution);
      this.onExecutionTerminal(execution, flow);
    } catch (err: unknown) {
      if (execution.state !== 'running') return;
      // Errors on resume fail the execution (no retry on resume)
      const error = err instanceof Error ? err : new Error(String(err));
      this.clearTimers(execution.id);
      this.failExecution(execution, {
        message: error.message,
        stack: null,
        code: null,
        retryable: false,
      });
      this.onExecutionTerminal(execution, flow);
    }
  }

  /** Replay a terminal execution */
  async replay(executionId: string): Promise<Execution> {
    const original = await this.stateStore.get(executionId);
    if (!original) {
      throw new EngineError(
        `Execution "${executionId}" not found.`,
        'EXECUTION_NOT_FOUND',
      );
    }

    if (original.state !== 'complete' && original.state !== 'failed') {
      throw new EngineError(
        `Cannot replay execution in "${original.state}" state. Only completed or failed executions can be replayed.`,
        'INVALID_STATE',
      );
    }

    const flow = this.flowRegistry.get(original.flowName);
    if (!flow) {
      throw new EngineError(
        `Flow "${original.flowName}" is not registered. Cannot replay.`,
        'FLOW_NOT_FOUND',
      );
    }

    // Reconstruct trigger options
    const originalOpts = this.triggerOptionsMap.get(executionId);

    // Policy pre-execution checks for replay
    const replayTenantId = this.policyEngine.resolveTenantId(originalOpts?.tenantId, originalOpts?.userId);
    const replayPolicyContext: PolicyContext = {
      operation: 'replay',
      flowName: original.flowName,
      userId: originalOpts?.userId ?? null,
      tenantId: replayTenantId,
      input: original.input,
      executionId,
      metadata: originalOpts?.metadata ?? {},
    };
    await this.policyEngine.evaluatePreExecution(replayPolicyContext);

    const newIdempotencyKey = `replay:${executionId}:${Date.now()}:${crypto.randomUUID()}`;

    const newExecution = await this.trigger(original.flowName, {
      idempotencyKey: newIdempotencyKey,
      input: original.input,
      userId: originalOpts?.userId,
      sessionId: originalOpts?.sessionId,
      tenantId: originalOpts?.tenantId,
      metadata: originalOpts?.metadata,
    });

    // Set replayOf on the new execution
    newExecution.replayOf = executionId;
    await this.stateStore.set(newExecution);

    // Add replay telemetry attribute and log
    const replaySpanData = this.executionSpans.get(newExecution.id);
    if (replaySpanData?.triggerSpan) {
      try {
        replaySpanData.triggerSpan.setAttribute('engine.replay.original_id', executionId);
      } catch { /* best-effort */ }
    }
    this.instrumentation.log('info', 'Execution replayed', {
      originalId: executionId, newId: newExecution.id, flowName: original.flowName,
    });

    return newExecution;
  }

  /** List all waiting executions, optionally filtered by flow name */
  async listWaiting(flowName?: string, options?: { userId?: string; tenantId?: string; metadata?: Record<string, unknown> }): Promise<Execution[]> {
    // Policy pre-execution checks for listWaiting (access control + rules, no rate limits)
    const listTenantId = this.policyEngine.resolveTenantId(options?.tenantId, options?.userId);
    const listPolicyContext: PolicyContext = {
      operation: 'listWaiting',
      flowName: flowName ?? '*',
      userId: options?.userId ?? null,
      tenantId: listTenantId,
      input: null,
      executionId: null,
      metadata: options?.metadata ?? {},
    };
    await this.policyEngine.evaluatePreExecution(listPolicyContext, true /* skipRateLimits */);

    const filter: { state: ExecutionState; flowName?: string } = { state: 'waiting' as ExecutionState };
    if (flowName) {
      filter.flowName = flowName;
    }
    return this.stateStore.list(filter);
  }

  /** List all executions, optionally filtered by state or flow name */
  async list(filter?: StateFilter): Promise<Execution[]> {
    return this.stateStore.list(filter);
  }

  /** Retrieve an execution by ID */
  async getExecution(executionId: string): Promise<Execution | null> {
    return this.stateStore.get(executionId);
  }

  /** Delete a terminal execution from the state store */
  async deleteExecution(executionId: string): Promise<void> {
    const execution = await this.stateStore.get(executionId);
    if (!execution) {
      throw new EngineError(
        `Execution "${executionId}" not found.`,
        'EXECUTION_NOT_FOUND',
      );
    }
    if (execution.state !== 'complete' && execution.state !== 'failed') {
      throw new EngineError(
        `Cannot delete execution in "${execution.state}" state. Only terminal (complete/failed) executions can be deleted.`,
        'INVALID_TRANSITION',
      );
    }
    await this.stateStore.delete(executionId);
  }

  // ── Policy Management Methods ──

  /** Register a policy rule. Throws DUPLICATE_POLICY if name already exists. */
  addPolicy(rule: PolicyRule): void {
    this.policyEngine.addPolicy(rule);
  }

  /** Remove a policy rule by name. No-op if not found. */
  removePolicy(name: string): void {
    this.policyEngine.removePolicy(name);
  }

  /** Register a guardrail. Throws DUPLICATE_GUARDRAIL if name already exists. */
  addGuardrail(guardrail: Guardrail): void {
    this.policyEngine.addGuardrail(guardrail);
  }

  /** Remove a guardrail by name. No-op if not found. */
  removeGuardrail(name: string): void {
    this.policyEngine.removeGuardrail(name);
  }

  /** Register a rate limit. Throws DUPLICATE_RATE_LIMIT if name already exists. */
  addRateLimit(config: RateLimitConfig): void {
    this.policyEngine.addRateLimit(config);
  }

  /** Remove a rate limit by name. Releases any queued requests. No-op if not found. */
  removeRateLimit(name: string): void {
    this.policyEngine.removeRateLimit(name);
  }

  /** Set an access policy for an identity. Overwrites if identity already has a policy. */
  setAccessPolicy(policy: AccessPolicy): void {
    this.policyEngine.setAccessPolicy(policy);
  }

  /** Remove an access policy by identity. No-op if not found. */
  removeAccessPolicy(identity: string): void {
    this.policyEngine.removeAccessPolicy(identity);
  }

  /** Set tenant configuration. Overwrites if tenantId already configured. */
  setTenantConfig(config: TenantConfig): void {
    this.policyEngine.setTenantConfig(config);
  }

  /** Remove tenant configuration. No-op if not found. */
  removeTenantConfig(tenantId: string): void {
    this.policyEngine.removeTenantConfig(tenantId);
  }

  // ── End Policy Management Methods ──

  // ── Adapter Management Methods ──

  /** Register and connect an adapter at runtime. Throws DUPLICATE_ADAPTER if name exists. */
  async addAdapter(config: AdapterConfig): Promise<void> {
    return this.adapterManager.addAdapter(config);
  }

  /** Unregister and disconnect an adapter. No-op if not found. */
  async removeAdapter(name: string): Promise<void> {
    return this.adapterManager.removeAdapter(name);
  }

  /** Get adapter runtime info, or null if not found. */
  getAdapterInfo(name: string): AdapterInfo | null {
    return this.adapterManager.getAdapterInfo(name);
  }

  /** List all registered adapter infos. */
  listAdapters(): AdapterInfo[] {
    return this.adapterManager.listAdapters();
  }

  /** List tools from all connected adapters, with optional adapter filter. */
  listAdapterTools(filter?: { adapter?: string }): AdapterToolInfo[] {
    return this.adapterManager.listTools(filter);
  }

  /** Call an adapter tool by qualified name (adapterName.toolName). */
  async callAdapterTool(
    qualifiedName: string,
    args?: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    return this.adapterManager.callTool(qualifiedName, args);
  }

  /** Read a resource from an adapter (with TTL caching). */
  async readAdapterResource(
    adapterName: string,
    uri: string,
  ): Promise<ResourceContent> {
    return this.adapterManager.readResource(adapterName, uri);
  }

  // ── End Adapter Management Methods ──

  // ── Evaluation Management Methods ──

  /** Register an evaluator. Throws DUPLICATE_EVALUATOR if name already exists. */
  addEvaluator(evaluator: Evaluator): void {
    this.evaluationEngine.addEvaluator(evaluator);
  }

  /** Remove an evaluator by name. No-op if not found. */
  removeEvaluator(name: string): void {
    this.evaluationEngine.removeEvaluator(name);
  }

  /** Get evaluation record for an execution */
  getEvaluation(executionId: string): import('./types.js').EvalRecord | null {
    return this.evaluationEngine.getEvaluation(executionId);
  }

  /** Manually flag an execution for human review */
  async flagExecution(executionId: string, reason?: string): Promise<void> {
    const execution = await this.stateStore.get(executionId);
    const flowName = execution?.flowName ?? '';
    this.evaluationEngine.flagExecution(executionId, flowName, reason);
  }

  /** Update flag status */
  updateFlag(executionId: string, status: FlagStatus): void {
    this.evaluationEngine.updateFlag(executionId, status);
  }

  /** List flags matching filter criteria */
  listFlags(filter?: FlagFilter): import('./types.js').HumanReviewFlag[] {
    return this.evaluationEngine.listFlags(filter);
  }

  // ── End Evaluation Management Methods ──

  // ── Discernment Management Methods ──

  /** Register a business objective */
  addObjective(objective: ObjectiveDeclaration): void {
    if (!this.objectiveRegistry) {
      throw new EngineError('Discernment is not enabled.', 'DISCERNMENT_DISABLED');
    }
    this.objectiveRegistry.addObjective(objective);
  }

  /** Remove an objective. Flows tagged to it become orphans. */
  removeObjective(name: string): void {
    if (!this.objectiveRegistry) {
      throw new EngineError('Discernment is not enabled.', 'DISCERNMENT_DISABLED');
    }
    this.objectiveRegistry.removeObjective(name);
  }

  /** Return all declared objectives with their associated flow counts */
  listObjectives(): Objective[] {
    if (!this.objectiveRegistry) return [];
    return this.objectiveRegistry.listObjectives();
  }

  /** Return a single objective by name, or null if not found */
  getObjective(name: string): Objective | null {
    if (!this.objectiveRegistry) return null;
    return this.objectiveRegistry.getObjective(name);
  }

  // ── Discernment Cycle & Recommendation Methods ──

  /** Run a discernment cycle. Returns the cycle report. */
  async runDiscernmentCycle(): Promise<CycleReport> {
    if (!this.discernmentEngine) {
      throw new EngineError('Discernment is not enabled.', 'DISCERNMENT_DISABLED');
    }
    return this.discernmentEngine.runCycle();
  }

  /** Get a discernment cycle report by ID */
  getDiscernmentReport(id: string): CycleReport | undefined {
    if (!this.discernmentEngine) return undefined;
    return this.discernmentEngine.getReport(id);
  }

  /** List recent discernment reports */
  listDiscernmentReports(limit?: number): CycleReport[] {
    if (!this.discernmentEngine) return [];
    return this.discernmentEngine.listReports(limit);
  }

  /** Prune old discernment reports */
  pruneDiscernmentReports(): void {
    if (!this.discernmentEngine) return;
    this.discernmentEngine.pruneReports();
  }

  /** Query discernment recommendations with optional filter */
  getRecommendations(filter?: RecommendationFilter): Recommendation[] {
    if (!this.discernmentEngine) return [];
    return this.discernmentEngine.getRecommendations(filter);
  }

  /** Acknowledge a pending recommendation */
  acknowledgeRecommendation(id: string): void {
    if (!this.discernmentEngine) {
      throw new EngineError('Discernment is not enabled.', 'DISCERNMENT_DISABLED');
    }
    this.discernmentEngine.acknowledgeRecommendation(id);
  }

  /** Dismiss a pending recommendation */
  dismissRecommendation(id: string): void {
    if (!this.discernmentEngine) {
      throw new EngineError('Discernment is not enabled.', 'DISCERNMENT_DISABLED');
    }
    this.discernmentEngine.dismissRecommendation(id);
  }

  /** Override a pending recommendation and cancel any enforce timer */
  overrideRecommendation(id: string, reason?: string): void {
    if (!this.discernmentEngine) {
      throw new EngineError('Discernment is not enabled.', 'DISCERNMENT_DISABLED');
    }
    this.discernmentEngine.overrideRecommendation(id, reason);
  }

  /** Register a custom heuristic check */
  addHeuristic(heuristic: CustomHeuristic): void {
    if (!this.heuristicAnalyzer) {
      throw new EngineError('Discernment is not enabled.', 'DISCERNMENT_DISABLED');
    }
    this.heuristicAnalyzer.addHeuristic(heuristic);
  }

  /** Remove a custom heuristic check by name */
  removeHeuristic(name: string): void {
    if (!this.heuristicAnalyzer) {
      throw new EngineError('Discernment is not enabled.', 'DISCERNMENT_DISABLED');
    }
    this.heuristicAnalyzer.removeHeuristic(name);
  }

  // ── End Discernment Management Methods ──

  // ── Dashboard Support Methods ──

  /** Get health status for all registered model providers */
  getProviderHealth(): Array<{ name: string; healthState: HealthState; priority: number; costPerToken: import('./types.js').CostPerToken | null }> {
    const providers = this.modelRouter.getProviders();
    const healthMap = this.modelRouter.getProviderHealthMap();
    return providers.map((p) => ({
      name: p.name,
      healthState: healthMap.get(p.name) ?? 'healthy',
      priority: p.priority,
      costPerToken: p.costPerToken,
    }));
  }

  /** Check which optional subsystems are active */
  getCapabilities(): { cost: boolean; evaluation: boolean; adapters: boolean; discernment: boolean; scheduler: boolean } {
    return {
      cost: this.costLedger !== null,
      evaluation: this.evaluationEngine.hasEvaluators(),
      adapters: this.adapterManager !== null && this.listAdapters().length > 0,
      discernment: this.discernmentEngine !== null,
      scheduler: this.cronScheduler !== null,
    };
  }

  // ── End Dashboard Support Methods ──

  /** Gracefully shut down the engine */
  async shutdown(): Promise<void> {
    if (this.status === 'stopped' || this.status === 'shutting_down') {
      return;
    }

    this.status = 'shutting_down';

    // Shut down scheduler before drain to prevent new triggers
    if (this.cronScheduler) {
      this.cronScheduler.shutdown();
    }

    // Wait for running executions to complete within drain timeout
    await new Promise<void>((resolve) => {
      if (this.activeExecutions === 0) {
        resolve();
        return;
      }

      const drainTimer = setTimeout(() => {
        // Force-fail remaining executions (but NOT waiting ones)
        this.stateStore.list().then((running) => {
          for (const exec of running) {
            if (exec.state !== 'complete' && exec.state !== 'failed' && exec.state !== 'waiting') {
              this.clearTimers(exec.id);
              this.failExecution(exec, {
                message: 'Engine shutting down',
                code: 'SHUTDOWN',
                retryable: false,
              });
            }
          }
          resolve();
        }).catch(() => {
          resolve(); // Resolve even on error to prevent hanging
        });
      }, this.drainTimeout);

      // Also resolve if all executions finish before drain timeout
      const checkInterval = setInterval(() => {
        if (this.activeExecutions === 0) {
          clearTimeout(drainTimer);
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);
    });

    // Stop MCP server before other cleanup
    await this.stopServer();

    // Clean up all circuit breaker timers
    this.modelRouter.shutdown();

    // Disconnect all adapters and clean up
    await this.adapterManager.shutdown();

    // Shutdown discernment (cancel enforce timers, detach accumulator)
    if (this.discernmentEngine) {
      this.discernmentEngine.shutdown();
    }
    if (this.signalAccumulator) {
      this.signalAccumulator.detach();
    }

    // Close state store (SQLite checkpoint + release)
    await this.stateStore.close?.();

    this.status = 'stopped';
    this.emit('shutdown');
  }

  /** Dispatch an execution — run it if under concurrency limit, else leave queued */
  private dispatch(execution: Execution, flow: Flow, timeoutOverride?: number): void {
    // Guard: prevent double-dispatch race between trigger and dispatchQueued
    if (execution.state !== 'queued') return;
    if (this.activeExecutions >= this.concurrency) {
      return; // Stay queued, will be dispatched when a slot opens
    }

    this.activeExecutions++;
    this.runExecution(execution, flow, timeoutOverride);
  }

  /** Run an execution: transition to running, invoke handler, handle result */
  private async runExecution(
    execution: Execution,
    flow: Flow,
    timeoutOverride?: number,
  ): Promise<void> {
    try {
      this.transitionAndEmit(execution, 'running');
      await this.stateStore.set(execution);

      // Create execution span as child of trigger span
      const spanData = this.executionSpans.get(execution.id);
      if (spanData?.triggerCtx) {
        const { span, context } = this.instrumentation.startExecutionSpan(spanData.triggerCtx, execution.id);
        spanData.execSpan = span;
        spanData.execCtx = context;
        this.instrumentation.recordStateChange(span, 'queued', 'running');
      }

      // Set up timeout
      const timeout = timeoutOverride ?? flow.config.timeout;
      if (timeout > 0) {
        const timer = setTimeout(() => {
          if (
            execution.state !== 'complete' &&
            execution.state !== 'failed'
          ) {
            this.clearTimers(execution.id);
            this.failExecution(execution, {
              message: `Execution timed out after ${timeout}ms`,
              code: 'TIMEOUT',
              retryable: false,
            });
            this.onExecutionTerminal(execution, flow);
          }
        }, timeout);
        this.timeoutTimers.set(execution.id, timer);
      }

      const triggerOpts = this.triggerOptionsMap.get(execution.id);
      const execCtx = this.executionSpans.get(execution.id)?.execCtx;

      // Evaluate input guardrails before handler
      const guardrailTenantId = this.policyEngine.resolveTenantId(triggerOpts?.tenantId, triggerOpts?.userId);
      const guardrailContext: GuardrailContext = {
        executionId: execution.id,
        flowName: flow.name,
        userId: triggerOpts?.userId ?? null,
        tenantId: guardrailTenantId,
        phase: 'input',
      };
      const guardrailedInput = await this.policyEngine.evaluateInputGuardrails(
        execution.input,
        guardrailContext,
      );

      const ctx: ExecutionContext = createExecutionContext({
        executionId: execution.id,
        input: guardrailedInput,
        modelRouter: this.modelRouter,
        memoryStore: this.memoryStore,
        flowName: flow.name,
        userId: triggerOpts?.userId,
        sessionId: triggerOpts?.sessionId,
        costTracker: this.costTracker ?? undefined,
        flowBudget: flow.budget,
        instrumentation: this.instrumentation,
        parentContext: execCtx ?? undefined,
        onValidationRetry: (event) => this.emit('model:validation_retry', event),
      });

      const result = await flow.handler(ctx);

      // Check if already timed out or cancelled
      if (execution.state !== 'running') return;

      // Detect WaitSignal return — enter waiting state
      if (isWaitSignal(result)) {
        await this.enterWaitingState(execution, flow, result);
        return;
      }

      // Evaluate output guardrails after handler
      const outputGuardrailContext: GuardrailContext = {
        ...guardrailContext,
        phase: 'output',
      };
      const guardrailedResult = await this.policyEngine.evaluateOutputGuardrails(
        result,
        outputGuardrailContext,
      );

      this.clearTimers(execution.id);

      // null/undefined stored as null
      execution.result = guardrailedResult ?? null;
      this.transitionAndEmit(execution, 'complete');
      await this.stateStore.set(execution);

      this.emitComplete(execution);
      this.onExecutionTerminal(execution, flow);
    } catch (err: unknown) {
      // Check if already timed out or cancelled
      if (execution.state !== 'running') return;

      await this.handleExecutionError(execution, flow, err, timeoutOverride);
    }
  }

  /** Handle an error thrown by a flow handler */
  private async handleExecutionError(
    execution: Execution,
    flow: Flow,
    err: unknown,
    timeoutOverride?: number,
  ): Promise<void> {
    const isRetryable = err instanceof RetryableError;
    const error = err instanceof Error ? err : new Error(String(err));

    if (isRetryable && execution.retryCount < flow.config.maxRetries) {
      // End current execution span for this attempt (retry keeps trigger span open)
      const spanData = this.executionSpans.get(execution.id);
      if (spanData?.execSpan) {
        this.instrumentation.recordStateChange(spanData.execSpan, 'running', 'retrying');
        this.instrumentation.endSpanWithError(spanData.execSpan, error);
        spanData.execSpan = null;
        spanData.execCtx = null;
      }

      // Transition to retrying, schedule retry
      this.transitionAndEmit(execution, 'retrying');
      execution.retryCount++;
      await this.stateStore.set(execution);

      const delay = this.calculateBackoff(
        execution.retryCount - 1,
        flow.config.baseRetryDelay,
        flow.config.maxRetryDelay,
      );

      const retryTimer = setTimeout(async () => {
        this.retryTimers.delete(execution.id);
        if (execution.state !== 'retrying') return;

        this.transitionAndEmit(execution, 'running');
        await this.stateStore.set(execution);

        // Create new execution span for retry attempt
        const retrySpanData = this.executionSpans.get(execution.id);
        if (retrySpanData?.triggerCtx) {
          const { span, context } = this.instrumentation.startExecutionSpan(retrySpanData.triggerCtx, execution.id);
          retrySpanData.execSpan = span;
          retrySpanData.execCtx = context;
          this.instrumentation.recordStateChange(span, 'retrying', 'running');
        }

        try {
          const retryTriggerOpts = this.triggerOptionsMap.get(execution.id);
          const retryExecCtx = this.executionSpans.get(execution.id)?.execCtx;
          const ctx = createExecutionContext({
            executionId: execution.id,
            input: execution.input,
            modelRouter: this.modelRouter,
            memoryStore: this.memoryStore,
            flowName: flow.name,
            userId: retryTriggerOpts?.userId,
            sessionId: retryTriggerOpts?.sessionId,
            costTracker: this.costTracker ?? undefined,
            flowBudget: flow.budget,
            instrumentation: this.instrumentation,
            parentContext: retryExecCtx ?? undefined,
            onValidationRetry: (event) => this.emit('model:validation_retry', event),
          });
          const result = await flow.handler(ctx);

          // State may have changed via timeout/cancel during await
          if ((execution.state as string) !== 'running') return;

          // Detect WaitSignal in retry path
          if (isWaitSignal(result)) {
            await this.enterWaitingState(execution, flow, result);
            return;
          }

          this.clearTimers(execution.id);
          execution.result = result ?? null;
          this.transitionAndEmit(execution, 'complete');
          await this.stateStore.set(execution);
          this.emitComplete(execution);
          this.onExecutionTerminal(execution, flow);
        } catch (retryErr: unknown) {
          // State may have changed via timeout/cancel during await
          if ((execution.state as string) !== 'running') return;
          await this.handleExecutionError(execution, flow, retryErr, timeoutOverride);
        }
      }, delay);

      this.retryTimers.set(execution.id, retryTimer);
    } else {
      // Non-retryable or max retries exhausted — fail
      this.clearTimers(execution.id);
      this.failExecution(execution, {
        message: error.message,
        stack: null,
        code: isRetryable ? 'MAX_RETRIES_EXHAUSTED' : null,
        retryable: isRetryable,
      });
      this.onExecutionTerminal(execution, flow);
    }
  }

  /** Calculate exponential backoff delay with jitter */
  private calculateBackoff(
    attempt: number,
    baseDelay: number,
    maxDelay: number,
  ): number {
    const exponential = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
    const jitter = Math.random() * 1000;
    return exponential + jitter;
  }

  /** Fail an execution and emit events */
  private failExecution(
    execution: Execution,
    errorInfo: { message: string; code: string | null; retryable: boolean; stack?: string | null },
  ): void {
    if (execution.state === 'complete' || execution.state === 'failed') return;

    execution.error = {
      message: errorInfo.message,
      stack: errorInfo.stack ?? null,
      retryable: errorInfo.retryable,
      retryCount: execution.retryCount,
      code: errorInfo.code,
    };

    this.transitionAndEmit(execution, 'failed');
    this.stateStore.set(execution).catch(() => {
      // Best-effort persist
    });
    this.emitComplete(execution);

    // End spans with error status
    this.finalizeSpans(execution);
  }

  /** After an execution reaches a terminal state, free the slot and dispatch queued work */
  private async onExecutionTerminal(execution: Execution, flow: Flow): Promise<void> {
    this.activeExecutions--;
    // triggerOptionsMap retained for replay — evict oldest when over limit
    if (this.triggerOptionsMap.size > 10000) {
      const firstKey = this.triggerOptionsMap.keys().next().value;
      if (firstKey !== undefined) this.triggerOptionsMap.delete(firstKey);
    }
    this.flowHandlerMap.delete(execution.id);
    this.executionTimeoutRemaining.delete(execution.id);

    // Finalize spans for success case (failure already handled in failExecution)
    this.finalizeSpans(execution);

    // Fire-and-forget post-execution evaluation (only for successful completions)
    if (execution.state === 'complete') {
      this.runPostExecutionEval(execution);
    }

    await this.dispatchQueued();
  }

  /** Run evaluation asynchronously — fire-and-forget, never blocks */
  private runPostExecutionEval(execution: Execution): void {
    if (!this.evaluationEngine.hasEvaluators()) return;

    const triggerOpts = this.triggerOptionsMap.get(execution.id);
    const startedAt = execution.timestamps.started?.getTime() ?? Date.now();
    const completedAt = execution.timestamps.completed?.getTime() ?? Date.now();

    const context: import('./types.js').EvalContext = {
      executionId: execution.id,
      flowName: execution.flowName,
      input: execution.input,
      output: execution.result,
      userId: triggerOpts?.userId ?? null,
      tenantId: triggerOpts?.tenantId ?? null,
      duration: completedAt - startedAt,
      state: execution.state as 'complete' | 'failed',
      error: execution.error,
      metadata: triggerOpts?.metadata ?? {},
    };

    // Fire-and-forget — never blocks flow response
    Promise.resolve().then(() => this.evaluationEngine.runEvaluation(context)).catch((err) => {
      // Evaluation errors are always captured, never propagated
      this.instrumentation.log('error', 'Post-execution evaluation failed', {
        executionId: execution.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /** End all spans for a terminal execution, record metrics, clean up */
  private finalizeSpans(execution: Execution): void {
    const spanData = this.executionSpans.get(execution.id);
    if (!spanData) return; // Already finalized or no telemetry

    const durationMs = Date.now() - spanData.startTime;
    const isSuccess = execution.state === 'complete';

    // End execution span if still open
    if (spanData.execSpan) {
      if (isSuccess) {
        this.instrumentation.recordStateChange(spanData.execSpan, 'running', 'complete');
        this.instrumentation.endSpanWithSuccess(spanData.execSpan);
      } else {
        this.instrumentation.endSpanWithError(spanData.execSpan, execution.error?.message ?? 'unknown');
      }
    }

    // End trigger span
    if (isSuccess) {
      this.instrumentation.endSpanWithSuccess(spanData.triggerSpan);
      this.instrumentation.log('info', 'Execution completed', {
        executionId: execution.id, flowName: execution.flowName,
        status: 'complete', durationMs,
      }, spanData.triggerSpan);
    } else {
      this.instrumentation.endSpanWithError(spanData.triggerSpan, execution.error?.message ?? 'unknown');
      this.instrumentation.log('error', 'Execution failed', {
        executionId: execution.id, flowName: execution.flowName,
        error: execution.error?.message, retryCount: execution.retryCount,
      }, spanData.triggerSpan);
    }

    // Record metrics
    this.instrumentation.recordRequestMetric(
      execution.flowName, isSuccess ? 'success' : 'failure', durationMs,
    );
    this.instrumentation.decrementActiveExecutions();

    // Clean up
    this.executionSpans.delete(execution.id);
  }

  /** Dispatch next queued execution if under concurrency limit */
  private async dispatchQueued(): Promise<void> {
    if (this.activeExecutions >= this.concurrency) return;

    const queued = await this.stateStore.list({ state: 'queued' });
    if (queued.length === 0) return;

    // Sort by queued timestamp (oldest first)
    queued.sort(
      (a, b) => a.timestamps.queued.getTime() - b.timestamps.queued.getTime(),
    );

    const next = queued[0];
    const flow = this.flowRegistry.get(next.flowName);
    if (!flow) return;

    // Use dispatch to apply the double-dispatch guard
    this.dispatch(next, flow);
  }

  /** Transition state and emit state_change event */
  private transitionAndEmit(execution: Execution, newState: ExecutionState): void {
    const from = execution.state;
    transitionExecution(execution, newState);

    try {
      this.emit('execution:state_change', {
        executionId: execution.id,
        from,
        to: newState,
        timestamp: new Date(),
      });
    } catch {
      // Events are best-effort — failing listener doesn't block
    }
  }

  /** Emit execution:complete event */
  private emitComplete(execution: Execution): void {
    try {
      this.emit('execution:complete', {
        executionId: execution.id,
        state: execution.state,
        result: execution.result,
        error: execution.error,
      });
    } catch {
      // Best-effort
    }
  }

  /** Enter waiting state — shared by runExecution, retry path, and resumed handler */
  private async enterWaitingState(
    execution: Execution,
    flow: Flow,
    signal: import('./wait-signal.js').WaitSignal,
  ): Promise<void> {
    // Build WaitContext from signal fields
    execution.waitContext = {
      reason: signal.reason ?? null,
      expectedResumeBy: signal.expectedResumeBy ?? null,
      waitData: signal.waitData ?? null,
      waitingSince: new Date(),
    };

    // Clear execution timeout timer and record remaining time
    const timeoutTimer = this.timeoutTimers.get(execution.id);
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      this.timeoutTimers.delete(execution.id);

      // Calculate remaining execution timeout
      const spanData = this.executionSpans.get(execution.id);
      if (spanData) {
        const elapsed = Date.now() - spanData.startTime;
        const triggerOpts = this.triggerOptionsMap.get(execution.id);
        const totalTimeout = triggerOpts?.timeout ?? flow.config.timeout;
        if (totalTimeout > 0) {
          this.executionTimeoutRemaining.set(execution.id, totalTimeout - elapsed);
        }
      }
    }

    // Store flow handler reference so resume works even after unregistration
    this.flowHandlerMap.set(execution.id, flow);

    // Transition running → waiting
    this.transitionAndEmit(execution, 'waiting');
    await this.stateStore.set(execution);

    // Log wait event and end execution span
    this.instrumentation.log('info', 'Execution waiting', {
      executionId: execution.id, flowName: flow.name,
      reason: execution.waitContext!.reason,
    });

    const spanData = this.executionSpans.get(execution.id);
    if (spanData?.execSpan) {
      this.instrumentation.recordStateChange(spanData.execSpan, 'running', 'waiting');
      this.instrumentation.endSpanWithSuccess(spanData.execSpan);
      spanData.execSpan = null;
      spanData.execCtx = null;
    }

    // Activate wait timeout if configured
    const triggerOpts = this.triggerOptionsMap.get(execution.id);
    const effectiveWaitTimeout = triggerOpts?.waitTimeout ?? flow.config.waitTimeout;
    if (effectiveWaitTimeout > 0) {
      const waitTimer = setTimeout(() => {
        if (execution.state !== 'waiting') return;
        this.instrumentation.log('warn', 'Wait timeout expired', {
          executionId: execution.id, flowName: flow.name, waitTimeoutMs: effectiveWaitTimeout,
        });
        this.clearTimers(execution.id);
        this.failExecution(execution, {
          message: `Wait timed out after ${effectiveWaitTimeout}ms`,
          code: 'WAIT_TIMEOUT',
          retryable: false,
        });
        // Wait timeout is a terminal event — clean up handler map and spans
        this.flowHandlerMap.delete(execution.id);
        this.executionTimeoutRemaining.delete(execution.id);
        this.finalizeSpans(execution);
      }, effectiveWaitTimeout);
      this.waitTimeoutTimers.set(execution.id, waitTimer);
    }

    // Free concurrency slot — waiting holds no resources
    this.activeExecutions--;

    // Dispatch queued work since we freed a slot
    await this.dispatchQueued();
  }

  /** Clear retry, timeout, and wait timeout timers for an execution */
  private clearTimers(executionId: string): void {
    const retryTimer = this.retryTimers.get(executionId);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.retryTimers.delete(executionId);
    }

    const timeoutTimer = this.timeoutTimers.get(executionId);
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      this.timeoutTimers.delete(executionId);
    }

    // Clear wait timeout timer and flow handler map entry
    const waitTimer = this.waitTimeoutTimers.get(executionId);
    if (waitTimer) {
      clearTimeout(waitTimer);
      this.waitTimeoutTimers.delete(executionId);
    }

    this.flowHandlerMap.delete(executionId);
    this.executionTimeoutRemaining.delete(executionId);
  }
}

/** Build ProviderRegistration[] from EngineConfig, validating all constraints */
function buildProviderRegistrations(config: EngineConfig): ProviderRegistration[] {
  const model = config.model;

  // Mutual exclusivity: provider and providers cannot coexist
  if (model.provider && model.providers) {
    throw new EngineError(
      'Cannot specify both "provider" and "providers" in model config.',
      'INVALID_CONFIG',
    );
  }

  // Must have at least one source
  if (!model.provider && !model.providers) {
    throw new EngineError(
      'No model providers configured. Add a provider to your EngineConfig or configure one in runcor.yaml. For testing, use MockProvider or type: mock.',
      'INVALID_CONFIG',
    );
  }

  // Legacy single-provider: wrap as single-element providers array
  if (model.provider) {
    return [{
      name: model.provider.name,
      provider: model.provider,
      priority: DEFAULTS.defaultPriority,
      costPerToken: null,
      models: null,
    }];
  }

  // Multi-provider
  const providers = model.providers!;
  if (providers.length === 0) {
    throw new EngineError(
      'No model providers configured. Add a provider to your EngineConfig or configure one in runcor.yaml. For testing, use MockProvider or type: mock.',
      'INVALID_CONFIG',
    );
  }

  const names = new Set<string>();
  const registrations: ProviderRegistration[] = [];

  for (const pc of providers) {
    const name = pc.provider.name;
    const priority = pc.priority ?? DEFAULTS.defaultPriority;

    if (names.has(name)) {
      throw new EngineError(
        `Duplicate provider name: "${name}".`,
        'DUPLICATE_PROVIDER',
      );
    }

    if (priority < 1) {
      throw new EngineError(
        `Provider "${name}" has invalid priority ${priority}. Priority must be >= 1.`,
        'INVALID_CONFIG',
      );
    }

    names.add(name);
    registrations.push({
      name,
      provider: pc.provider,
      priority,
      costPerToken: pc.costPerToken ?? null,
      models: pc.models ?? null,
    });
  }

  return registrations;
}

/** Options for file-based engine creation */
export interface CreateEngineOptions {
  /** Path to config file. Default: auto-detect runcor.yaml/yml in CWD */
  configPath?: string;
  /** Custom provider factories for YAML config loading */
  providerFactories?: Record<string, ProviderFactory>;
  /** Custom evaluator factories for YAML config loading */
  evaluatorFactories?: Record<string, EvaluatorFactory>;
}

/** Create and initialize an engine instance from a programmatic EngineConfig */
export async function createEngine(config: EngineConfig): Promise<Runcor>;
/** Create and initialize an engine by loading from a runcor.yaml config file */
export async function createEngine(options?: CreateEngineOptions): Promise<Runcor>;
/** @internal Implementation */
export async function createEngine(
  configOrOptions?: EngineConfig | CreateEngineOptions,
): Promise<Runcor> {
  let config: EngineConfig;

  if (configOrOptions && 'model' in configOrOptions) {
    // Programmatic EngineConfig — existing behavior
    config = configOrOptions as EngineConfig;
  } else {
    // Load from config file
    const options = configOrOptions as CreateEngineOptions | undefined;
    const loaded = await loadConfig({
      path: options?.configPath,
      providerFactories: options?.providerFactories,
      evaluatorFactories: options?.evaluatorFactories,
    });
    if (!loaded) {
      throw new EngineError(
        'No config file found. Provide an EngineConfig or create a runcor.yaml file.',
        'CONFIG_NOT_FOUND',
      );
    }
    config = loaded;
  }

  const registrations = buildProviderRegistrations(config);

  const engine = new Runcor(config, registrations);

  // Set ready status
  (engine as unknown as { status: EngineStatus }).status = 'ready';
  engine.emit('ready');

  // Connect adapters from config
  if (config.adapters?.adapters) {
    for (const adapterConfig of config.adapters.adapters) {
      await engine.addAdapter(adapterConfig);
    }
  }

  // Auto-start MCP server if configured
  if (config.server?.enabled) {
    await engine.startServer(config.server);
  }

  return engine;
}
