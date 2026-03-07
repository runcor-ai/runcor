// Unit tests for WaitSignal creation and type guard
import { describe, it, expect } from 'vitest';
import { createWaitSignal, isWaitSignal } from '../../src/wait-signal.js';

describe('WaitSignal', () => {
  describe('createWaitSignal', () => {
    it('should create a WaitSignal with no args', () => {
      const signal = createWaitSignal();

      expect(signal.__brand).toBe('WaitSignal');
      expect(signal.reason).toBeUndefined();
      expect(signal.expectedResumeBy).toBeUndefined();
      expect(signal.waitData).toBeUndefined();
    });

    it('should create a WaitSignal with all fields', () => {
      const resumeBy = new Date('2026-03-01');
      const signal = createWaitSignal({
        reason: 'Awaiting approval',
        expectedResumeBy: resumeBy,
        waitData: { approvalId: 'abc-123' },
      });

      expect(signal.__brand).toBe('WaitSignal');
      expect(signal.reason).toBe('Awaiting approval');
      expect(signal.expectedResumeBy).toBe(resumeBy);
      expect(signal.waitData).toEqual({ approvalId: 'abc-123' });
    });

    it('should create a WaitSignal with partial fields', () => {
      const signal = createWaitSignal({ reason: 'Waiting for webhook' });

      expect(signal.__brand).toBe('WaitSignal');
      expect(signal.reason).toBe('Waiting for webhook');
      expect(signal.expectedResumeBy).toBeUndefined();
      expect(signal.waitData).toBeUndefined();
    });

    it('should be frozen (immutable)', () => {
      const signal = createWaitSignal({ reason: 'test' });

      expect(Object.isFrozen(signal)).toBe(true);
      expect(() => {
        (signal as any).reason = 'modified';
      }).toThrow();
    });
  });

  describe('isWaitSignal', () => {
    it('should return true for a valid WaitSignal', () => {
      const signal = createWaitSignal();
      expect(isWaitSignal(signal)).toBe(true);
    });

    it('should return true for a WaitSignal with all fields', () => {
      const signal = createWaitSignal({
        reason: 'test',
        expectedResumeBy: new Date(),
        waitData: { key: 'value' },
      });
      expect(isWaitSignal(signal)).toBe(true);
    });

    it('should return false for null', () => {
      expect(isWaitSignal(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isWaitSignal(undefined)).toBe(false);
    });

    it('should return false for a string', () => {
      expect(isWaitSignal('WaitSignal')).toBe(false);
    });

    it('should return false for a number', () => {
      expect(isWaitSignal(42)).toBe(false);
    });

    it('should return false for a plain object', () => {
      expect(isWaitSignal({ foo: 'bar' })).toBe(false);
    });

    it('should return false for an object with wrong brand', () => {
      expect(isWaitSignal({ __brand: 'NotWaitSignal' })).toBe(false);
    });

    it('should return false for an object with brand as non-string', () => {
      expect(isWaitSignal({ __brand: 123 })).toBe(false);
    });

    it('should return true for a manually constructed object with correct brand', () => {
      const manual = { __brand: 'WaitSignal' as const };
      expect(isWaitSignal(manual)).toBe(true);
    });
  });
});
