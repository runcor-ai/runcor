// Unit tests for HeuristicAnalyzer

import { describe, it, expect } from 'vitest';
import { HeuristicAnalyzer } from '../../../src/discernment/heuristics.js';
import type {
  FlowProfile,
  SystemProfile,
  Signal,
  HeuristicThresholds,
  Objective,
} from '../../../src/discernment/types.js';

function makeProfile(overrides: Partial<FlowProfile> & { flowName: string }): FlowProfile {
  return {
    cost: { totalCost: 0, costTrend: 'stable', costPercentOfTotal: 0, requestCount: 0 },
    quality: { averageScore: null, scoreTrend: null, humanReviewFlagCount: 0, evaluationCount: 0 },
    execution: { totalExecutions: 0, completeCount: 0, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 0 },
    policy: { violationCount: 0, violationTypes: {}, rateLimitHitCount: 0 },
    agent: null,
    provider: { providerDistribution: {}, fallbackFrequency: 0 },
    schedule: null,
    adapter: { adaptersUsed: [], toolsUsed: [], toolCallCount: 0 },
    memory: { activeScopeCount: 0, scopeNames: [] },
    mcpServer: null,
    objective: null,
    secondaryObjectives: [],
    ...overrides,
  };
}

function makeSystemProfile(
  flowProfiles: FlowProfile[],
  overrides: Partial<SystemProfile> = {},
): SystemProfile {
  return {
    timestamp: new Date(),
    lookbackPeriod: 604800,
    flowProfiles,
    objectiveSummaries: [],
    orphanFlows: flowProfiles.filter(fp => !fp.objective).map(fp => fp.flowName),
    unservedObjectives: [],
    totalCost: flowProfiles.reduce((s, fp) => s + fp.cost.totalCost, 0),
    totalExecutions: flowProfiles.reduce((s, fp) => s + fp.execution.totalExecutions, 0),
    ...overrides,
  };
}

describe('HeuristicAnalyzer', () => {
  describe('idle-flow', () => {
    it('fires for zero executions', () => {
      const analyzer = new HeuristicAnalyzer();
      const profiles = [makeProfile({ flowName: 'idle-flow' })];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);

      const idle = signals.find(s => s.checkName === 'idle-flow');
      expect(idle).toBeDefined();
      expect(idle!.target).toBe('idle-flow');
      expect(idle!.targetType).toBe('flow');
      expect(idle!.severity).toBe('warning');
    });

    it('does not fire for flows with executions', () => {
      const analyzer = new HeuristicAnalyzer();
      const profiles = [
        makeProfile({
          flowName: 'active-flow',
          execution: { totalExecutions: 5, completeCount: 5, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1 },
        }),
      ];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);
      expect(signals.find(s => s.checkName === 'idle-flow')).toBeUndefined();
    });
  });

  describe('disproportionate-cost', () => {
    it('fires when costPercentOfTotal exceeds threshold (default 30%)', () => {
      const analyzer = new HeuristicAnalyzer();
      const profiles = [
        makeProfile({
          flowName: 'expensive-flow',
          cost: { totalCost: 50, costTrend: 'stable', costPercentOfTotal: 0.5, requestCount: 10 },
          execution: { totalExecutions: 10, completeCount: 10, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1 },
        }),
      ];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);

      const cost = signals.find(s => s.checkName === 'disproportionate-cost');
      expect(cost).toBeDefined();
      expect(cost!.severity).toBe('warning');
      expect(cost!.evidence).toHaveProperty('costPercentOfTotal', 0.5);
    });

    it('does not fire below threshold', () => {
      const analyzer = new HeuristicAnalyzer();
      const profiles = [
        makeProfile({
          flowName: 'cheap-flow',
          cost: { totalCost: 5, costTrend: 'stable', costPercentOfTotal: 0.1, requestCount: 2 },
          execution: { totalExecutions: 2, completeCount: 2, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1 },
        }),
      ];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);
      expect(signals.find(s => s.checkName === 'disproportionate-cost')).toBeUndefined();
    });
  });

  describe('quality-declining', () => {
    it('fires when scoreTrend is declining', () => {
      const analyzer = new HeuristicAnalyzer();
      const profiles = [
        makeProfile({
          flowName: 'degrading-flow',
          quality: { averageScore: 0.4, scoreTrend: 'declining', humanReviewFlagCount: 0, evaluationCount: 10 },
          execution: { totalExecutions: 10, completeCount: 10, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1 },
        }),
      ];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);

      const quality = signals.find(s => s.checkName === 'quality-declining');
      expect(quality).toBeDefined();
      expect(quality!.severity).toBe('warning');
    });

    it('does not fire when quality is stable', () => {
      const analyzer = new HeuristicAnalyzer();
      const profiles = [
        makeProfile({
          flowName: 'stable-flow',
          quality: { averageScore: 0.8, scoreTrend: 'stable', humanReviewFlagCount: 0, evaluationCount: 10 },
          execution: { totalExecutions: 10, completeCount: 10, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1 },
        }),
      ];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);
      expect(signals.find(s => s.checkName === 'quality-declining')).toBeUndefined();
    });
  });

  describe('orphan-flow', () => {
    it('fires for untagged flows', () => {
      const analyzer = new HeuristicAnalyzer();
      const profiles = [makeProfile({ flowName: 'orphan', objective: null })];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);

      const orphan = signals.find(s => s.checkName === 'orphan-flow');
      expect(orphan).toBeDefined();
      expect(orphan!.severity).toBe('info');
    });

    it('does not fire for tagged flows', () => {
      const analyzer = new HeuristicAnalyzer();
      const profiles = [makeProfile({ flowName: 'tagged', objective: 'retention' })];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);
      expect(signals.find(s => s.checkName === 'orphan-flow')).toBeUndefined();
    });
  });

  describe('unserved-objective', () => {
    it('fires for objectives with no flows', () => {
      const analyzer = new HeuristicAnalyzer();
      const profiles: FlowProfile[] = [];
      const system = makeSystemProfile(profiles, {
        unservedObjectives: ['abandoned-goal'],
      });

      const signals = analyzer.analyze(profiles, system);

      const unserved = signals.find(s => s.checkName === 'unserved-objective');
      expect(unserved).toBeDefined();
      expect(unserved!.target).toBe('abandoned-goal');
      expect(unserved!.targetType).toBe('objective');
      expect(unserved!.severity).toBe('info');
    });
  });

  describe('agent-hard-stop-pattern', () => {
    it('fires when hardStopRate exceeds threshold (default 50%)', () => {
      const analyzer = new HeuristicAnalyzer();
      const profiles = [
        makeProfile({
          flowName: 'stuck-agent',
          agent: { averageIterations: 20, hardStopRate: 0.6, stopReasonDistribution: { max_iterations: 6, completed: 4 } },
          execution: { totalExecutions: 10, completeCount: 4, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 0.4 },
        }),
      ];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);

      const hardStop = signals.find(s => s.checkName === 'agent-hard-stop-pattern');
      expect(hardStop).toBeDefined();
      expect(hardStop!.severity).toBe('critical');
      expect(hardStop!.evidence).toHaveProperty('hardStopRate', 0.6);
    });

    it('does not fire for non-agent flows', () => {
      const analyzer = new HeuristicAnalyzer();
      const profiles = [
        makeProfile({
          flowName: 'normal-flow',
          agent: null,
          execution: { totalExecutions: 10, completeCount: 10, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1 },
        }),
      ];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);
      expect(signals.find(s => s.checkName === 'agent-hard-stop-pattern')).toBeUndefined();
    });
  });

  describe('schedule-overlap', () => {
    it('fires for same-cadence flows sharing adapter tools', () => {
      const analyzer = new HeuristicAnalyzer();
      const profiles = [
        makeProfile({
          flowName: 'flow-a',
          schedule: { cronExpression: '0 0 * * *', lastFiredAt: null, nextFireTime: new Date(), overlapFlows: [] },
          adapter: { adaptersUsed: ['crm'], toolsUsed: ['crm.search', 'crm.update'], toolCallCount: 5 },
          execution: { totalExecutions: 5, completeCount: 5, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1 },
        }),
        makeProfile({
          flowName: 'flow-b',
          schedule: { cronExpression: '0 0 * * *', lastFiredAt: null, nextFireTime: new Date(), overlapFlows: [] },
          adapter: { adaptersUsed: ['crm'], toolsUsed: ['crm.search', 'crm.list'], toolCallCount: 3 },
          execution: { totalExecutions: 3, completeCount: 3, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1 },
        }),
      ];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);

      const overlap = signals.find(s => s.checkName === 'schedule-overlap');
      expect(overlap).toBeDefined();
      expect(overlap!.severity).toBe('info');
    });
  });

  describe('unused-mcp-tool', () => {
    it('fires for exposed flow with zero invocations', () => {
      const analyzer = new HeuristicAnalyzer();
      const profiles = [
        makeProfile({
          flowName: 'exposed-unused',
          mcpServer: { externalInvocationCount: 0 },
          execution: { totalExecutions: 5, completeCount: 5, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1 },
        }),
      ];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);

      const unused = signals.find(s => s.checkName === 'unused-mcp-tool');
      expect(unused).toBeDefined();
      expect(unused!.severity).toBe('info');
    });

    it('does not fire when invocations exist', () => {
      const analyzer = new HeuristicAnalyzer();
      const profiles = [
        makeProfile({
          flowName: 'exposed-used',
          mcpServer: { externalInvocationCount: 3 },
          execution: { totalExecutions: 5, completeCount: 5, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1 },
        }),
      ];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);
      expect(signals.find(s => s.checkName === 'unused-mcp-tool')).toBeUndefined();
    });
  });

  describe('adapter-overlap', () => {
    it('fires for non-scheduled flows sharing >50% tools', () => {
      const analyzer = new HeuristicAnalyzer();
      const profiles = [
        makeProfile({
          flowName: 'flow-x',
          adapter: { adaptersUsed: ['crm'], toolsUsed: ['crm.search', 'crm.update', 'crm.list'], toolCallCount: 6 },
          execution: { totalExecutions: 5, completeCount: 5, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1 },
        }),
        makeProfile({
          flowName: 'flow-y',
          adapter: { adaptersUsed: ['crm'], toolsUsed: ['crm.search', 'crm.update'], toolCallCount: 4 },
          execution: { totalExecutions: 3, completeCount: 3, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1 },
        }),
      ];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);

      const overlap = signals.find(s => s.checkName === 'adapter-overlap');
      expect(overlap).toBeDefined();
      expect(overlap!.severity).toBe('info');
    });
  });

  describe('healthy flows', () => {
    it('produces no signals for healthy flows', () => {
      const analyzer = new HeuristicAnalyzer();
      const profiles = [
        makeProfile({
          flowName: 'healthy',
          objective: 'retention',
          cost: { totalCost: 5, costTrend: 'stable', costPercentOfTotal: 0.1, requestCount: 5 },
          quality: { averageScore: 0.9, scoreTrend: 'stable', humanReviewFlagCount: 0, evaluationCount: 5 },
          execution: { totalExecutions: 10, completeCount: 10, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1 },
        }),
      ];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);
      expect(signals).toHaveLength(0);
    });
  });

  describe('configurable thresholds', () => {
    it('overrides default thresholds', () => {
      const thresholds: HeuristicThresholds = { disproportionateCostPercent: 0.8 };
      const analyzer = new HeuristicAnalyzer(thresholds);
      const profiles = [
        makeProfile({
          flowName: 'somewhat-expensive',
          cost: { totalCost: 30, costTrend: 'stable', costPercentOfTotal: 0.5, requestCount: 10 },
          execution: { totalExecutions: 10, completeCount: 10, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1 },
          objective: 'test',
        }),
      ];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);
      // 0.5 < 0.8 threshold, so should not fire
      expect(signals.find(s => s.checkName === 'disproportionate-cost')).toBeUndefined();
    });

    it('threshold 0 fires for everything', () => {
      const thresholds: HeuristicThresholds = { disproportionateCostPercent: 0 };
      const analyzer = new HeuristicAnalyzer(thresholds);
      const profiles = [
        makeProfile({
          flowName: 'any-cost',
          cost: { totalCost: 1, costTrend: 'stable', costPercentOfTotal: 0.01, requestCount: 1 },
          execution: { totalExecutions: 1, completeCount: 1, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1 },
          objective: 'test',
        }),
      ];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);
      expect(signals.find(s => s.checkName === 'disproportionate-cost')).toBeDefined();
    });

    it('threshold 1.0 effectively disables check', () => {
      const thresholds: HeuristicThresholds = { disproportionateCostPercent: 1.0 };
      const analyzer = new HeuristicAnalyzer(thresholds);
      const profiles = [
        makeProfile({
          flowName: 'expensive',
          cost: { totalCost: 99, costTrend: 'stable', costPercentOfTotal: 0.99, requestCount: 50 },
          execution: { totalExecutions: 50, completeCount: 50, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1 },
          objective: 'test',
        }),
      ];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);
      expect(signals.find(s => s.checkName === 'disproportionate-cost')).toBeUndefined();
    });
  });

  describe('signal shape', () => {
    it('each signal includes id, checkName, target, targetType, severity, evidence, timestamp', () => {
      const analyzer = new HeuristicAnalyzer();
      const profiles = [makeProfile({ flowName: 'idle' })];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);
      expect(signals.length).toBeGreaterThan(0);

      for (const signal of signals) {
        expect(typeof signal.id).toBe('string');
        expect(signal.id.length).toBeGreaterThan(0);
        expect(typeof signal.checkName).toBe('string');
        expect(typeof signal.target).toBe('string');
        expect(['flow', 'objective', 'system']).toContain(signal.targetType);
        expect(['info', 'warning', 'critical']).toContain(signal.severity);
        expect(signal.evidence).toBeDefined();
        expect(signal.timestamp).toBeInstanceOf(Date);
      }
    });
  });

  describe('custom heuristics', () => {
    it('registers and executes custom heuristic', () => {
      const analyzer = new HeuristicAnalyzer();
      analyzer.addHeuristic({
        name: 'custom-check',
        check: (profile, _system) => {
          if (profile.execution.failedCount > 5) {
            return [{
              id: 'custom-1',
              checkName: 'custom-check',
              target: profile.flowName,
              targetType: 'flow' as const,
              severity: 'warning' as const,
              evidence: { failedCount: profile.execution.failedCount },
              timestamp: new Date(),
            }];
          }
          return [];
        },
      });

      const profiles = [
        makeProfile({
          flowName: 'failing-flow',
          execution: { totalExecutions: 10, completeCount: 4, failedCount: 6, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 0.4 },
          objective: 'test',
        }),
      ];
      const system = makeSystemProfile(profiles);

      const signals = analyzer.analyze(profiles, system);
      const custom = signals.find(s => s.checkName === 'custom-check');
      expect(custom).toBeDefined();
      expect(custom!.evidence).toHaveProperty('failedCount', 6);
    });

    it('custom heuristic error is caught, other heuristics continue', () => {
      const analyzer = new HeuristicAnalyzer();
      analyzer.addHeuristic({
        name: 'broken-check',
        check: () => {
          throw new Error('Custom heuristic crashed');
        },
      });

      const profiles = [makeProfile({ flowName: 'idle-flow' })];
      const system = makeSystemProfile(profiles);

      // Should not throw — error is caught internally
      const signals = analyzer.analyze(profiles, system);
      // Built-in idle-flow check still fires
      expect(signals.find(s => s.checkName === 'idle-flow')).toBeDefined();
    });

    it('rejects duplicate heuristic name', () => {
      const analyzer = new HeuristicAnalyzer();
      analyzer.addHeuristic({ name: 'unique', check: () => [] });

      try {
        analyzer.addHeuristic({ name: 'unique', check: () => [] });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('DUPLICATE_HEURISTIC');
      }
    });

    it('removes custom heuristic', () => {
      const analyzer = new HeuristicAnalyzer();
      analyzer.addHeuristic({
        name: 'removable',
        check: (_profile, _system) => [{
          id: 'r1',
          checkName: 'removable',
          target: 'any',
          targetType: 'flow' as const,
          severity: 'info' as const,
          evidence: {},
          timestamp: new Date(),
        }],
      });

      const profiles = [makeProfile({ flowName: 'flow-a', objective: 'test', execution: { totalExecutions: 1, completeCount: 1, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1 } })];
      const system = makeSystemProfile(profiles);

      let signals = analyzer.analyze(profiles, system);
      expect(signals.find(s => s.checkName === 'removable')).toBeDefined();

      analyzer.removeHeuristic('removable');

      signals = analyzer.analyze(profiles, system);
      expect(signals.find(s => s.checkName === 'removable')).toBeUndefined();
    });
  });
});
