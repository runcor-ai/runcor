// Unit tests for DiscernmentEngine report storage and recommendation management

import { describe, it, expect, beforeEach } from 'vitest';
import { DiscernmentEngine } from '../../../src/discernment/engine.js';
import type {
  CycleReport,
  Recommendation,
  SystemProfile,
  DiscernmentConfig,
} from '../../../src/discernment/types.js';

function makeConfig(overrides: Partial<DiscernmentConfig> = {}): DiscernmentConfig {
  return {
    enabled: true,
    autonomy: 'recommend',
    schedule: 'daily',
    ...overrides,
  };
}

function makeRecommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: `rec-${Math.random().toString(36).slice(2, 8)}`,
    target: 'flow-a',
    targetType: 'flow',
    action: 'optimize',
    confidence: 0.8,
    explanation: 'Test recommendation',
    evidenceRefs: [],
    status: 'pending',
    createdAt: new Date(),
    ...overrides,
  };
}

function makeSystemProfile(): SystemProfile {
  return {
    timestamp: new Date(),
    lookbackPeriod: 604800,
    flowProfiles: [],
    objectiveSummaries: [],
    orphanFlows: [],
    unservedObjectives: [],
    totalCost: 0,
    totalExecutions: 0,
  };
}

function makeReport(overrides: Partial<CycleReport> = {}): CycleReport {
  return {
    id: `cycle-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date(),
    autonomy: 'recommend',
    lookbackPeriod: 604800,
    systemProfile: makeSystemProfile(),
    signals: [],
    recommendations: [],
    modelAnalysis: null,
    objectiveSummaries: [],
    ...overrides,
  };
}

describe('DiscernmentEngine', () => {
  let engine: DiscernmentEngine;

  beforeEach(() => {
    engine = new DiscernmentEngine(makeConfig());
  });

  describe('CycleReport storage', () => {
    it('stores and retrieves a report by id', () => {
      const report = makeReport({ id: 'cycle-1' });
      engine.storeReport(report);

      const retrieved = engine.getReport('cycle-1');
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe('cycle-1');
    });

    it('returns undefined for unknown report id', () => {
      expect(engine.getReport('unknown')).toBeUndefined();
    });

    it('lists reports most-recent-first', () => {
      const old = makeReport({ id: 'cycle-1', timestamp: new Date('2026-01-01') });
      const mid = makeReport({ id: 'cycle-2', timestamp: new Date('2026-02-01') });
      const recent = makeReport({ id: 'cycle-3', timestamp: new Date('2026-03-01') });

      engine.storeReport(old);
      engine.storeReport(mid);
      engine.storeReport(recent);

      const reports = engine.listReports();
      expect(reports[0].id).toBe('cycle-3');
      expect(reports[1].id).toBe('cycle-2');
      expect(reports[2].id).toBe('cycle-1');
    });

    it('respects limit parameter (default 10)', () => {
      for (let i = 0; i < 15; i++) {
        engine.storeReport(makeReport({ id: `cycle-${i}` }));
      }
      expect(engine.listReports().length).toBe(10);
      expect(engine.listReports(5).length).toBe(5);
    });

    it('caps limit at 100', () => {
      for (let i = 0; i < 110; i++) {
        engine.storeReport(makeReport({ id: `cycle-${i}` }));
      }
      expect(engine.listReports(200).length).toBe(100);
    });

    it('prunes reports beyond retention period', () => {
      const config = makeConfig({ lookbackPeriod: 604800 }); // 7 days
      const eng = new DiscernmentEngine(config);

      const expired = makeReport({
        id: 'old',
        timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
      });
      const recent = makeReport({
        id: 'new',
        timestamp: new Date(),
      });

      eng.storeReport(expired);
      eng.storeReport(recent);
      eng.pruneReports();

      expect(eng.getReport('new')).toBeDefined();
      // Old report pruned
      expect(eng.getReport('old')).toBeUndefined();
    });
  });

  describe('CycleReport structure', () => {
    it('report contains required fields', () => {
      const rec = makeRecommendation();
      const report = makeReport({
        recommendations: [rec],
        modelAnalysis: { provider: 'mock', model: 'gpt-4', cost: 0.01, success: true, error: null },
      });

      engine.storeReport(report);
      const retrieved = engine.getReport(report.id)!;

      expect(retrieved.id).toBeTruthy();
      expect(retrieved.timestamp).toBeInstanceOf(Date);
      expect(retrieved.autonomy).toBe('recommend');
      expect(retrieved.lookbackPeriod).toBe(604800);
      expect(retrieved.systemProfile).toBeDefined();
      expect(Array.isArray(retrieved.signals)).toBe(true);
      expect(Array.isArray(retrieved.recommendations)).toBe(true);
      expect(retrieved.modelAnalysis).toBeDefined();
      expect(Array.isArray(retrieved.objectiveSummaries)).toBe(true);
    });
  });

  describe('Recommendation management', () => {
    it('getRecommendations filters by targetFlow', () => {
      const recA = makeRecommendation({ id: 'r1', target: 'flow-a', targetType: 'flow' });
      const recB = makeRecommendation({ id: 'r2', target: 'flow-b', targetType: 'flow' });
      const report = makeReport({ recommendations: [recA, recB] });
      engine.storeReport(report);

      const results = engine.getRecommendations({ targetFlow: 'flow-a' });
      expect(results).toHaveLength(1);
      expect(results[0].target).toBe('flow-a');
    });

    it('getRecommendations filters by targetObjective', () => {
      const recA = makeRecommendation({ id: 'r1', target: 'retention', targetType: 'objective' });
      const recB = makeRecommendation({ id: 'r2', target: 'flow-a', targetType: 'flow' });
      const report = makeReport({ recommendations: [recA, recB] });
      engine.storeReport(report);

      const results = engine.getRecommendations({ targetObjective: 'retention' });
      expect(results).toHaveLength(1);
      expect(results[0].target).toBe('retention');
    });

    it('getRecommendations filters by action', () => {
      const recA = makeRecommendation({ id: 'r1', action: 'optimize' });
      const recB = makeRecommendation({ id: 'r2', action: 'retire' });
      const report = makeReport({ recommendations: [recA, recB] });
      engine.storeReport(report);

      const results = engine.getRecommendations({ action: 'retire' });
      expect(results).toHaveLength(1);
      expect(results[0].action).toBe('retire');
    });

    it('getRecommendations filters by status', () => {
      const recA = makeRecommendation({ id: 'r1', status: 'pending' });
      const recB = makeRecommendation({ id: 'r2', status: 'acknowledged' });
      const report = makeReport({ recommendations: [recA, recB] });
      engine.storeReport(report);

      const results = engine.getRecommendations({ status: 'pending' });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('r1');
    });

    it('getRecommendations filters by cycleId', () => {
      const rec1 = makeRecommendation({ id: 'r1' });
      const rec2 = makeRecommendation({ id: 'r2' });
      const report1 = makeReport({ id: 'cycle-1', recommendations: [rec1] });
      const report2 = makeReport({ id: 'cycle-2', recommendations: [rec2] });
      engine.storeReport(report1);
      engine.storeReport(report2);

      const results = engine.getRecommendations({ cycleId: 'cycle-1' });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('r1');
    });
  });

  describe('Recommendation status lifecycle', () => {
    it('acknowledges a pending recommendation', () => {
      const rec = makeRecommendation({ id: 'r1', status: 'pending' });
      const report = makeReport({ recommendations: [rec] });
      engine.storeReport(report);

      engine.acknowledgeRecommendation('r1');
      const updated = engine.getRecommendations({ status: 'acknowledged' });
      expect(updated).toHaveLength(1);
      expect(updated[0].id).toBe('r1');
    });

    it('dismisses a pending recommendation', () => {
      const rec = makeRecommendation({ id: 'r1', status: 'pending' });
      const report = makeReport({ recommendations: [rec] });
      engine.storeReport(report);

      engine.dismissRecommendation('r1');
      const updated = engine.getRecommendations({ status: 'dismissed' });
      expect(updated).toHaveLength(1);
    });

    it('overrides a pending recommendation', () => {
      const rec = makeRecommendation({ id: 'r1', status: 'pending' });
      const report = makeReport({ recommendations: [rec] });
      engine.storeReport(report);

      engine.overrideRecommendation('r1', 'Not applicable');
      const updated = engine.getRecommendations({ status: 'overridden' });
      expect(updated).toHaveLength(1);
    });

    it('rejects transition from non-pending status', () => {
      const rec = makeRecommendation({ id: 'r1', status: 'pending' });
      const report = makeReport({ recommendations: [rec] });
      engine.storeReport(report);

      engine.acknowledgeRecommendation('r1');

      try {
        engine.dismissRecommendation('r1');
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('INVALID_RECOMMENDATION_STATUS');
      }
    });

    it('rejects unknown recommendation id', () => {
      try {
        engine.acknowledgeRecommendation('unknown');
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('RECOMMENDATION_NOT_FOUND');
      }
    });
  });
});
