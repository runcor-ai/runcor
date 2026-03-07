// CostTracker — orchestrates cost calculation, budgets, ledger, events

import type {
  BudgetScopeConfig,
  CostAccessor,
  CostBudgetExceededEvent,
  CostBudgetWarningEvent,
  CostConfig,
  CostEntry,
  CostLedgerStore,
  CostRequestEvent,
  ProviderRegistration,
} from '../types.js';
import type { ModelRequest, ModelResponse, ModelStream, StreamEvent } from '../model/provider.js';
import type { ModelRouter } from '../model/router.js';
import { calculateCost, estimateCost } from './calculator.js';
import { BudgetEnforcer } from './budget.js';

/** Default token estimate when maxTokens not specified */
const DEFAULT_TOKEN_ESTIMATE = 1000;
/** Default warning threshold (80%) */
const DEFAULT_WARNING_THRESHOLD = 0.8;

/** Context passed to wrapComplete for each request */
export interface CostContext {
  executionId: string;
  flowName: string;
  userId: string | null;
  /** Per-flow budget override (from FlowConfig.budget) */
  flowBudget?: BudgetScopeConfig;
}

/** Cost event types emitted by CostTracker */
export type CostEventType = 'cost:request' | 'cost:budget_warning' | 'cost:budget_exceeded';

/** Callback for cost events */
export type CostEventCallback = (
  type: CostEventType,
  payload: CostRequestEvent | CostBudgetWarningEvent | CostBudgetExceededEvent,
) => void;

/**
 * CostTracker wraps ModelRouter to intercept requests/responses for cost tracking.
 * Handles cost calculation, ledger recording, budget enforcement, and event emission.
 */
export class CostTracker {
  private readonly router: ModelRouter;
  private readonly ledger: CostLedgerStore;
  private readonly config: CostConfig;
  private readonly registrations: ProviderRegistration[];
  private readonly onCostEvent?: CostEventCallback;
  private readonly budgetEnforcer: BudgetEnforcer;
  private readonly warningThreshold: number;
  private readonly defaultTokenEstimate: number;

  constructor(
    router: ModelRouter,
    ledger: CostLedgerStore,
    config: CostConfig,
    registrations: ProviderRegistration[],
    onCostEvent?: CostEventCallback,
  ) {
    this.router = router;
    this.ledger = ledger;
    this.config = config;
    this.registrations = registrations;
    this.onCostEvent = onCostEvent;
    this.budgetEnforcer = new BudgetEnforcer();
    this.warningThreshold = config.warningThreshold ?? DEFAULT_WARNING_THRESHOLD;
    this.defaultTokenEstimate = config.defaultTokenEstimate ?? DEFAULT_TOKEN_ESTIMATE;
  }

  /**
   * Wrap a model.complete() call with cost tracking and budget enforcement.
   * 10-step flow per plan.md Integration Architecture.
   */
  async wrapComplete(request: ModelRequest, context: CostContext): Promise<ModelResponse> {
    // Resolve provider for cost estimation (use priority-first provider as default estimate)
    const estimateProvider = this.registrations[0];
    const estimateCostPerToken = estimateProvider?.costPerToken ?? null;

    // Step 1: Estimate cost (pre-request)
    // Compute prompt length from messages when prompt absent
    const promptLength = this.computePromptLength(request);
    const estimated = estimateCost(
      promptLength,
      request.maxTokens,
      estimateCostPerToken,
      this.defaultTokenEstimate,
    );

    // Step 2: Check budgets (pre-request enforcement)
    const applicableScopes: string[] = [];
    if (this.config.budgets) {
      const budgetContext = { flowName: context.flowName, userId: context.userId };
      const checkResult = this.budgetEnforcer.checkBudgets(
        estimated,
        this.config.budgets,
        budgetContext,
        this.warningThreshold,
        context.flowBudget,
      );
      // BudgetExceededError is thrown by checkBudgets for hard mode

      // Emit events for soft-exceeded budgets
      if (checkResult.exceeded && this.onCostEvent) {
        try {
          this.onCostEvent('cost:budget_exceeded', {
            scope: checkResult.exceeded.scope,
            scopeKey: checkResult.exceeded.scopeKey,
            currentSpend: checkResult.exceeded.currentSpend,
            limit: checkResult.exceeded.limit,
            enforcement: checkResult.exceeded.enforcement,
            blocked: false,
            timestamp: new Date(),
          });
        } catch {
          // Events are best-effort
        }
      }

      // Emit warning events
      if (checkResult.warnings && this.onCostEvent) {
        for (const warning of checkResult.warnings) {
          try {
            this.onCostEvent('cost:budget_warning', {
              scope: warning.scope,
              scopeKey: warning.scopeKey,
              currentSpend: warning.currentSpend,
              limit: warning.limit,
              warningThreshold: warning.warningThreshold,
              utilizationPercent: warning.utilizationPercent,
              timestamp: new Date(),
            });
          } catch {
            // Events are best-effort
          }
        }
      }

      applicableScopes.push(...checkResult.applicableScopes);
    }

    // Step 3: Reserve estimated cost in accumulators
    if (applicableScopes.length > 0) {
      this.budgetEnforcer.reserveCost(estimated, applicableScopes);
    }

    // Step 4: Call ModelRouter.complete(request)
    const response = await this.router.complete(request);

    // Step 5: Calculate actual cost from response.usage
    const providerName = this.router.lastResolvedProvider ?? response.provider;
    const registration = this.registrations.find((r) => r.name === providerName);
    const costPerToken = registration?.costPerToken ?? null;

    const actualCost = calculateCost(
      response.usage.promptTokens,
      response.usage.completionTokens,
      costPerToken,
    );

    // Step 6: Reconcile estimated vs actual cost
    if (applicableScopes.length > 0) {
      this.budgetEnforcer.reconcileCost(estimated, actualCost, applicableScopes);
    }

    // Step 7: Record CostEntry in ledger (graceful degradation)
    const entry: CostEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      provider: providerName,
      model: response.model,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      cost: actualCost,
      executionId: context.executionId,
      flowName: context.flowName,
      userId: context.userId,
    };

    try {
      this.ledger.record(entry);
    } catch {
      // Cost recording failures silently absorbed, accumulators retain reservation
      return response;
    }

    // Step 8: Emit cost:request event
    if (this.onCostEvent) {
      try {
        this.onCostEvent('cost:request', {
          provider: entry.provider,
          model: entry.model,
          promptTokens: entry.promptTokens,
          completionTokens: entry.completionTokens,
          cost: entry.cost,
          executionId: entry.executionId,
          flowName: entry.flowName,
          userId: entry.userId,
          timestamp: entry.timestamp,
        });
      } catch {
        // Events are best-effort
      }
    }

    // Step 9: Check budget warning thresholds (post-request)
    if (this.config.budgets && this.onCostEvent) {
      const postCtx = { flowName: context.flowName, userId: context.userId };
      // Re-check with zero cost just to evaluate warning thresholds after reconciliation
      const postCheck = this.budgetEnforcer.checkBudgets(
        0,
        this.config.budgets,
        postCtx,
        this.warningThreshold,
        context.flowBudget,
      );
      if (postCheck.warnings) {
        for (const warning of postCheck.warnings) {
          try {
            this.onCostEvent('cost:budget_warning', {
              scope: warning.scope,
              scopeKey: warning.scopeKey,
              currentSpend: warning.currentSpend,
              limit: warning.limit,
              warningThreshold: warning.warningThreshold,
              utilizationPercent: warning.utilizationPercent,
              timestamp: new Date(),
            });
          } catch {
            // Events are best-effort
          }
        }
      }
    }

    // Step 10: Return response to flow
    return response;
  }

  /**
   * Compute prompt length from request.
   * Uses prompt.length when prompt is present, otherwise concatenates message contents.
   */
  private computePromptLength(request: ModelRequest): number {
    if (request.prompt) {
      return request.prompt.length;
    }
    if (request.messages && request.messages.length > 0) {
      return request.messages.map(m => m.content).join('').length;
    }
    return 0;
  }

  /**
   * Wrap a model.stream() call with cost tracking and budget enforcement.
   * Budget pre-checked before stream opens. Cost recorded after stream completes.
   * If stream errors mid-way, no cost entry is recorded (no usage data).
   */
  wrapStream(request: ModelRequest, context: CostContext): ModelStream {
    const estimateProvider = this.registrations[0];
    const estimateCostPerToken = estimateProvider?.costPerToken ?? null;

    // Step 1: Estimate and pre-check budget (same as wrapComplete)
    const promptLength = this.computePromptLength(request);
    const estimated = estimateCost(
      promptLength,
      request.maxTokens,
      estimateCostPerToken,
      this.defaultTokenEstimate,
    );

    // Step 2: Check budgets
    const applicableScopes: string[] = [];
    if (this.config.budgets) {
      const budgetContext = { flowName: context.flowName, userId: context.userId };
      const checkResult = this.budgetEnforcer.checkBudgets(
        estimated,
        this.config.budgets,
        budgetContext,
        this.warningThreshold,
        context.flowBudget,
      );
      applicableScopes.push(...checkResult.applicableScopes);
    }

    // Step 3: Reserve estimated cost
    if (applicableScopes.length > 0) {
      this.budgetEnforcer.reserveCost(estimated, applicableScopes);
    }

    // Step 4: Get stream from router
    const innerStream = this.router.stream(request);

    // Step 5-10: Wrap the stream to track cost on completion
    const self = this;
    const wrappedResponse = innerStream.response.then(
      (response) => {
        // Calculate actual cost
        const providerName = self.router.lastResolvedProvider ?? response.provider;
        const registration = self.registrations.find(r => r.name === providerName);
        const costPerToken = registration?.costPerToken ?? null;
        const actualCost = calculateCost(response.usage.promptTokens, response.usage.completionTokens, costPerToken);

        // Reconcile
        if (applicableScopes.length > 0) {
          self.budgetEnforcer.reconcileCost(estimated, actualCost, applicableScopes);
        }

        // Record entry
        const entry: CostEntry = {
          id: crypto.randomUUID(),
          timestamp: new Date(),
          provider: providerName,
          model: response.model,
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          cost: actualCost,
          executionId: context.executionId,
          flowName: context.flowName,
          userId: context.userId,
        };

        try {
          self.ledger.record(entry);
        } catch {
          return response;
        }

        // Emit cost:request event
        if (self.onCostEvent) {
          try {
            self.onCostEvent('cost:request', {
              provider: entry.provider,
              model: entry.model,
              promptTokens: entry.promptTokens,
              completionTokens: entry.completionTokens,
              cost: entry.cost,
              executionId: entry.executionId,
              flowName: entry.flowName,
              userId: entry.userId,
              timestamp: entry.timestamp,
            });
          } catch {
            // Events are best-effort
          }
        }

        return response;
      },
      (error) => {
        // Stream errored mid-way — no cost recorded (no usage data)
        // Release reservation
        if (applicableScopes.length > 0) {
          self.budgetEnforcer.reconcileCost(estimated, 0, applicableScopes);
        }
        throw error;
      },
    );

    return {
      [Symbol.asyncIterator]: () => innerStream[Symbol.asyncIterator](),
      response: wrappedResponse,
    };
  }

  /** Get the ledger instance (for getCostLedger()) */
  getLedger(): CostLedgerStore {
    return this.ledger;
  }
}

/**
 * Create a CostAccessor for a specific execution.
 * Returns read-only object with lazily-computed executionTotal and requestCount.
 */
export function createCostAccessor(
  ledger: CostLedgerStore,
  executionId: string,
): CostAccessor {
  return {
    get executionTotal(): number {
      return ledger.getTotal({ executionId });
    },
    get requestCount(): number {
      return ledger.query({ executionId }).length;
    },
  };
}
