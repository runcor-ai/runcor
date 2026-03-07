// Unit tests for engine objective management

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../../src/engine.js';
import { MockProvider } from '../../../src/model/mock.js';

describe('Engine Objective Management', () => {
  let engine: Runcor;

  beforeEach(async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      discernment: {
        enabled: true,
        autonomy: 'observe',
        schedule: 'daily',
      },
    });
  });

  afterEach(async () => {
    await engine.shutdown();
  });

  describe('addObjective', () => {
    it('registers an objective', () => {
      engine.addObjective({ name: 'retention', description: 'Reduce churn' });
      const obj = engine.getObjective('retention');
      expect(obj).not.toBeNull();
      expect(obj!.name).toBe('retention');
      expect(obj!.description).toBe('Reduce churn');
    });

    it('throws DUPLICATE_OBJECTIVE for duplicate name', () => {
      engine.addObjective({ name: 'retention', description: 'v1' });
      try {
        engine.addObjective({ name: 'retention', description: 'v2' });
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('DUPLICATE_OBJECTIVE');
      }
    });
  });

  describe('removeObjective', () => {
    it('removes an objective', () => {
      engine.addObjective({ name: 'retention', description: 'desc' });
      engine.removeObjective('retention');
      expect(engine.getObjective('retention')).toBeNull();
    });

    it('throws OBJECTIVE_NOT_FOUND for unknown name', () => {
      try {
        engine.removeObjective('nonexistent');
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('OBJECTIVE_NOT_FOUND');
      }
    });
  });

  describe('listObjectives', () => {
    it('returns all declared objectives', () => {
      engine.addObjective({ name: 'retention', description: 'Reduce churn' });
      engine.addObjective({ name: 'visibility', description: 'Dashboards' });
      const list = engine.listObjectives();
      expect(list).toHaveLength(2);
    });
  });

  describe('getObjective', () => {
    it('returns null for unknown objective', () => {
      expect(engine.getObjective('nonexistent')).toBeNull();
    });
  });

  describe('config auto-registration', () => {
    it('auto-registers objectives from config at startup', async () => {
      const e = await createEngine({
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

      expect(e.listObjectives()).toHaveLength(2);
      expect(e.getObjective('retention')).not.toBeNull();
      expect(e.getObjective('visibility')).not.toBeNull();

      await e.shutdown();
    });
  });
});
