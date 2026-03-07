// Unit tests for FlowProfiler

import { describe, it, expect } from 'vitest';
import { FlowProfiler } from '../../../src/discernment/profiler.js';
import type { FlowProfile, Objective } from '../../../src/discernment/types.js';

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

describe('FlowProfiler', () => {
  const profiler = new FlowProfiler();

  describe('buildSystemProfile', () => {
    it('groups flows by primary objective', () => {
      const profiles: FlowProfile[] = [
        makeProfile({ flowName: 'flow-a', objective: 'retention', cost: { totalCost: 10, costTrend: 'stable', costPercentOfTotal: 0.5, requestCount: 5 }, execution: { totalExecutions: 10, completeCount: 8, failedCount: 2, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 0.8 } }),
        makeProfile({ flowName: 'flow-b', objective: 'retention', cost: { totalCost: 5, costTrend: 'stable', costPercentOfTotal: 0.25, requestCount: 3 }, execution: { totalExecutions: 5, completeCount: 5, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1.0 } }),
        makeProfile({ flowName: 'flow-c', objective: 'visibility', cost: { totalCost: 5, costTrend: 'stable', costPercentOfTotal: 0.25, requestCount: 2 } }),
      ];
      const objectives: Objective[] = [
        { name: 'retention', description: 'Reduce churn', primaryFlows: ['flow-a', 'flow-b'], secondaryFlows: [] },
        { name: 'visibility', description: 'Dashboards', primaryFlows: ['flow-c'], secondaryFlows: [] },
      ];

      const systemProfile = profiler.buildSystemProfile(profiles, objectives, 604800);

      expect(systemProfile.objectiveSummaries).toHaveLength(2);
      const retention = systemProfile.objectiveSummaries.find(s => s.objectiveName === 'retention');
      expect(retention!.flowCount).toBe(2);
      expect(retention!.totalCost).toBe(15);
      expect(retention!.totalExecutions).toBe(15);
      expect(retention!.primaryFlowNames).toEqual(['flow-a', 'flow-b']);
    });

    it('computes engine-wide totals', () => {
      const profiles: FlowProfile[] = [
        makeProfile({ flowName: 'flow-a', cost: { totalCost: 10, costTrend: 'stable', costPercentOfTotal: 0.5, requestCount: 5 }, execution: { totalExecutions: 10, completeCount: 8, failedCount: 2, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 0.8 } }),
        makeProfile({ flowName: 'flow-b', cost: { totalCost: 20, costTrend: 'stable', costPercentOfTotal: 0.5, requestCount: 10 }, execution: { totalExecutions: 20, completeCount: 20, failedCount: 0, timeoutCount: 0, waitingCount: 0, resumeCount: 0, successRate: 1.0 } }),
      ];

      const systemProfile = profiler.buildSystemProfile(profiles, [], 604800);

      expect(systemProfile.totalCost).toBe(30);
      expect(systemProfile.totalExecutions).toBe(30);
    });

    it('detects orphan flows', () => {
      const profiles: FlowProfile[] = [
        makeProfile({ flowName: 'flow-orphan', objective: null }),
        makeProfile({ flowName: 'flow-tagged', objective: 'retention' }),
      ];

      const systemProfile = profiler.buildSystemProfile(profiles, [
        { name: 'retention', description: 'desc', primaryFlows: ['flow-tagged'], secondaryFlows: [] },
      ], 604800);

      expect(systemProfile.orphanFlows).toContain('flow-orphan');
      expect(systemProfile.orphanFlows).not.toContain('flow-tagged');
    });

    it('detects unserved objectives', () => {
      const profiles: FlowProfile[] = [
        makeProfile({ flowName: 'flow-a', objective: 'retention' }),
      ];
      const objectives: Objective[] = [
        { name: 'retention', description: 'desc', primaryFlows: ['flow-a'], secondaryFlows: [] },
        { name: 'empty', description: 'desc', primaryFlows: [], secondaryFlows: [] },
      ];

      const systemProfile = profiler.buildSystemProfile(profiles, objectives, 604800);

      expect(systemProfile.unservedObjectives).toContain('empty');
      expect(systemProfile.unservedObjectives).not.toContain('retention');
    });

    it('includes secondary objective contributions', () => {
      const profiles: FlowProfile[] = [
        makeProfile({ flowName: 'flow-a', objective: 'retention', secondaryObjectives: ['visibility'], cost: { totalCost: 10, costTrend: 'stable', costPercentOfTotal: 1, requestCount: 5 } }),
      ];
      const objectives: Objective[] = [
        { name: 'retention', description: 'desc', primaryFlows: ['flow-a'], secondaryFlows: [] },
        { name: 'visibility', description: 'desc', primaryFlows: [], secondaryFlows: ['flow-a'] },
      ];

      const systemProfile = profiler.buildSystemProfile(profiles, objectives, 604800);

      const visibility = systemProfile.objectiveSummaries.find(s => s.objectiveName === 'visibility');
      expect(visibility!.secondaryFlowNames).toContain('flow-a');
      expect(visibility!.flowNames).toContain('flow-a');
    });

    it('handles all-orphan scenario', () => {
      const profiles: FlowProfile[] = [
        makeProfile({ flowName: 'flow-a', objective: null }),
        makeProfile({ flowName: 'flow-b', objective: null }),
      ];

      const systemProfile = profiler.buildSystemProfile(profiles, [], 604800);

      expect(systemProfile.orphanFlows).toEqual(['flow-a', 'flow-b']);
      expect(systemProfile.objectiveSummaries).toEqual([]);
    });

    it('handles zero-activity profile', () => {
      const profiles: FlowProfile[] = [
        makeProfile({ flowName: 'flow-idle' }),
      ];

      const systemProfile = profiler.buildSystemProfile(profiles, [], 604800);

      expect(systemProfile.totalCost).toBe(0);
      expect(systemProfile.totalExecutions).toBe(0);
    });
  });
});
