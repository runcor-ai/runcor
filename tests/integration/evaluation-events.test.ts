// Integration tests for evaluation events
// Tests: eval:score, eval:complete, eval:flagged events, no events with zero evaluators

import { describe, it, expect, vi } from 'vitest';
import { createEngine } from '../../src/engine.js';
import type { ModelProvider, EvalScoreEvent, EvalCompleteEvent, EvalFlaggedEvent } from '../../src/types.js';

function createMockProvider(): ModelProvider {
  return {
    name: 'mock',
    complete: vi.fn().mockResolvedValue({
      content: 'mock response',
      model: 'mock',
      provider: 'mock',
      usage: { promptTokens: 10, completionTokens: 10 },
    }),
  };
}

describe('Evaluation Events Integration', () => {
  it('should emit eval:score per evaluator with correct payload', async () => {
    const engine = await createEngine({
      model: { provider: createMockProvider() },
    });

    engine.register('echo', async (ctx) => `echo: ${ctx.input}`);

    const scoreEvents: EvalScoreEvent[] = [];
    engine.on('eval:score', (event) => scoreEvents.push(event));

    engine.addEvaluator({
      name: 'scorer-a',
      priority: 1,
      evaluate: async () => ({
        scores: { relevance: 0.9 },
        labels: ['good'],
      }),
    });
    engine.addEvaluator({
      name: 'scorer-b',
      priority: 2,
      evaluate: async () => ({
        scores: { accuracy: 0.7 },
      }),
    });

    const execution = await engine.trigger('echo', {
      idempotencyKey: 'event-score-test',
      input: 'test',
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(scoreEvents).toHaveLength(2);

    const eventA = scoreEvents.find((e) => e.evaluatorName === 'scorer-a');
    expect(eventA).toBeDefined();
    expect(eventA!.executionId).toBe(execution.id);
    expect(eventA!.flowName).toBe('echo');
    expect(eventA!.scores.relevance).toBeCloseTo(0.9, 5);
    expect(eventA!.labels).toEqual(['good']);
    expect(eventA!.durationMs).toBeGreaterThanOrEqual(0);

    const eventB = scoreEvents.find((e) => e.evaluatorName === 'scorer-b');
    expect(eventB).toBeDefined();
    expect(eventB!.scores.accuracy).toBeCloseTo(0.7, 5);
  });

  it('should emit eval:complete after all evaluators finish with aggregate data', async () => {
    const engine = await createEngine({
      model: { provider: createMockProvider() },
    });

    engine.register('echo', async (ctx) => `echo: ${ctx.input}`);

    const completeEvents: EvalCompleteEvent[] = [];
    engine.on('eval:complete', (event) => completeEvents.push(event));

    engine.addEvaluator({
      name: 'eval-1',
      priority: 1,
      evaluate: async () => ({
        scores: { relevance: 0.8, coherence: 0.6 },
      }),
    });

    const execution = await engine.trigger('echo', {
      idempotencyKey: 'event-complete-test',
      input: 'test',
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0].executionId).toBe(execution.id);
    expect(completeEvents[0].flowName).toBe('echo');
    expect(completeEvents[0].evaluatorCount).toBe(1);
    expect(completeEvents[0].errorCount).toBe(0);
    expect(completeEvents[0].aggregateScores.relevance).toBeCloseTo(0.8, 5);
    expect(completeEvents[0].aggregateScores.coherence).toBeCloseTo(0.6, 5);
    expect(completeEvents[0].timestamp).toBeInstanceOf(Date);
  });

  it('should emit eval:flagged when auto-flagging triggers', async () => {
    const engine = await createEngine({
      model: { provider: createMockProvider() },
    });

    engine.register('echo', async (ctx) => `echo: ${ctx.input}`);

    const flagEvents: EvalFlaggedEvent[] = [];
    engine.on('eval:flagged', (event) => flagEvents.push(event));

    engine.addEvaluator({
      name: 'low-scorer',
      priority: 1,
      evaluate: async () => ({
        scores: { relevance: 0.2 },
      }),
    });

    const execution = await engine.trigger('echo', {
      idempotencyKey: 'event-flag-test',
      input: 'test',
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(flagEvents.length).toBeGreaterThanOrEqual(1);
    const flagEvent = flagEvents.find((e) => e.executionId === execution.id);
    expect(flagEvent).toBeDefined();
    expect(flagEvent!.source).toBe('auto');
    expect(flagEvent!.status).toBe('pending');
    expect(flagEvent!.reason).toContain('low-scorer');
  });

  it('should not emit eval events when no evaluators registered', async () => {
    const engine = await createEngine({
      model: { provider: createMockProvider() },
    });

    engine.register('echo', async (ctx) => `echo: ${ctx.input}`);

    const events: any[] = [];
    engine.on('eval:score', (e) => events.push(e));
    engine.on('eval:complete', (e) => events.push(e));
    engine.on('eval:flagged', (e) => events.push(e));

    await engine.trigger('echo', {
      idempotencyKey: 'no-event-test',
      input: 'test',
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(events).toHaveLength(0);
  });
});
