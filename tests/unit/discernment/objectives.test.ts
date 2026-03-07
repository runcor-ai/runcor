// Unit tests for ObjectiveRegistry

import { describe, it, expect, beforeEach } from 'vitest';
import { ObjectiveRegistry } from '../../../src/discernment/objectives.js';

describe('ObjectiveRegistry', () => {
  let registry: ObjectiveRegistry;

  beforeEach(() => {
    registry = new ObjectiveRegistry();
  });

  // ── Objective CRUD ──

  describe('addObjective', () => {
    it('adds an objective', () => {
      registry.addObjective({ name: 'retention', description: 'Reduce churn' });
      const obj = registry.getObjective('retention');
      expect(obj).not.toBeNull();
      expect(obj!.name).toBe('retention');
      expect(obj!.description).toBe('Reduce churn');
      expect(obj!.primaryFlows).toEqual([]);
      expect(obj!.secondaryFlows).toEqual([]);
    });

    it('throws DUPLICATE_OBJECTIVE for duplicate name', () => {
      registry.addObjective({ name: 'retention', description: 'v1' });
      try {
        registry.addObjective({ name: 'retention', description: 'v2' });
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('DUPLICATE_OBJECTIVE');
      }
    });

    it('throws for empty name', () => {
      expect(() => registry.addObjective({ name: '', description: 'desc' }))
        .toThrow();
    });

    it('throws for name exceeding 128 chars', () => {
      const longName = 'a'.repeat(129);
      expect(() => registry.addObjective({ name: longName, description: 'desc' }))
        .toThrow();
    });

    it('accepts name at exactly 128 chars', () => {
      const name = 'a'.repeat(128);
      registry.addObjective({ name, description: 'desc' });
      expect(registry.getObjective(name)).not.toBeNull();
    });
  });

  describe('removeObjective', () => {
    it('removes an existing objective', () => {
      registry.addObjective({ name: 'retention', description: 'desc' });
      registry.removeObjective('retention');
      expect(registry.getObjective('retention')).toBeNull();
    });

    it('throws OBJECTIVE_NOT_FOUND for unknown name', () => {
      try {
        registry.removeObjective('nonexistent');
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('OBJECTIVE_NOT_FOUND');
      }
    });

    it('clears primary flow references (flows become orphans)', () => {
      registry.addObjective({ name: 'retention', description: 'desc' });
      registry.addFlowTag({
        flowName: 'flow-a',
        primaryObjective: 'retention',
        secondaryObjectives: [],
        expectedCadence: null,
        purpose: null,
        enforceable: false,
      });

      registry.removeObjective('retention');

      const tag = registry.getFlowTag('flow-a');
      expect(tag).not.toBeNull();
      // Primary objective cleared — flow is now an orphan
      expect(tag!.primaryObjective).toBe('');
    });

    it('clears secondary objective references from flows', () => {
      registry.addObjective({ name: 'retention', description: 'desc' });
      registry.addObjective({ name: 'visibility', description: 'desc' });
      registry.addFlowTag({
        flowName: 'flow-a',
        primaryObjective: 'visibility',
        secondaryObjectives: ['retention'],
        expectedCadence: null,
        purpose: null,
        enforceable: false,
      });

      registry.removeObjective('retention');

      const tag = registry.getFlowTag('flow-a');
      expect(tag!.secondaryObjectives).toEqual([]);
      // Primary objective unchanged
      expect(tag!.primaryObjective).toBe('visibility');
    });
  });

  describe('listObjectives', () => {
    it('returns all objectives with flow counts', () => {
      registry.addObjective({ name: 'retention', description: 'Reduce churn' });
      registry.addObjective({ name: 'visibility', description: 'Dashboards' });

      const list = registry.listObjectives();
      expect(list).toHaveLength(2);
      expect(list.map(o => o.name).sort()).toEqual(['retention', 'visibility']);
    });

    it('returns empty array when none declared', () => {
      expect(registry.listObjectives()).toEqual([]);
    });
  });

  describe('getObjective', () => {
    it('returns null for unknown name', () => {
      expect(registry.getObjective('nonexistent')).toBeNull();
    });

    it('includes primary and secondary flow lists', () => {
      registry.addObjective({ name: 'retention', description: 'desc' });
      registry.addObjective({ name: 'visibility', description: 'desc' });

      registry.addFlowTag({
        flowName: 'flow-a',
        primaryObjective: 'retention',
        secondaryObjectives: ['visibility'],
        expectedCadence: null,
        purpose: null,
        enforceable: false,
      });

      const retention = registry.getObjective('retention');
      expect(retention!.primaryFlows).toEqual(['flow-a']);
      expect(retention!.secondaryFlows).toEqual([]);

      const visibility = registry.getObjective('visibility');
      expect(visibility!.primaryFlows).toEqual([]);
      expect(visibility!.secondaryFlows).toEqual(['flow-a']);
    });
  });

  // ── Flow Tag Management ──

  describe('addFlowTag', () => {
    it('stores a flow tag', () => {
      registry.addObjective({ name: 'retention', description: 'desc' });
      registry.addFlowTag({
        flowName: 'flow-a',
        primaryObjective: 'retention',
        secondaryObjectives: [],
        expectedCadence: 'daily',
        purpose: 'Test flow',
        enforceable: true,
      });

      const tag = registry.getFlowTag('flow-a');
      expect(tag).not.toBeNull();
      expect(tag!.primaryObjective).toBe('retention');
      expect(tag!.expectedCadence).toBe('daily');
      expect(tag!.purpose).toBe('Test flow');
      expect(tag!.enforceable).toBe(true);
    });
  });

  describe('removeFlowTag', () => {
    it('removes a flow tag', () => {
      registry.addObjective({ name: 'retention', description: 'desc' });
      registry.addFlowTag({
        flowName: 'flow-a',
        primaryObjective: 'retention',
        secondaryObjectives: [],
        expectedCadence: null,
        purpose: null,
        enforceable: false,
      });

      registry.removeFlowTag('flow-a');
      expect(registry.getFlowTag('flow-a')).toBeNull();
    });

    it('is a no-op for unknown flow', () => {
      expect(() => registry.removeFlowTag('nonexistent')).not.toThrow();
    });
  });

  // ── Orphan and Unserved Detection ──

  describe('listOrphanFlows', () => {
    it('returns flows without a primary objective', () => {
      registry.addObjective({ name: 'retention', description: 'desc' });
      registry.addFlowTag({
        flowName: 'flow-a',
        primaryObjective: 'retention',
        secondaryObjectives: [],
        expectedCadence: null,
        purpose: null,
        enforceable: false,
      });
      // flow-b has no tag at all — it's not tracked by registry
      // flow-c has empty primary (orphan)
      registry.addFlowTag({
        flowName: 'flow-c',
        primaryObjective: '',
        secondaryObjectives: [],
        expectedCadence: null,
        purpose: null,
        enforceable: false,
      });

      const orphans = registry.listOrphanFlows();
      expect(orphans).toContain('flow-c');
      expect(orphans).not.toContain('flow-a');
    });
  });

  describe('listUnservedObjectives', () => {
    it('returns objectives with no flows', () => {
      registry.addObjective({ name: 'retention', description: 'desc' });
      registry.addObjective({ name: 'visibility', description: 'desc' });

      registry.addFlowTag({
        flowName: 'flow-a',
        primaryObjective: 'retention',
        secondaryObjectives: [],
        expectedCadence: null,
        purpose: null,
        enforceable: false,
      });

      const unserved = registry.listUnservedObjectives();
      expect(unserved).toContain('visibility');
      expect(unserved).not.toContain('retention');
    });

    it('returns empty when all objectives have flows', () => {
      registry.addObjective({ name: 'retention', description: 'desc' });
      registry.addFlowTag({
        flowName: 'flow-a',
        primaryObjective: 'retention',
        secondaryObjectives: [],
        expectedCadence: null,
        purpose: null,
        enforceable: false,
      });

      expect(registry.listUnservedObjectives()).toEqual([]);
    });
  });
});
