// Unit tests for EvaluationEngine.listEvaluations()

import { describe, it, expect, beforeEach } from 'vitest';
import { EvaluationEngine } from '../../../src/evaluation/evaluation-engine.js';
import { EngineInstrumentation } from '../../../src/telemetry/instrumentation.js';
import type { EvalRecord } from '../../../src/types.js';

function createEngine(): EvaluationEngine {
  const instrumentation = new EngineInstrumentation({});
  return new EvaluationEngine(undefined, instrumentation, () => {});
}

/** Inject a fake EvalRecord directly into the engine's internal map */
function injectRecord(engine: EvaluationEngine, record: EvalRecord): void {
  // Access the internal evalRecords map via the getEvaluation path:
  // We rely on runEvaluation to store records, but for unit testing listEvaluations
  // we need to inject records directly. Use the internal map.
  (engine as any).evalRecords.set(record.executionId, record);
}

function makeRecord(overrides: Partial<EvalRecord> & { executionId: string; flowName: string }): EvalRecord {
  return {
    timestamp: new Date(),
    evaluatorResults: [],
    aggregateScores: {},
    overallScore: 0.8,
    confidence: 'high',
    labels: [],
    errors: [],
    ...overrides,
  };
}

describe('EvaluationEngine.listEvaluations', () => {
  let engine: EvaluationEngine;

  beforeEach(() => {
    engine = createEngine();
  });

  it('returns all records when no filter provided', () => {
    injectRecord(engine, makeRecord({ executionId: 'e1', flowName: 'flow-a' }));
    injectRecord(engine, makeRecord({ executionId: 'e2', flowName: 'flow-b' }));
    injectRecord(engine, makeRecord({ executionId: 'e3', flowName: 'flow-a' }));

    const results = engine.listEvaluations();
    expect(results).toHaveLength(3);
  });

  it('filters by flowName', () => {
    injectRecord(engine, makeRecord({ executionId: 'e1', flowName: 'flow-a' }));
    injectRecord(engine, makeRecord({ executionId: 'e2', flowName: 'flow-b' }));
    injectRecord(engine, makeRecord({ executionId: 'e3', flowName: 'flow-a' }));

    const results = engine.listEvaluations({ flowName: 'flow-a' });
    expect(results).toHaveLength(2);
    expect(results.every(r => r.flowName === 'flow-a')).toBe(true);
  });

  it('filters by startTime', () => {
    const old = new Date('2026-01-01T00:00:00Z');
    const recent = new Date('2026-02-15T00:00:00Z');
    const cutoff = new Date('2026-02-01T00:00:00Z');

    injectRecord(engine, makeRecord({ executionId: 'e1', flowName: 'flow-a', timestamp: old }));
    injectRecord(engine, makeRecord({ executionId: 'e2', flowName: 'flow-a', timestamp: recent }));

    const results = engine.listEvaluations({ startTime: cutoff });
    expect(results).toHaveLength(1);
    expect(results[0].executionId).toBe('e2');
  });

  it('filters by flowName AND startTime combined', () => {
    const old = new Date('2026-01-01T00:00:00Z');
    const recent = new Date('2026-02-15T00:00:00Z');
    const cutoff = new Date('2026-02-01T00:00:00Z');

    injectRecord(engine, makeRecord({ executionId: 'e1', flowName: 'flow-a', timestamp: old }));
    injectRecord(engine, makeRecord({ executionId: 'e2', flowName: 'flow-a', timestamp: recent }));
    injectRecord(engine, makeRecord({ executionId: 'e3', flowName: 'flow-b', timestamp: recent }));

    const results = engine.listEvaluations({ flowName: 'flow-a', startTime: cutoff });
    expect(results).toHaveLength(1);
    expect(results[0].executionId).toBe('e2');
  });

  it('returns empty array for no matches', () => {
    injectRecord(engine, makeRecord({ executionId: 'e1', flowName: 'flow-a' }));

    const results = engine.listEvaluations({ flowName: 'nonexistent' });
    expect(results).toHaveLength(0);
  });

  it('returns empty array when no records exist', () => {
    const results = engine.listEvaluations();
    expect(results).toHaveLength(0);
  });
});
