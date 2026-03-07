// BudgetEnforcer — multi-scope budget checking and enforcement

import type { BudgetScopeConfig, BudgetWindow, CostConfig } from '../types.js';
import { BudgetExceededError } from '../errors.js';

/** Runtime state for a budget accumulator */
interface BudgetAccumulator {
  currentSpend: number;
  windowStart: Date;
  windowEnd: Date;
  warningEmitted: boolean;
}

/** Context for budget checking */
export interface BudgetContext {
  flowName: string;
  userId: string | null;
}

/** Warning info returned from budget check */
export interface BudgetWarning {
  scope: 'user' | 'flow' | 'global';
  scopeKey: string;
  currentSpend: number;
  limit: number;
  warningThreshold: number;
  utilizationPercent: number;
}

/** Exceeded info returned from soft budget check */
export interface BudgetExceeded {
  scope: 'request' | 'user' | 'flow' | 'global';
  scopeKey: string;
  currentSpend: number;
  limit: number;
  enforcement: 'hard' | 'soft';
}

/** Result of budget checking */
export interface BudgetCheckResult {
  allowed: boolean;
  exceeded?: BudgetExceeded;
  warnings?: BudgetWarning[];
  applicableScopes: string[];
}

/**
 * BudgetEnforcer manages budget accumulators and enforces spending limits.
 * Accumulators are in-memory running totals, unaffected by ledger eviction.
 * Budget checking is synchronous within the same event loop tick.
 */
export class BudgetEnforcer {
  private readonly accumulators = new Map<string, BudgetAccumulator>();

  /**
   * Check all applicable budgets for a request.
   * Scopes are checked in order: request → user → flow → global.
   * First hard-mode failure throws BudgetExceededError.
   */
  checkBudgets(
    estimatedCost: number,
    budgets: CostConfig['budgets'],
    context: BudgetContext,
    warningThreshold: number,
    flowBudget?: BudgetScopeConfig,
  ): BudgetCheckResult {
    if (!budgets) return { allowed: true, applicableScopes: [] };

    const warnings: BudgetWarning[] = [];
    const applicableScopes: string[] = [];

    // Scope check order: per-request, per-user, per-flow, global
    const scopeChecks: Array<{
      scope: 'request' | 'user' | 'flow' | 'global';
      config: BudgetScopeConfig | undefined;
      scopeKey: string;
      skip: boolean;
    }> = [
      {
        scope: 'request',
        config: budgets.perRequest,
        scopeKey: 'request',
        skip: false,
      },
      {
        scope: 'user',
        config: budgets.perUser,
        scopeKey: context.userId ? `user:${context.userId}` : '',
        skip: context.userId === null,
      },
      {
        scope: 'flow',
        config: flowBudget ?? budgets.perFlow,
        scopeKey: `flow:${context.flowName}`,
        skip: false,
      },
      {
        scope: 'global',
        config: budgets.global,
        scopeKey: 'global',
        skip: false,
      },
    ];

    for (const { scope, config, scopeKey, skip } of scopeChecks) {
      if (!config || skip) continue;

      const enforcement = config.enforcement ?? 'hard';
      if (enforcement === 'disabled') continue;

      applicableScopes.push(scopeKey);

      // Per-request budgets check estimated cost directly (no accumulation)
      if (scope === 'request') {
        if (estimatedCost > config.limit) {
          if (enforcement === 'hard') {
            throw new BudgetExceededError(scope, config.limit, 0, estimatedCost);
          }
          return {
            allowed: true,
            exceeded: { scope, scopeKey, currentSpend: 0, limit: config.limit, enforcement },
            warnings,
            applicableScopes,
          };
        }
        continue;
      }

      // Accumulator-based scopes (user, flow, global)
      const accumulator = this.getOrCreateAccumulator(scopeKey, config.window);
      this.maybeResetWindow(accumulator, config.window);

      const currentSpend = accumulator.currentSpend;

      if (currentSpend + estimatedCost > config.limit) {
        if (enforcement === 'hard') {
          throw new BudgetExceededError(scope, config.limit, currentSpend, estimatedCost);
        }
        return {
          allowed: true,
          exceeded: { scope, scopeKey, currentSpend, limit: config.limit, enforcement },
          warnings,
          applicableScopes,
        };
      }

      // Check warning threshold (only for accumulator-based scopes)
      if (
        !accumulator.warningEmitted &&
        currentSpend + estimatedCost >= config.limit * warningThreshold
      ) {
        accumulator.warningEmitted = true;
        warnings.push({
          scope: scope as 'user' | 'flow' | 'global',
          scopeKey,
          currentSpend: currentSpend + estimatedCost,
          limit: config.limit,
          warningThreshold,
          utilizationPercent: (currentSpend + estimatedCost) / config.limit,
        });
      }
    }

    return { allowed: true, warnings, applicableScopes };
  }

  /** Reserve estimated cost in all applicable scope accumulators */
  reserveCost(amount: number, scopes: string[]): void {
    for (const scopeKey of scopes) {
      const acc = this.accumulators.get(scopeKey);
      if (acc) {
        acc.currentSpend += amount;
      } else {
        // Create accumulator on-demand (no window bounds yet — will be set on next check)
        this.accumulators.set(scopeKey, {
          currentSpend: amount,
          windowStart: new Date(),
          windowEnd: new Date(Date.now() + 86400000), // temporary, corrected on next check
          warningEmitted: false,
        });
      }
    }
  }

  /** Reconcile estimated cost with actual cost. Credit or debit the difference. */
  reconcileCost(estimatedCost: number, actualCost: number, scopes: string[]): void {
    const difference = estimatedCost - actualCost;
    for (const scopeKey of scopes) {
      const acc = this.accumulators.get(scopeKey);
      if (acc) {
        acc.currentSpend -= difference; // positive difference = credit, negative = debit
      }
    }
  }

  /** Get current spend for a scope (used for event payloads) */
  getCurrentSpend(scopeKey: string): number {
    return this.accumulators.get(scopeKey)?.currentSpend ?? 0;
  }

  private getOrCreateAccumulator(scopeKey: string, window?: BudgetWindow): BudgetAccumulator {
    let acc = this.accumulators.get(scopeKey);
    if (!acc) {
      const bounds = this.getWindowBounds(window);
      acc = {
        currentSpend: 0,
        windowStart: bounds.start,
        windowEnd: bounds.end,
        warningEmitted: false,
      };
      this.accumulators.set(scopeKey, acc);
    }
    return acc;
  }

  private maybeResetWindow(accumulator: BudgetAccumulator, window?: BudgetWindow): void {
    const now = Date.now();
    if (now >= accumulator.windowEnd.getTime()) {
      const bounds = this.getWindowBounds(window);
      accumulator.currentSpend = 0;
      accumulator.windowStart = bounds.start;
      accumulator.windowEnd = bounds.end;
      accumulator.warningEmitted = false;
    }
  }

  private getWindowBounds(window?: BudgetWindow): { start: Date; end: Date } {
    const now = Date.now();
    const type = window?.type ?? 'daily';

    switch (type) {
      case 'none':
        // No window = no accumulation boundary (effectively infinite window)
        return { start: new Date(0), end: new Date(Number.MAX_SAFE_INTEGER) };

      case 'hourly': {
        const hourStart = new Date(now);
        hourStart.setMinutes(0, 0, 0);
        const hourEnd = new Date(hourStart.getTime() + 3600000);
        return { start: hourStart, end: hourEnd };
      }

      case 'daily': {
        const dayStart = new Date(now);
        dayStart.setUTCHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart.getTime() + 86400000);
        return { start: dayStart, end: dayEnd };
      }

      case 'monthly': {
        const date = new Date(now);
        const monthStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
        const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
        return { start: monthStart, end: monthEnd };
      }

      case 'custom': {
        const durationMs = window!.durationMs!;
        // Epoch-aligned: windowStart = epoch + floor((now - epoch) / duration) * duration
        const windowIndex = Math.floor(now / durationMs);
        const start = new Date(windowIndex * durationMs);
        const end = new Date((windowIndex + 1) * durationMs);
        return { start, end };
      }

      default:
        return { start: new Date(now), end: new Date(now + 86400000) };
    }
  }
}
