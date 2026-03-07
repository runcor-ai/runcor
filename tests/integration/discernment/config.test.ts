// Integration tests for discernment engine wiring into Runcor

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../../src/engine.js';
import { MockProvider } from '../../../src/model/mock.js';
import type { EngineConfig } from '../../../src/types.js';
import type { CycleReport, Recommendation, Signal } from '../../../src/discernment/types.js';

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    model: {
      providers: [{ provider: new MockProvider(), priority: 1 }],
    },
    ...overrides,
  };
}

describe('Discernment Engine Integration', () => {
  let engine: Runcor;

  afterEach(async () => {
    if (engine) await engine.shutdown();
  });

  describe('engine creation', () => {
    it('creates engine with discernment enabled', async () => {
      engine = await createEngine(makeConfig({
        discernment: {
          enabled: true,
          autonomy: 'recommend',
          schedule: 'daily',
        },
      }));
      expect(engine.listObjectives()).toEqual([]);
    });

    it('auto-registers objectives from config', async () => {
      engine = await createEngine(makeConfig({
        discernment: {
          enabled: true,
          autonomy: 'recommend',
          schedule: 'daily',
          objectives: [
            { name: 'retention', description: 'Reduce churn' },
            { name: 'efficiency', description: 'Cut costs' },
          ],
        },
      }));
      const objs = engine.listObjectives();
      expect(objs).toHaveLength(2);
      expect(objs[0].name).toBe('retention');
      expect(objs[1].name).toBe('efficiency');
    });

    it('zero overhead when disabled — objective methods return graceful defaults', async () => {
      engine = await createEngine(makeConfig());
      expect(engine.listObjectives()).toEqual([]);
      expect(engine.getObjective('anything')).toBeNull();
      expect(engine.listDiscernmentReports()).toEqual([]);
      expect(engine.getDiscernmentReport('any-id')).toBeUndefined();
      expect(engine.getRecommendations()).toEqual([]);
    });
  });

  describe('cycle methods', () => {
    it('runDiscernmentCycle throws DISCERNMENT_DISABLED when disabled', async () => {
      engine = await createEngine(makeConfig());
      try {
        await engine.runDiscernmentCycle();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('DISCERNMENT_DISABLED');
      }
    });

    it('acknowledgeRecommendation throws DISCERNMENT_DISABLED when disabled', async () => {
      engine = await createEngine(makeConfig());
      try {
        engine.acknowledgeRecommendation('rec-1');
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('DISCERNMENT_DISABLED');
      }
    });

    it('addHeuristic throws DISCERNMENT_DISABLED when disabled', async () => {
      engine = await createEngine(makeConfig());
      try {
        engine.addHeuristic({ name: 'test', check: () => [] });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('DISCERNMENT_DISABLED');
      }
    });

    it('runs observe cycle successfully with registered flows', async () => {
      const provider = new MockProvider();
      engine = await createEngine(makeConfig({
        model: { providers: [{ provider, priority: 1 }] },
        discernment: {
          enabled: true,
          autonomy: 'observe',
          schedule: 'daily',
          objectives: [{ name: 'ops', description: 'Ops visibility' }],
        },
      }));

      engine.register('test-flow', async (ctx) => 'result', { objective: 'ops' });

      const report = await engine.runDiscernmentCycle();
      expect(report).toBeDefined();
      expect(report.autonomy).toBe('observe');
      expect(report.recommendations).toHaveLength(0);
      expect(report.modelAnalysis).toBeNull();
    });

    it('runs recommend cycle with model call', async () => {
      const provider = new MockProvider();
      provider.queueResponses([{
        text: JSON.stringify({
          recommendations: [{
            target: 'test-flow',
            targetType: 'flow',
            action: 'optimize',
            confidence: 0.8,
            explanation: 'High cost detected.',
            evidenceRefs: [],
          }],
        }),
      }]);

      engine = await createEngine(makeConfig({
        model: { providers: [{ provider, priority: 1 }] },
        discernment: {
          enabled: true,
          autonomy: 'recommend',
          schedule: 'daily',
          objectives: [{ name: 'ops', description: 'Ops visibility' }],
        },
      }));

      engine.register('test-flow', async (ctx) => 'result', { objective: 'ops' });

      const report = await engine.runDiscernmentCycle();
      expect(report.recommendations.length).toBeGreaterThanOrEqual(1);
      expect(report.modelAnalysis).not.toBeNull();
    });
  });

  describe('report and recommendation management', () => {
    it('reports are stored and retrievable after cycle', async () => {
      const provider = new MockProvider();
      provider.queueResponses([{ text: JSON.stringify({ recommendations: [] }) }]);

      engine = await createEngine(makeConfig({
        model: { providers: [{ provider, priority: 1 }] },
        discernment: {
          enabled: true,
          autonomy: 'recommend',
          schedule: 'daily',
        },
      }));

      const report = await engine.runDiscernmentCycle();
      const retrieved = engine.getDiscernmentReport(report.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(report.id);

      const listed = engine.listDiscernmentReports();
      expect(listed).toHaveLength(1);
    });

    it('recommendation lifecycle: acknowledge', async () => {
      const provider = new MockProvider();
      provider.queueResponses([{
        text: JSON.stringify({
          recommendations: [{
            target: 'flow-a',
            targetType: 'flow',
            action: 'optimize',
            confidence: 0.7,
            explanation: 'Test.',
            evidenceRefs: [],
          }],
        }),
      }]);

      engine = await createEngine(makeConfig({
        model: { providers: [{ provider, priority: 1 }] },
        discernment: {
          enabled: true,
          autonomy: 'recommend',
          schedule: 'daily',
        },
      }));

      const report = await engine.runDiscernmentCycle();
      const recId = report.recommendations[0].id;
      engine.acknowledgeRecommendation(recId);

      const recs = engine.getRecommendations({ status: 'acknowledged' });
      expect(recs).toHaveLength(1);
    });
  });

  describe('events', () => {
    it('emits discernment:cycle event after cycle', async () => {
      const provider = new MockProvider();
      provider.queueResponses([{ text: JSON.stringify({ recommendations: [] }) }]);

      engine = await createEngine(makeConfig({
        model: { providers: [{ provider, priority: 1 }] },
        discernment: {
          enabled: true,
          autonomy: 'recommend',
          schedule: 'daily',
        },
      }));

      const events: CycleReport[] = [];
      engine.on('discernment:cycle', (report) => events.push(report));

      await engine.runDiscernmentCycle();
      expect(events).toHaveLength(1);
    });

    it('emits discernment:recommendation events', async () => {
      const provider = new MockProvider();
      provider.queueResponses([{
        text: JSON.stringify({
          recommendations: [{
            target: 'flow-a',
            targetType: 'flow',
            action: 'keep',
            confidence: 0.9,
            explanation: 'Looks good.',
            evidenceRefs: [],
          }],
        }),
      }]);

      engine = await createEngine(makeConfig({
        model: { providers: [{ provider, priority: 1 }] },
        discernment: {
          enabled: true,
          autonomy: 'recommend',
          schedule: 'daily',
        },
      }));

      const recs: Recommendation[] = [];
      engine.on('discernment:recommendation', (rec) => recs.push(rec));

      await engine.runDiscernmentCycle();
      expect(recs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('custom heuristics', () => {
    it('addHeuristic + removeHeuristic work via engine', async () => {
      engine = await createEngine(makeConfig({
        discernment: {
          enabled: true,
          autonomy: 'observe',
          schedule: 'daily',
        },
      }));

      engine.addHeuristic({
        name: 'my-check',
        check: () => [],
      });

      // Should not throw on remove
      engine.removeHeuristic('my-check');
    });
  });

  describe('shutdown', () => {
    it('shutdown cleans up discernment resources', async () => {
      engine = await createEngine(makeConfig({
        discernment: {
          enabled: true,
          autonomy: 'observe',
          schedule: 'daily',
        },
      }));

      // Should not throw
      await engine.shutdown();
    });
  });
});
