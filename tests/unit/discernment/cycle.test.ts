// Unit tests for cycle orchestration in DiscernmentEngine

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscernmentEngine } from '../../../src/discernment/engine.js';
import type {
  DiscernmentConfig,
  FlowProfile,
  SystemProfile,
  Signal,
  Recommendation,
  Objective,
} from '../../../src/discernment/types.js';

function makeConfig(overrides: Partial<DiscernmentConfig> = {}): DiscernmentConfig {
  return {
    enabled: true,
    autonomy: 'recommend',
    schedule: 'daily',
    ...overrides,
  };
}

function makeProfile(name: string): FlowProfile {
  return {
    flowName: name,
    cost: { totalCost: 10, costTrend: 'stable', costPercentOfTotal: 0.5, requestCount: 5 },
    quality: { averageScore: 0.8, scoreTrend: 'stable', humanReviewFlagCount: 0, evaluationCount: 5 },
    execution: { totalExecutions: 10, completeCount: 8, failedCount: 2, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 0.8 },
    policy: { violationCount: 0, violationTypes: {}, rateLimitHitCount: 0 },
    agent: null,
    provider: { providerDistribution: {}, fallbackFrequency: 0 },
    schedule: null,
    adapter: { adaptersUsed: [], toolsUsed: [], toolCallCount: 0 },
    memory: { activeScopeCount: 0, scopeNames: [] },
    mcpServer: null,
    objective: 'retention',
    secondaryObjectives: [],
  };
}

function createMockDeps() {
  const profiles = [makeProfile('flow-a'), makeProfile('flow-b')];
  const objectives: Objective[] = [
    { name: 'retention', description: 'Reduce churn', primaryFlows: ['flow-a', 'flow-b'], secondaryFlows: [] },
  ];

  return {
    collector: {
      collectCostSignals: vi.fn().mockReturnValue(profiles[0].cost),
      collectQualitySignals: vi.fn().mockReturnValue(profiles[0].quality),
      collectExecutionSignals: vi.fn().mockResolvedValue(profiles[0].execution),
      collectPolicySignals: vi.fn().mockReturnValue(profiles[0].policy),
      collectAdapterSignals: vi.fn().mockReturnValue(profiles[0].adapter),
      collectMemorySignals: vi.fn().mockResolvedValue(profiles[0].memory),
      collectMcpServerSignals: vi.fn().mockReturnValue(null),
      collectScheduleSignals: vi.fn().mockReturnValue(null),
    },
    profiler: {
      buildSystemProfile: vi.fn().mockReturnValue({
        timestamp: new Date(),
        lookbackPeriod: 604800,
        flowProfiles: profiles,
        objectiveSummaries: [],
        orphanFlows: [],
        unservedObjectives: [],
        totalCost: 20,
        totalExecutions: 20,
      } as SystemProfile),
    },
    heuristicAnalyzer: {
      analyze: vi.fn().mockReturnValue([]),
    },
    modelAnalyzer: {
      analyze: vi.fn().mockResolvedValue({
        recommendations: [{
          id: 'rec-1',
          target: 'flow-a',
          targetType: 'flow' as const,
          action: 'optimize' as const,
          confidence: 0.8,
          explanation: 'High cost.',
          evidenceRefs: [],
          status: 'pending' as const,
          createdAt: new Date(),
        }],
        modelAnalysis: { provider: 'mock', model: 'gpt-4', cost: 0.01, success: true, error: null },
      }),
    },
    objectiveRegistry: {
      listObjectives: vi.fn().mockReturnValue(objectives),
      listOrphanFlows: vi.fn().mockReturnValue([]),
    },
    flowRegistry: new Map([['flow-a', { name: 'flow-a' }], ['flow-b', { name: 'flow-b' }]]),
    emitEvent: vi.fn(),
  };
}

describe('DiscernmentEngine — Cycle Orchestration', () => {
  describe('runCycle', () => {
    it('runs full cycle: collect → profile → heuristics → model → report → events', async () => {
      const deps = createMockDeps();
      const engine = new DiscernmentEngine(makeConfig(), deps as any);

      const report = await engine.runCycle();

      expect(report).toBeDefined();
      expect(report.id).toBeTruthy();
      expect(report.autonomy).toBe('recommend');
      expect(report.systemProfile).toBeDefined();
      expect(report.recommendations.length).toBeGreaterThan(0);
      expect(report.modelAnalysis).toBeDefined();
    });

    it('emits discernment:signal for each signal', async () => {
      const deps = createMockDeps();
      const signals: Signal[] = [
        { id: 's1', checkName: 'idle-flow', target: 'flow-c', targetType: 'flow', severity: 'warning', evidence: {}, timestamp: new Date() },
      ];
      deps.heuristicAnalyzer.analyze.mockReturnValue(signals);
      const engine = new DiscernmentEngine(makeConfig(), deps as any);

      await engine.runCycle();

      const signalCalls = deps.emitEvent.mock.calls.filter(
        (c: any[]) => c[0] === 'discernment:signal',
      );
      expect(signalCalls.length).toBe(1);
    });

    it('emits discernment:recommendation for each recommendation', async () => {
      const deps = createMockDeps();
      const engine = new DiscernmentEngine(makeConfig(), deps as any);

      await engine.runCycle();

      const recCalls = deps.emitEvent.mock.calls.filter(
        (c: any[]) => c[0] === 'discernment:recommendation',
      );
      expect(recCalls.length).toBe(1);
    });

    it('emits discernment:cycle with full report', async () => {
      const deps = createMockDeps();
      const engine = new DiscernmentEngine(makeConfig(), deps as any);

      await engine.runCycle();

      const cycleCalls = deps.emitEvent.mock.calls.filter(
        (c: any[]) => c[0] === 'discernment:cycle',
      );
      expect(cycleCalls.length).toBe(1);
    });

    it('observe mode skips model analysis and recommendations', async () => {
      const deps = createMockDeps();
      const engine = new DiscernmentEngine(makeConfig({ autonomy: 'observe' }), deps as any);

      const report = await engine.runCycle();

      expect(deps.modelAnalyzer.analyze).not.toHaveBeenCalled();
      expect(report.recommendations).toHaveLength(0);
      expect(report.modelAnalysis).toBeNull();
    });

    it('concurrent cycle rejected with CYCLE_IN_PROGRESS', async () => {
      const deps = createMockDeps();
      // Make model analysis slow but still return valid result
      deps.modelAnalyzer.analyze.mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({
          recommendations: [],
          modelAnalysis: { provider: 'mock', model: 'gpt-4', cost: 0, success: true, error: null },
        }), 100)),
      );
      const engine = new DiscernmentEngine(makeConfig(), deps as any);

      const first = engine.runCycle();

      try {
        await engine.runCycle();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('CYCLE_IN_PROGRESS');
      }

      // Wait for first to complete
      await first;
    });

    it('DISCERNMENT_DISABLED when disabled', async () => {
      const engine = new DiscernmentEngine(makeConfig({ enabled: false }));

      try {
        await engine.runCycle();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('DISCERNMENT_DISABLED');
      }
    });

    it('zero signals produces empty signals array, model still runs', async () => {
      const deps = createMockDeps();
      deps.heuristicAnalyzer.analyze.mockReturnValue([]);
      const engine = new DiscernmentEngine(makeConfig(), deps as any);

      const report = await engine.runCycle();

      expect(report.signals).toHaveLength(0);
      expect(deps.modelAnalyzer.analyze).toHaveBeenCalled();
    });

    it('stores report for retrieval after cycle', async () => {
      const deps = createMockDeps();
      const engine = new DiscernmentEngine(makeConfig(), deps as any);

      const report = await engine.runCycle();
      const retrieved = engine.getReport(report.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(report.id);
    });
  });
});
