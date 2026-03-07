// Unit tests for FlagManager
// Tests: createFlag, status transitions, invalid transitions, listFlags with filters

import { describe, it, expect } from 'vitest';
import { FlagManager } from '../../../src/evaluation/flag-manager.js';

describe('FlagManager', () => {
  describe('createFlag', () => {
    it('should create an auto flag with pending status', () => {
      const mgr = new FlagManager();
      const flag = mgr.createFlag('exec-1', 'my-flow', 'Low confidence', 'auto');

      expect(flag.executionId).toBe('exec-1');
      expect(flag.flowName).toBe('my-flow');
      expect(flag.status).toBe('pending');
      expect(flag.reason).toBe('Low confidence');
      expect(flag.source).toBe('auto');
      expect(flag.createdAt).toBeInstanceOf(Date);
      expect(flag.updatedAt).toBeInstanceOf(Date);
    });

    it('should create a manual flag', () => {
      const mgr = new FlagManager();
      const flag = mgr.createFlag('exec-2', 'flow-a', 'Manual review needed', 'manual');

      expect(flag.source).toBe('manual');
      expect(flag.reason).toBe('Manual review needed');
    });

    it('should throw ALREADY_FLAGGED for duplicate executionId', () => {
      const mgr = new FlagManager();
      mgr.createFlag('exec-1', 'flow', 'first flag', 'auto');

      expect(() => mgr.createFlag('exec-1', 'flow', 'second flag', 'manual')).toThrow(
        /already flagged/,
      );
      try {
        mgr.createFlag('exec-1', 'flow', 'second', 'manual');
      } catch (err: any) {
        expect(err.code).toBe('ALREADY_FLAGGED');
      }
    });
  });

  describe('updateFlag', () => {
    it('should transition pending → reviewed', () => {
      const mgr = new FlagManager();
      mgr.createFlag('exec-1', 'flow', 'reason', 'auto');

      mgr.updateFlag('exec-1', 'reviewed');
      const flag = mgr.getFlag('exec-1');
      expect(flag!.status).toBe('reviewed');
    });

    it('should transition reviewed → resolved', () => {
      const mgr = new FlagManager();
      mgr.createFlag('exec-1', 'flow', 'reason', 'auto');
      mgr.updateFlag('exec-1', 'reviewed');
      mgr.updateFlag('exec-1', 'resolved');

      const flag = mgr.getFlag('exec-1');
      expect(flag!.status).toBe('resolved');
    });

    it('should reject invalid transition pending → resolved', () => {
      const mgr = new FlagManager();
      mgr.createFlag('exec-1', 'flow', 'reason', 'auto');

      expect(() => mgr.updateFlag('exec-1', 'resolved')).toThrow(
        /Invalid flag transition/,
      );
      try {
        mgr.updateFlag('exec-1', 'resolved');
      } catch (err: any) {
        expect(err.code).toBe('INVALID_FLAG_TRANSITION');
      }
    });

    it('should reject transition from resolved', () => {
      const mgr = new FlagManager();
      mgr.createFlag('exec-1', 'flow', 'reason', 'auto');
      mgr.updateFlag('exec-1', 'reviewed');
      mgr.updateFlag('exec-1', 'resolved');

      expect(() => mgr.updateFlag('exec-1', 'pending')).toThrow(
        /Invalid flag transition/,
      );
    });

    it('should throw FLAG_NOT_FOUND for non-existent execution', () => {
      const mgr = new FlagManager();

      expect(() => mgr.updateFlag('nonexistent', 'reviewed')).toThrow(
        /No flag found/,
      );
      try {
        mgr.updateFlag('nonexistent', 'reviewed');
      } catch (err: any) {
        expect(err.code).toBe('FLAG_NOT_FOUND');
      }
    });

    it('should update the updatedAt timestamp', () => {
      const mgr = new FlagManager();
      const flag = mgr.createFlag('exec-1', 'flow', 'reason', 'auto');
      const originalUpdated = flag.updatedAt;

      // Small delay to ensure different timestamp
      mgr.updateFlag('exec-1', 'reviewed');
      const updated = mgr.getFlag('exec-1');
      expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(originalUpdated.getTime());
    });
  });

  describe('listFlags', () => {
    it('should list all flags when no filter provided', () => {
      const mgr = new FlagManager();
      mgr.createFlag('exec-1', 'flow-a', 'r1', 'auto');
      mgr.createFlag('exec-2', 'flow-b', 'r2', 'manual');
      mgr.createFlag('exec-3', 'flow-a', 'r3', 'auto');

      const all = mgr.listFlags();
      expect(all).toHaveLength(3);
    });

    it('should filter by flowName', () => {
      const mgr = new FlagManager();
      mgr.createFlag('exec-1', 'flow-a', 'r1', 'auto');
      mgr.createFlag('exec-2', 'flow-b', 'r2', 'manual');
      mgr.createFlag('exec-3', 'flow-a', 'r3', 'auto');

      const flowA = mgr.listFlags({ flowName: 'flow-a' });
      expect(flowA).toHaveLength(2);
      expect(flowA.every((f) => f.flowName === 'flow-a')).toBe(true);
    });

    it('should filter by status', () => {
      const mgr = new FlagManager();
      mgr.createFlag('exec-1', 'flow', 'r1', 'auto');
      mgr.createFlag('exec-2', 'flow', 'r2', 'auto');
      mgr.updateFlag('exec-2', 'reviewed');

      const pending = mgr.listFlags({ status: 'pending' });
      expect(pending).toHaveLength(1);
      expect(pending[0].executionId).toBe('exec-1');

      const reviewed = mgr.listFlags({ status: 'reviewed' });
      expect(reviewed).toHaveLength(1);
      expect(reviewed[0].executionId).toBe('exec-2');
    });

    it('should filter by combined flowName and status', () => {
      const mgr = new FlagManager();
      mgr.createFlag('exec-1', 'flow-a', 'r1', 'auto');
      mgr.createFlag('exec-2', 'flow-b', 'r2', 'auto');
      mgr.createFlag('exec-3', 'flow-a', 'r3', 'auto');
      mgr.updateFlag('exec-3', 'reviewed');

      const result = mgr.listFlags({ flowName: 'flow-a', status: 'pending' });
      expect(result).toHaveLength(1);
      expect(result[0].executionId).toBe('exec-1');
    });

    it('should return empty for no-match queries', () => {
      const mgr = new FlagManager();
      mgr.createFlag('exec-1', 'flow-a', 'r1', 'auto');

      const result = mgr.listFlags({ flowName: 'nonexistent' });
      expect(result).toHaveLength(0);
    });
  });

  describe('getFlag', () => {
    it('should return flag by executionId', () => {
      const mgr = new FlagManager();
      mgr.createFlag('exec-1', 'flow', 'reason', 'auto');

      const flag = mgr.getFlag('exec-1');
      expect(flag).not.toBeNull();
      expect(flag!.executionId).toBe('exec-1');
    });

    it('should return null for non-existent executionId', () => {
      const mgr = new FlagManager();
      expect(mgr.getFlag('nonexistent')).toBeNull();
    });
  });
});
