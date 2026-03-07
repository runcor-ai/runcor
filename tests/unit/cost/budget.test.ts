// Unit tests for BudgetEnforcer
// Per spec FR-003 through FR-006a, FR-013, FR-014, FR-017

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { BudgetEnforcer } from '../../../src/cost/budget.js';
import { BudgetExceededError } from '../../../src/errors.js';
import type { BudgetScopeConfig, CostConfig } from '../../../src/types.js';

describe('BudgetEnforcer', () => {
  let enforcer: BudgetEnforcer;

  beforeEach(() => {
    enforcer = new BudgetEnforcer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('checkBudgets() — hard enforcement', () => {
    it('blocks request when estimated cost exceeds per-request limit', () => {
      const budgets: CostConfig['budgets'] = {
        perRequest: { limit: 5, enforcement: 'hard' },
      };

      expect(() => {
        enforcer.checkBudgets(10, budgets, { flowName: 'f', userId: null }, 0.8);
      }).toThrow(BudgetExceededError);
    });

    it('allows request when estimated cost is under per-request limit', () => {
      const budgets: CostConfig['budgets'] = {
        perRequest: { limit: 10, enforcement: 'hard' },
      };

      const result = enforcer.checkBudgets(5, budgets, { flowName: 'f', userId: null }, 0.8);
      expect(result.allowed).toBe(true);
    });

    it('blocks per-user budget when accumulated spend exceeds limit', () => {
      const budgets: CostConfig['budgets'] = {
        perUser: { limit: 10, enforcement: 'hard', window: { type: 'daily' } },
      };

      // First request: reserve 8 units
      enforcer.reserveCost(8, ['user:alice']);

      // Second request: 5 units would exceed 10
      expect(() => {
        enforcer.checkBudgets(5, budgets, { flowName: 'f', userId: 'alice' }, 0.8);
      }).toThrow(BudgetExceededError);
    });

    it('blocks per-flow budget when accumulated spend exceeds limit', () => {
      const budgets: CostConfig['budgets'] = {
        perFlow: { limit: 20, enforcement: 'hard', window: { type: 'daily' } },
      };

      enforcer.reserveCost(18, ['flow:summarizer']);

      expect(() => {
        enforcer.checkBudgets(5, budgets, { flowName: 'summarizer', userId: null }, 0.8);
      }).toThrow(BudgetExceededError);
    });

    it('blocks global budget when accumulated spend exceeds limit', () => {
      const budgets: CostConfig['budgets'] = {
        global: { limit: 100, enforcement: 'hard', window: { type: 'daily' } },
      };

      enforcer.reserveCost(98, ['global']);

      expect(() => {
        enforcer.checkBudgets(5, budgets, { flowName: 'f', userId: null }, 0.8);
      }).toThrow(BudgetExceededError);
    });
  });

  describe('checkBudgets() — soft enforcement', () => {
    it('allows request but returns exceeded info for soft mode', () => {
      const budgets: CostConfig['budgets'] = {
        perRequest: { limit: 5, enforcement: 'soft' },
      };

      const result = enforcer.checkBudgets(10, budgets, { flowName: 'f', userId: null }, 0.8);
      expect(result.allowed).toBe(true);
      expect(result.exceeded).toBeDefined();
      expect(result.exceeded!.scope).toBe('request');
    });
  });

  describe('checkBudgets() — disabled enforcement', () => {
    it('skips check entirely for disabled budgets', () => {
      const budgets: CostConfig['budgets'] = {
        perRequest: { limit: 1, enforcement: 'disabled' },
      };

      const result = enforcer.checkBudgets(100, budgets, { flowName: 'f', userId: null }, 0.8);
      expect(result.allowed).toBe(true);
      expect(result.exceeded).toBeUndefined();
    });
  });

  describe('checkBudgets() — scope ordering', () => {
    it('checks scopes in order: request → user → flow → global (first failure wins)', () => {
      const budgets: CostConfig['budgets'] = {
        perRequest: { limit: 100, enforcement: 'hard' }, // passes
        perUser: { limit: 5, enforcement: 'hard', window: { type: 'daily' } }, // fails
        perFlow: { limit: 5, enforcement: 'hard', window: { type: 'daily' } }, // also fails
        global: { limit: 5, enforcement: 'hard', window: { type: 'daily' } }, // also fails
      };

      try {
        enforcer.checkBudgets(10, budgets, { flowName: 'f', userId: 'alice' }, 0.8);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BudgetExceededError);
        expect((err as BudgetExceededError).scope).toBe('user'); // first failing scope
      }
    });
  });

  describe('checkBudgets() — edge cases', () => {
    it('skips per-user budget when userId is null', () => {
      const budgets: CostConfig['budgets'] = {
        perUser: { limit: 1, enforcement: 'hard', window: { type: 'daily' } },
      };

      // Should not throw — per-user doesn't apply without userId
      const result = enforcer.checkBudgets(100, budgets, { flowName: 'f', userId: null }, 0.8);
      expect(result.allowed).toBe(true);
    });

    it('zero-limit budget blocks all requests in hard mode', () => {
      const budgets: CostConfig['budgets'] = {
        global: { limit: 0, enforcement: 'hard', window: { type: 'daily' } },
      };

      expect(() => {
        enforcer.checkBudgets(1, budgets, { flowName: 'f', userId: null }, 0.8);
      }).toThrow(BudgetExceededError);
    });
  });

  describe('reserveCost() and reconcileCost()', () => {
    it('reserveCost increments accumulators', () => {
      enforcer.reserveCost(10, ['global', 'user:alice']);
      // Verify via subsequent budget check
      const budgets: CostConfig['budgets'] = {
        global: { limit: 15, enforcement: 'hard', window: { type: 'daily' } },
      };
      // 10 reserved + 10 estimated = 20 > 15 limit
      expect(() => {
        enforcer.checkBudgets(10, budgets, { flowName: 'f', userId: null }, 0.8);
      }).toThrow(BudgetExceededError);
    });

    it('reconcileCost credits back overestimate', () => {
      enforcer.reserveCost(10, ['global']);
      enforcer.reconcileCost(10, 5, ['global']); // estimated 10, actual 5 → credit 5

      const budgets: CostConfig['budgets'] = {
        global: { limit: 10, enforcement: 'hard', window: { type: 'daily' } },
      };
      // After reconcile: 5 spend + 4 estimated = 9 <= 10
      const result = enforcer.checkBudgets(4, budgets, { flowName: 'f', userId: null }, 0.8);
      expect(result.allowed).toBe(true);
    });

    it('reconcileCost debits additional cost when actual exceeds estimate', () => {
      enforcer.reserveCost(5, ['global']);
      enforcer.reconcileCost(5, 10, ['global']); // estimated 5, actual 10 → debit 5 more

      const budgets: CostConfig['budgets'] = {
        global: { limit: 12, enforcement: 'hard', window: { type: 'daily' } },
      };
      // After reconcile: 10 total spend + 5 estimated = 15 > 12
      expect(() => {
        enforcer.checkBudgets(5, budgets, { flowName: 'f', userId: null }, 0.8);
      }).toThrow(BudgetExceededError);
    });
  });

  describe('time window reset', () => {
    it('resets accumulator when time window expires', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-27T12:00:00Z'));

      const budgets: CostConfig['budgets'] = {
        global: { limit: 10, enforcement: 'hard', window: { type: 'hourly' } },
      };

      // checkBudgets first to create accumulator with correct hourly window bounds
      enforcer.checkBudgets(1, budgets, { flowName: 'f', userId: null }, 0.8);
      enforcer.reserveCost(9, ['global']);

      // Advance past the hour boundary
      vi.setSystemTime(new Date('2026-02-27T13:00:01Z'));

      // After window reset, accumulator should be 0 — so 9 <= 10 is allowed
      const result = enforcer.checkBudgets(9, budgets, { flowName: 'f', userId: null }, 0.8);
      expect(result.allowed).toBe(true);
    });

    it('resets warningEmitted flag on window reset', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-27T12:00:00Z'));

      const budgets: CostConfig['budgets'] = {
        global: { limit: 100, enforcement: 'hard', window: { type: 'hourly' } },
      };

      // checkBudgets first to create accumulator with correct hourly window bounds
      enforcer.checkBudgets(1, budgets, { flowName: 'f', userId: null }, 0.8);
      // Accumulate to trigger warning level
      enforcer.reserveCost(85, ['global']);
      const result1 = enforcer.checkBudgets(1, budgets, { flowName: 'f', userId: null }, 0.8);
      expect(result1.warnings).toBeDefined();
      expect(result1.warnings!.length).toBeGreaterThan(0);

      // Check again — warning should NOT re-emit in same window
      const result2 = enforcer.checkBudgets(1, budgets, { flowName: 'f', userId: null }, 0.8);
      expect(result2.warnings?.length ?? 0).toBe(0);

      // Advance to new window — checkBudgets will reset the accumulator
      vi.setSystemTime(new Date('2026-02-27T13:00:01Z'));

      // checkBudgets triggers window reset (spend goes to 0)
      enforcer.checkBudgets(1, budgets, { flowName: 'f', userId: null }, 0.8);
      // Re-accumulate to warning level in the new window
      enforcer.reserveCost(85, ['global']);
      const result3 = enforcer.checkBudgets(1, budgets, { flowName: 'f', userId: null }, 0.8);
      expect(result3.warnings).toBeDefined();
      expect(result3.warnings!.length).toBeGreaterThan(0);
    });
  });

  describe('per-flow budget override', () => {
    it('uses per-flow override when provided', () => {
      const budgets: CostConfig['budgets'] = {
        perFlow: { limit: 100, enforcement: 'hard', window: { type: 'daily' } },
      };
      const flowBudget: BudgetScopeConfig = { limit: 5, enforcement: 'hard', window: { type: 'daily' } };

      // Flow override limit is 5, so 10 should fail
      expect(() => {
        enforcer.checkBudgets(10, budgets, { flowName: 'strict-flow', userId: null }, 0.8, flowBudget);
      }).toThrow(BudgetExceededError);
    });
  });
});
