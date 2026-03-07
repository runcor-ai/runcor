// Unit tests for discernment prompt builder

import { describe, it, expect } from 'vitest';
import { buildDefaultPrompt, buildRecommendationSchema } from '../../../src/discernment/prompts.js';
import type { SystemProfile, Signal, FlowProfile, ObjectiveSummary } from '../../../src/discernment/types.js';

function makeFlowProfile(name: string, overrides: Partial<FlowProfile> = {}): FlowProfile {
  return {
    flowName: name,
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

function makeSystemProfile(overrides: Partial<SystemProfile> = {}): SystemProfile {
  return {
    timestamp: new Date('2026-03-01'),
    lookbackPeriod: 604800,
    flowProfiles: [],
    objectiveSummaries: [],
    orphanFlows: [],
    unservedObjectives: [],
    totalCost: 0,
    totalExecutions: 0,
    ...overrides,
  };
}

function makeSignal(overrides: Partial<Signal> & { checkName: string }): Signal {
  return {
    id: 'sig-1',
    target: 'flow-a',
    targetType: 'flow',
    severity: 'warning',
    evidence: {},
    timestamp: new Date('2026-03-01'),
    ...overrides,
  };
}

describe('buildDefaultPrompt', () => {
  it('includes role instruction', () => {
    const prompt = buildDefaultPrompt(makeSystemProfile(), []);
    expect(prompt).toContain('operations advisor');
  });

  it('includes engine summary with total flows, cost, and time window', () => {
    const profile = makeSystemProfile({
      totalCost: 42.5,
      totalExecutions: 100,
      flowProfiles: [
        makeFlowProfile('flow-a'),
        makeFlowProfile('flow-b'),
      ],
    });
    const prompt = buildDefaultPrompt(profile, []);

    expect(prompt).toContain('2'); // 2 flows
    expect(prompt).toContain('42.5'); // total cost
    expect(prompt).toContain('604800'); // lookback period
  });

  it('includes objective summaries with flow details', () => {
    const profile = makeSystemProfile({
      objectiveSummaries: [
        {
          objectiveName: 'retention',
          description: 'Reduce churn',
          flowCount: 3,
          totalCost: 25,
          averageQuality: 0.85,
          totalExecutions: 50,
          flowNames: ['flow-a', 'flow-b', 'flow-c'],
          primaryFlowNames: ['flow-a', 'flow-b'],
          secondaryFlowNames: ['flow-c'],
        },
      ],
    });
    const prompt = buildDefaultPrompt(profile, []);

    expect(prompt).toContain('retention');
    expect(prompt).toContain('Reduce churn');
  });

  it('includes heuristic signals as pre-identified issues', () => {
    const signals: Signal[] = [
      makeSignal({ checkName: 'idle-flow', target: 'flow-orphan', severity: 'warning', evidence: { totalExecutions: 0 } }),
      makeSignal({ checkName: 'disproportionate-cost', target: 'flow-expensive', severity: 'warning', evidence: { costPercentOfTotal: 0.5 } }),
    ];
    const prompt = buildDefaultPrompt(makeSystemProfile(), signals);

    expect(prompt).toContain('idle-flow');
    expect(prompt).toContain('disproportionate-cost');
  });

  it('includes JSON output format instruction', () => {
    const prompt = buildDefaultPrompt(makeSystemProfile(), []);
    expect(prompt).toMatch(/JSON/i);
  });

  it('includes confidence scale guidance', () => {
    const prompt = buildDefaultPrompt(makeSystemProfile(), []);
    expect(prompt).toContain('confidence');
  });

  it('includes action types guidance', () => {
    const prompt = buildDefaultPrompt(makeSystemProfile(), []);
    expect(prompt).toContain('keep');
    expect(prompt).toContain('optimize');
    expect(prompt).toContain('retire');
    expect(prompt).toContain('investigate');
  });
});

describe('buildRecommendationSchema', () => {
  it('returns a valid JSON schema object', () => {
    const schema = buildRecommendationSchema();
    expect(schema).toHaveProperty('type', 'object');
    expect(schema).toHaveProperty('properties');
  });

  it('defines recommendations array with required fields', () => {
    const schema = buildRecommendationSchema();
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('recommendations');

    const recsSchema = props.recommendations as Record<string, unknown>;
    expect(recsSchema).toHaveProperty('type', 'array');
  });
});
