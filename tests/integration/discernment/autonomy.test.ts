// Integration tests for autonomy levels

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscernmentEngine, type DiscernmentDeps } from '../../../src/discernment/engine.js';
import type {
  DiscernmentConfig,
  FlowProfile,
  Objective,
  Recommendation,
  Signal,
  SystemProfile,
} from '../../../src/discernment/types.js';

function makeConfig(overrides: Partial<DiscernmentConfig> = {}): DiscernmentConfig {
  return {
    enabled: true,
    autonomy: 'recommend',
    schedule: 'daily',
    gracePeriod: 1, // 1 second for fast tests
    ...overrides,
  };
}

function makeProfile(name: string, overrides: Partial<FlowProfile> = {}): FlowProfile {
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
    ...overrides,
  };
}

function createMockDeps(recommendations: Recommendation[] = []) {
  const profiles = [makeProfile('flow-a')];
  const objectives: Objective[] = [
    { name: 'retention', description: 'Reduce churn', primaryFlows: ['flow-a'], secondaryFlows: [] },
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
        totalCost: 10,
        totalExecutions: 10,
      } as SystemProfile),
    },
    heuristicAnalyzer: {
      analyze: vi.fn().mockReturnValue([]),
    },
    modelAnalyzer: {
      analyze: vi.fn().mockResolvedValue({
        recommendations,
        modelAnalysis: { provider: 'mock', model: 'gpt-4', cost: 0.01, success: true, error: null },
      }),
    },
    objectiveRegistry: {
      listObjectives: vi.fn().mockReturnValue(objectives),
      listOrphanFlows: vi.fn().mockReturnValue([]),
    },
    flowRegistry: new Map([['flow-a', { name: 'flow-a' }]]),
    emitEvent: vi.fn(),
  };
}

describe('Autonomy Levels', () => {
  describe('observe mode', () => {
    it('produces profiles and signals only — no model call, no recommendations', async () => {
      const deps = createMockDeps();
      const engine = new DiscernmentEngine(makeConfig({ autonomy: 'observe' }), deps as any);

      const report = await engine.runCycle();

      expect(deps.modelAnalyzer.analyze).not.toHaveBeenCalled();
      expect(report.recommendations).toHaveLength(0);
      expect(report.modelAnalysis).toBeNull();
      expect(report.autonomy).toBe('observe');
    });
  });

  describe('recommend mode', () => {
    it('produces recommendations surfaced via events, no automated actions', async () => {
      const recs: Recommendation[] = [{
        id: 'rec-1', target: 'flow-a', targetType: 'flow', action: 'optimize',
        confidence: 0.8, explanation: 'High cost.', evidenceRefs: [], status: 'pending', createdAt: new Date(),
      }];
      const deps = createMockDeps(recs);
      const engine = new DiscernmentEngine(makeConfig({ autonomy: 'recommend' }), deps as any);

      const report = await engine.runCycle();

      expect(report.recommendations).toHaveLength(1);
      expect(deps.emitEvent).toHaveBeenCalledWith('discernment:recommendation', expect.anything());
    });
  });

  describe('advise mode', () => {
    it('blocks next cycle until all recommendations acknowledged/dismissed', async () => {
      const recs: Recommendation[] = [{
        id: 'rec-advise', target: 'flow-a', targetType: 'flow', action: 'optimize',
        confidence: 0.7, explanation: 'Test.', evidenceRefs: [], status: 'pending', createdAt: new Date(),
      }];
      const deps = createMockDeps(recs);
      const engine = new DiscernmentEngine(makeConfig({ autonomy: 'advise' }), deps as any);

      // First cycle succeeds
      await engine.runCycle();

      // Second cycle should be blocked because recommendations are pending
      try {
        await engine.runCycle();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('ADVISE_GATE_PENDING');
      }
    });

    it('advise gate clears when all recs acknowledged', async () => {
      const recs: Recommendation[] = [{
        id: 'rec-ack', target: 'flow-a', targetType: 'flow', action: 'optimize',
        confidence: 0.7, explanation: 'Test.', evidenceRefs: [], status: 'pending', createdAt: new Date(),
      }];
      const deps = createMockDeps(recs);
      const engine = new DiscernmentEngine(makeConfig({ autonomy: 'advise' }), deps as any);

      await engine.runCycle();
      engine.acknowledgeRecommendation('rec-ack');

      // Now next cycle should succeed
      const report2 = await engine.runCycle();
      expect(report2).toBeDefined();
    });

    it('advise gate clears when all recs dismissed', async () => {
      const recs: Recommendation[] = [{
        id: 'rec-dis', target: 'flow-a', targetType: 'flow', action: 'optimize',
        confidence: 0.7, explanation: 'Test.', evidenceRefs: [], status: 'pending', createdAt: new Date(),
      }];
      const deps = createMockDeps(recs);
      const engine = new DiscernmentEngine(makeConfig({ autonomy: 'advise' }), deps as any);

      await engine.runCycle();
      engine.dismissRecommendation('rec-dis');

      const report2 = await engine.runCycle();
      expect(report2).toBeDefined();
    });

    it('advise gate clears with mix of acknowledged and dismissed', async () => {
      const recs: Recommendation[] = [
        { id: 'r1', target: 'flow-a', targetType: 'flow', action: 'optimize', confidence: 0.7, explanation: 'T.', evidenceRefs: [], status: 'pending', createdAt: new Date() },
        { id: 'r2', target: 'flow-b', targetType: 'flow', action: 'retire', confidence: 0.6, explanation: 'T.', evidenceRefs: [], status: 'pending', createdAt: new Date() },
      ];
      const deps = createMockDeps(recs);
      const engine = new DiscernmentEngine(makeConfig({ autonomy: 'advise' }), deps as any);

      await engine.runCycle();
      engine.acknowledgeRecommendation('r1');
      engine.dismissRecommendation('r2');

      const report2 = await engine.runCycle();
      expect(report2).toBeDefined();
    });
  });

  describe('enforce mode', () => {
    it('auto-executes retire after grace period for enforceable flows', async () => {
      vi.useFakeTimers();
      try {
        const recs: Recommendation[] = [{
          id: 'rec-retire', target: 'flow-enforceable', targetType: 'flow', action: 'retire',
          confidence: 0.9, explanation: 'Idle flow.', evidenceRefs: [], status: 'pending', createdAt: new Date(),
        }];
        const deps = createMockDeps(recs);
        deps.flowRegistry.set('flow-enforceable', { name: 'flow-enforceable' });
        const unregisterFn = vi.fn();
        const engine = new DiscernmentEngine(
          makeConfig({ autonomy: 'enforce', gracePeriod: 1 }),
          deps as any,
          { enforceableFlows: new Set(['flow-enforceable']), unregister: unregisterFn },
        );

        await engine.runCycle();

        // Before grace period
        expect(unregisterFn).not.toHaveBeenCalled();

        // After grace period
        vi.advanceTimersByTime(1500);
        expect(unregisterFn).toHaveBeenCalledWith('flow-enforceable');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does NOT auto-execute for non-enforceable flows', async () => {
      vi.useFakeTimers();
      try {
        const recs: Recommendation[] = [{
          id: 'rec-nonenf', target: 'flow-protected', targetType: 'flow', action: 'retire',
          confidence: 0.9, explanation: 'Idle flow.', evidenceRefs: [], status: 'pending', createdAt: new Date(),
        }];
        const deps = createMockDeps(recs);
        deps.flowRegistry.set('flow-protected', { name: 'flow-protected' });
        const unregisterFn = vi.fn();
        const engine = new DiscernmentEngine(
          makeConfig({ autonomy: 'enforce', gracePeriod: 1 }),
          deps as any,
          { enforceableFlows: new Set(), unregister: unregisterFn },
        );

        await engine.runCycle();
        vi.advanceTimersByTime(2000);

        expect(unregisterFn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does NOT auto-execute merge/investigate/escalate actions', async () => {
      vi.useFakeTimers();
      try {
        const recs: Recommendation[] = [{
          id: 'rec-inv', target: 'flow-enforceable', targetType: 'flow', action: 'investigate',
          confidence: 0.9, explanation: 'Needs review.', evidenceRefs: [], status: 'pending', createdAt: new Date(),
        }];
        const deps = createMockDeps(recs);
        deps.flowRegistry.set('flow-enforceable', { name: 'flow-enforceable' });
        const unregisterFn = vi.fn();
        const engine = new DiscernmentEngine(
          makeConfig({ autonomy: 'enforce', gracePeriod: 1 }),
          deps as any,
          { enforceableFlows: new Set(['flow-enforceable']), unregister: unregisterFn },
        );

        await engine.runCycle();
        vi.advanceTimersByTime(2000);

        expect(unregisterFn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('overrideRecommendation cancels grace timer', async () => {
      vi.useFakeTimers();
      try {
        const recs: Recommendation[] = [{
          id: 'rec-cancel', target: 'flow-enforceable', targetType: 'flow', action: 'retire',
          confidence: 0.9, explanation: 'Idle flow.', evidenceRefs: [], status: 'pending', createdAt: new Date(),
        }];
        const deps = createMockDeps(recs);
        deps.flowRegistry.set('flow-enforceable', { name: 'flow-enforceable' });
        const unregisterFn = vi.fn();
        const engine = new DiscernmentEngine(
          makeConfig({ autonomy: 'enforce', gracePeriod: 2 }),
          deps as any,
          { enforceableFlows: new Set(['flow-enforceable']), unregister: unregisterFn },
        );

        await engine.runCycle();

        // Override before grace period expires
        engine.overrideRecommendation('rec-cancel', 'Not needed');
        vi.advanceTimersByTime(3000);

        expect(unregisterFn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
