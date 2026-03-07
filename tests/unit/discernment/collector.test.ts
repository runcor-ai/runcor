// Unit tests for SignalCollector

import { describe, it, expect } from 'vitest';
import { SignalCollector } from '../../../src/discernment/collector.js';
import type {
  CostSignals,
  QualitySignals,
  ExecutionSignals,
  PolicySignals,
  AgentSignals,
  ProviderSignals,
  ScheduleSignals,
  AdapterSignals,
  MemorySignals,
  McpServerSignals,
} from '../../../src/discernment/types.js';

// Minimal mock deps for SignalCollector
function createMockDeps(overrides: Record<string, unknown> = {}) {
  return {
    costLedger: overrides.costLedger ?? null,
    evaluationEngine: overrides.evaluationEngine ?? null,
    stateStore: overrides.stateStore ?? null,
    accumulator: overrides.accumulator ?? { getViolations: () => [], getToolCalls: () => [], getMcpInvocations: () => [] },
    scheduler: overrides.scheduler ?? null,
    memoryStore: overrides.memoryStore ?? null,
    flowRegistry: overrides.flowRegistry ?? new Map(),
  } as any;
}

describe('SignalCollector', () => {
  describe('collectCostSignals', () => {
    it('returns cost signals from cost ledger', () => {
      const entries = [
        { flowName: 'flow-a', cost: 10, provider: 'openai' },
        { flowName: 'flow-a', cost: 15, provider: 'openai' },
        { flowName: 'flow-b', cost: 5, provider: 'anthropic' },
      ];
      const deps = createMockDeps({
        costLedger: {
          query: (filter: any) => entries.filter(e => !filter.flowName || e.flowName === filter.flowName),
          getTotal: (filter: any) => {
            const filtered = entries.filter(e => !filter.flowName || e.flowName === filter.flowName);
            return filtered.reduce((sum, e) => sum + e.cost, 0);
          },
        },
      });
      const collector = new SignalCollector(deps);
      const signals = collector.collectCostSignals('flow-a', new Date(0), 30);

      expect(signals.totalCost).toBe(25);
      expect(signals.requestCount).toBe(2);
      expect(signals.costPercentOfTotal).toBeCloseTo(25 / 30);
    });

    it('returns neutral defaults when no cost ledger', () => {
      const collector = new SignalCollector(createMockDeps());
      const signals = collector.collectCostSignals('flow-a', new Date(0), 0);

      expect(signals.totalCost).toBe(0);
      expect(signals.requestCount).toBe(0);
      expect(signals.costPercentOfTotal).toBe(0);
      expect(signals.costTrend).toBe('stable');
    });
  });

  describe('collectQualitySignals', () => {
    it('returns quality signals from evaluation records', () => {
      const records = [
        { flowName: 'flow-a', overallScore: 0.8, timestamp: new Date('2026-01-15') },
        { flowName: 'flow-a', overallScore: 0.6, timestamp: new Date('2026-02-15') },
      ];
      const deps = createMockDeps({
        evaluationEngine: {
          listEvaluations: (filter: any) => records.filter(r =>
            (!filter?.flowName || r.flowName === filter.flowName) &&
            (!filter?.startTime || r.timestamp >= filter.startTime)
          ),
          listFlags: () => [],
        },
      });
      const collector = new SignalCollector(deps);
      const signals = collector.collectQualitySignals('flow-a', new Date(0));

      expect(signals.averageScore).toBeCloseTo(0.7);
      expect(signals.evaluationCount).toBe(2);
    });

    it('returns null averageScore when no evaluations', () => {
      const deps = createMockDeps({
        evaluationEngine: {
          listEvaluations: () => [],
          listFlags: () => [],
        },
      });
      const collector = new SignalCollector(deps);
      const signals = collector.collectQualitySignals('flow-a', new Date(0));

      expect(signals.averageScore).toBeNull();
      expect(signals.scoreTrend).toBeNull();
      expect(signals.evaluationCount).toBe(0);
    });
  });

  describe('collectExecutionSignals', () => {
    it('returns execution counts from state store', () => {
      const executions = [
        { flowName: 'flow-a', state: 'complete' },
        { flowName: 'flow-a', state: 'complete' },
        { flowName: 'flow-a', state: 'failed' },
        { flowName: 'flow-a', state: 'waiting' },
      ];
      const deps = createMockDeps({
        stateStore: {
          list: (filter: any) => Promise.resolve(
            executions.filter(e => !filter?.flowName || e.flowName === filter.flowName)
          ),
        },
      });
      const collector = new SignalCollector(deps);
      return collector.collectExecutionSignals('flow-a').then(signals => {
        expect(signals.totalExecutions).toBe(4);
        expect(signals.completeCount).toBe(2);
        expect(signals.failedCount).toBe(1);
        expect(signals.waitingCount).toBe(1);
        expect(signals.successRate).toBeCloseTo(0.5);
      });
    });

    it('handles missing state store gracefully', async () => {
      const collector = new SignalCollector(createMockDeps());
      const signals = await collector.collectExecutionSignals('flow-a');

      expect(signals.totalExecutions).toBe(0);
      expect(signals.successRate).toBe(0);
    });
  });

  describe('collectPolicySignals', () => {
    it('returns violation counts from accumulator', () => {
      const violations = [
        { payload: { ruleName: 'deny-rule' } },
        { payload: { ruleName: 'deny-rule' } },
        { payload: { ruleName: 'another-rule', _type: 'rate_limited' } },
      ];
      const deps = createMockDeps({
        accumulator: {
          getViolations: () => violations,
          getToolCalls: () => [],
          getMcpInvocations: () => [],
        },
      });
      const collector = new SignalCollector(deps);
      const signals = collector.collectPolicySignals('flow-a', new Date(0));

      expect(signals.violationCount).toBe(3);
      expect(signals.rateLimitHitCount).toBe(1);
    });
  });

  describe('missing subsystem neutral defaults (FR-023)', () => {
    it('returns neutral defaults for all signal types', async () => {
      const collector = new SignalCollector(createMockDeps());

      const cost = collector.collectCostSignals('flow-a', new Date(0), 0);
      expect(cost.totalCost).toBe(0);

      const quality = collector.collectQualitySignals('flow-a', new Date(0));
      expect(quality.averageScore).toBeNull();

      const exec = await collector.collectExecutionSignals('flow-a');
      expect(exec.totalExecutions).toBe(0);

      const policy = collector.collectPolicySignals('flow-a', new Date(0));
      expect(policy.violationCount).toBe(0);

      const adapter = collector.collectAdapterSignals('flow-a', new Date(0));
      expect(adapter.toolCallCount).toBe(0);

      const memory = await collector.collectMemorySignals('flow-a');
      expect(memory.activeScopeCount).toBe(0);
    });
  });
});
