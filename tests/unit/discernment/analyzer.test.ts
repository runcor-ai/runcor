// Unit tests for ModelAnalyzer

import { describe, it, expect, vi } from 'vitest';
import { ModelAnalyzer } from '../../../src/discernment/analyzer.js';
import { buildRecommendationSchema } from '../../../src/discernment/prompts.js';
import type { SystemProfile, Signal, Recommendation } from '../../../src/discernment/types.js';
import type { ModelRequest, ModelResponse } from '../../../src/model/provider.js';
import { BudgetExceededError } from '../../../src/errors.js';

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

function makeModelResponse(parsed: unknown): ModelResponse {
  return {
    text: JSON.stringify(parsed),
    model: 'mock-model',
    provider: 'mock',
    usage: { promptTokens: 100, completionTokens: 50 },
    parsed,
  };
}

function createMockRouter(response: ModelResponse) {
  return {
    complete: vi.fn().mockResolvedValue(response),
    stream: vi.fn(),
    getProviders: () => [],
    get lastResolvedProvider() { return 'mock'; },
    shutdown: vi.fn(),
  };
}

function createMockCostTracker(response: ModelResponse) {
  return {
    wrapComplete: vi.fn().mockResolvedValue(response),
  };
}

describe('ModelAnalyzer', () => {
  const validRecommendations = {
    recommendations: [
      {
        target: 'flow-a',
        targetType: 'flow',
        action: 'optimize',
        confidence: 0.8,
        explanation: 'Flow-a has high cost relative to value.',
        evidenceRefs: ['sig-1'],
      },
    ],
  };

  it('sends ModelRequest with system profile in prompt', async () => {
    const response = makeModelResponse(validRecommendations);
    const router = createMockRouter(response);
    const analyzer = new ModelAnalyzer({ router: router as any, costTracker: null, config: { enabled: true, autonomy: 'recommend', schedule: 'daily' } });

    const profile = makeSystemProfile({ totalCost: 42 });
    await analyzer.analyze(profile, []);

    expect(router.complete).toHaveBeenCalledTimes(1);
    const request = router.complete.mock.calls[0][0] as ModelRequest;
    expect(request.prompt).toContain('42');
  });

  it('uses responseFormat with recommendation schema', async () => {
    const response = makeModelResponse(validRecommendations);
    const router = createMockRouter(response);
    const analyzer = new ModelAnalyzer({ router: router as any, costTracker: null, config: { enabled: true, autonomy: 'recommend', schedule: 'daily' } });

    await analyzer.analyze(makeSystemProfile(), []);

    const request = router.complete.mock.calls[0][0] as ModelRequest;
    expect(request.responseFormat).toBeDefined();
    expect(typeof request.responseFormat).toBe('object');
  });

  it('pins to discernment provider when configured', async () => {
    const response = makeModelResponse(validRecommendations);
    const router = createMockRouter(response);
    const analyzer = new ModelAnalyzer({
      router: router as any,
      costTracker: null,
      config: { enabled: true, autonomy: 'recommend', schedule: 'daily', provider: 'anthropic' },
    });

    await analyzer.analyze(makeSystemProfile(), []);

    const request = router.complete.mock.calls[0][0] as ModelRequest;
    expect(request.provider).toBe('anthropic');
  });

  it('uses normal routing when no provider override', async () => {
    const response = makeModelResponse(validRecommendations);
    const router = createMockRouter(response);
    const analyzer = new ModelAnalyzer({
      router: router as any,
      costTracker: null,
      config: { enabled: true, autonomy: 'recommend', schedule: 'daily' },
    });

    await analyzer.analyze(makeSystemProfile(), []);

    const request = router.complete.mock.calls[0][0] as ModelRequest;
    expect(request.provider).toBeUndefined();
  });

  it('uses costTracker.wrapComplete when costTracker available', async () => {
    const response = makeModelResponse(validRecommendations);
    const costTracker = createMockCostTracker(response);
    const router = createMockRouter(response);
    const analyzer = new ModelAnalyzer({
      router: router as any,
      costTracker: costTracker as any,
      config: { enabled: true, autonomy: 'recommend', schedule: 'daily' },
    });

    await analyzer.analyze(makeSystemProfile(), []);

    // costTracker used instead of router
    expect(costTracker.wrapComplete).toHaveBeenCalledTimes(1);
    expect(router.complete).not.toHaveBeenCalled();

    // Verify __discernment flowName
    const context = costTracker.wrapComplete.mock.calls[0][1];
    expect(context.flowName).toBe('__discernment');
  });

  it('parses response.parsed into Recommendation[]', async () => {
    const response = makeModelResponse(validRecommendations);
    const router = createMockRouter(response);
    const analyzer = new ModelAnalyzer({ router: router as any, costTracker: null, config: { enabled: true, autonomy: 'recommend', schedule: 'daily' } });

    const result = await analyzer.analyze(makeSystemProfile(), []);

    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0].target).toBe('flow-a');
    expect(result.recommendations[0].action).toBe('optimize');
    expect(result.recommendations[0].confidence).toBe(0.8);
    expect(result.recommendations[0].status).toBe('pending');
    expect(result.recommendations[0].id).toBeDefined();
    expect(result.recommendations[0].createdAt).toBeInstanceOf(Date);
  });

  it('records parsing failure as ModelAnalysisResult with error', async () => {
    const badResponse: ModelResponse = {
      text: 'not valid json at all',
      model: 'mock-model',
      provider: 'mock',
      usage: { promptTokens: 100, completionTokens: 50 },
      // no .parsed — provider couldn't parse
    };
    const router = createMockRouter(badResponse);
    const analyzer = new ModelAnalyzer({ router: router as any, costTracker: null, config: { enabled: true, autonomy: 'recommend', schedule: 'daily' } });

    const result = await analyzer.analyze(makeSystemProfile(), []);

    expect(result.recommendations).toHaveLength(0);
    expect(result.modelAnalysis.success).toBe(false);
    expect(result.modelAnalysis.error).toBeTruthy();
  });

  it('model network error produces model-analysis-failed signal', async () => {
    const router = {
      complete: vi.fn().mockRejectedValue(new Error('Network timeout')),
      stream: vi.fn(),
      getProviders: () => [],
      get lastResolvedProvider() { return null; },
      shutdown: vi.fn(),
    };
    const analyzer = new ModelAnalyzer({ router: router as any, costTracker: null, config: { enabled: true, autonomy: 'recommend', schedule: 'daily' } });

    const result = await analyzer.analyze(makeSystemProfile(), []);

    expect(result.recommendations).toHaveLength(0);
    expect(result.modelAnalysis.success).toBe(false);
    expect(result.modelAnalysis.error).toContain('Network timeout');
    expect(result.signals).toBeDefined();
    expect(result.signals!.length).toBeGreaterThan(0);
    expect(result.signals![0].checkName).toBe('model-analysis-failed');
    expect(result.signals![0].targetType).toBe('system');
    expect(result.signals![0].severity).toBe('warning');
  });

  it('budget exceeded produces model-analysis-failed signal', async () => {
    const router = {
      complete: vi.fn().mockRejectedValue(new BudgetExceededError('flow', 10, 9.5, 2)),
      stream: vi.fn(),
      getProviders: () => [],
      get lastResolvedProvider() { return null; },
      shutdown: vi.fn(),
    };
    const analyzer = new ModelAnalyzer({ router: router as any, costTracker: null, config: { enabled: true, autonomy: 'recommend', schedule: 'daily' } });

    const result = await analyzer.analyze(makeSystemProfile(), []);

    expect(result.recommendations).toHaveLength(0);
    expect(result.modelAnalysis.success).toBe(false);
    expect(result.signals).toBeDefined();
    expect(result.signals![0].checkName).toBe('model-analysis-failed');
  });

  it('each recommendation has required fields', async () => {
    const multiRecs = {
      recommendations: [
        { target: 'flow-a', targetType: 'flow', action: 'keep', confidence: 0.9, explanation: 'Good.', evidenceRefs: [] },
        { target: 'flow-b', targetType: 'flow', action: 'retire', confidence: 0.7, explanation: 'Idle.', evidenceRefs: ['sig-1'] },
      ],
    };
    const response = makeModelResponse(multiRecs);
    const router = createMockRouter(response);
    const analyzer = new ModelAnalyzer({ router: router as any, costTracker: null, config: { enabled: true, autonomy: 'recommend', schedule: 'daily' } });

    const result = await analyzer.analyze(makeSystemProfile(), []);

    for (const rec of result.recommendations) {
      expect(rec.id).toBeTruthy();
      expect(rec.target).toBeTruthy();
      expect(rec.targetType).toBeTruthy();
      expect(rec.action).toBeTruthy();
      expect(typeof rec.confidence).toBe('number');
      expect(rec.explanation).toBeTruthy();
      expect(Array.isArray(rec.evidenceRefs)).toBe(true);
      expect(rec.status).toBe('pending');
      expect(rec.createdAt).toBeInstanceOf(Date);
    }
  });

  it('uses custom prompt when configured', async () => {
    const response = makeModelResponse(validRecommendations);
    const router = createMockRouter(response);
    const analyzer = new ModelAnalyzer({
      router: router as any,
      costTracker: null,
      config: { enabled: true, autonomy: 'recommend', schedule: 'daily', prompt: 'You are a custom analyst.' },
    });

    await analyzer.analyze(makeSystemProfile(), []);

    const request = router.complete.mock.calls[0][0] as ModelRequest;
    expect(request.prompt).toContain('You are a custom analyst.');
  });
});
