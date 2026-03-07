// Unit tests for flow registration with objective validation

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../../src/engine.js';
import { MockProvider } from '../../../src/model/mock.js';

describe('Flow Registration with Objective Validation', () => {
  let engine: Runcor;

  beforeEach(async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      discernment: {
        enabled: true,
        autonomy: 'observe',
        schedule: 'daily',
        objectives: [
          { name: 'retention', description: 'Reduce churn' },
          { name: 'visibility', description: 'Dashboards' },
        ],
      },
    });
  });

  afterEach(async () => {
    await engine.shutdown();
  });

  it('registers a flow with valid primary objective', () => {
    engine.register('flow-a', async () => 'ok', {
      objective: 'retention',
    });
    const flows = engine.listFlows();
    expect(flows.find(f => f.name === 'flow-a')).toBeDefined();
  });

  it('registers a flow with valid primary and secondary objectives', () => {
    engine.register('flow-a', async () => 'ok', {
      objective: 'retention',
      secondaryObjectives: ['visibility'],
    });
    const obj = engine.getObjective('retention');
    expect(obj!.primaryFlows).toContain('flow-a');
    const vis = engine.getObjective('visibility');
    expect(vis!.secondaryFlows).toContain('flow-a');
  });

  it('throws UNDECLARED_OBJECTIVE for invalid primary objective', () => {
    try {
      engine.register('flow-a', async () => 'ok', {
        objective: 'nonexistent',
      });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('UNDECLARED_OBJECTIVE');
    }
  });

  it('throws UNDECLARED_OBJECTIVE for invalid secondary objective', () => {
    try {
      engine.register('flow-a', async () => 'ok', {
        objective: 'retention',
        secondaryObjectives: ['nonexistent'],
      });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('UNDECLARED_OBJECTIVE');
    }
  });

  it('throws RESERVED_FLOW_NAME for __discernment', () => {
    try {
      engine.register('__discernment', async () => 'ok');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('RESERVED_FLOW_NAME');
    }
  });

  it('registers without objective (orphan flow)', () => {
    engine.register('flow-orphan', async () => 'ok');
    const flows = engine.listFlows();
    expect(flows.find(f => f.name === 'flow-orphan')).toBeDefined();
  });

  it('objective fields silently ignored when discernment disabled', async () => {
    const e = await createEngine({
      model: { provider: new MockProvider() },
      // No discernment config — disabled
    });

    // Should NOT throw even with invalid objective reference
    e.register('flow-a', async () => 'ok', {
      objective: 'nonexistent-objective',
    });

    const flows = e.listFlows();
    expect(flows.find(f => f.name === 'flow-a')).toBeDefined();

    await e.shutdown();
  });

  it('stores flow metadata (expectedCadence, purpose, enforceable)', () => {
    engine.register('flow-a', async () => 'ok', {
      objective: 'retention',
      expectedCadence: 'daily',
      purpose: 'Track user engagement',
      enforceable: true,
    });

    const flow = engine.listFlows().find(f => f.name === 'flow-a');
    expect(flow!.objective).toBe('retention');
    expect(flow!.expectedCadence).toBe('daily');
    expect(flow!.purpose).toBe('Track user engagement');
    expect(flow!.enforceable).toBe(true);
  });

  it('cleans up flow tag on unregister', () => {
    engine.register('flow-a', async () => 'ok', {
      objective: 'retention',
    });

    const objBefore = engine.getObjective('retention');
    expect(objBefore!.primaryFlows).toContain('flow-a');

    engine.unregister('flow-a');

    const objAfter = engine.getObjective('retention');
    expect(objAfter!.primaryFlows).not.toContain('flow-a');
  });
});
