// Unit tests for Execution state machine
import { describe, it, expect } from 'vitest';
import {
  createExecution,
  transitionExecution,
  validateTransition,
} from '../../src/execution.js';
import { EngineError } from '../../src/errors.js';

describe('Execution', () => {
  describe('createExecution', () => {
    it('should create an execution in queued state', () => {
      const exec = createExecution('test-flow', 'key-1', { data: 'hello' });

      expect(exec.state).toBe('queued');
      expect(exec.flowName).toBe('test-flow');
      expect(exec.idempotencyKey).toBe('key-1');
      expect(exec.input).toEqual({ data: 'hello' });
      expect(exec.result).toBeNull();
      expect(exec.error).toBeNull();
      expect(exec.retryCount).toBe(0);
    });

    it('should generate a UUID v4 id', () => {
      const exec = createExecution('flow', 'key', null);
      expect(exec.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    // T015: Feature 006 — new fields initialized to null
    it('should initialize waitContext to null', () => {
      const exec = createExecution('flow', 'key', null);
      expect(exec.waitContext).toBeNull();
    });

    it('should initialize resumeData to null', () => {
      const exec = createExecution('flow', 'key', null);
      expect(exec.resumeData).toBeNull();
    });

    it('should initialize replayOf to null', () => {
      const exec = createExecution('flow', 'key', null);
      expect(exec.replayOf).toBeNull();
    });

    it('should allow setting waitContext, resumeData, replayOf', () => {
      const exec = createExecution('flow', 'key', null);
      exec.waitContext = {
        reason: 'test',
        expectedResumeBy: null,
        waitData: null,
        waitingSince: new Date(),
      };
      exec.resumeData = { approval: true };
      exec.replayOf = 'original-id';

      expect(exec.waitContext!.reason).toBe('test');
      expect(exec.resumeData).toEqual({ approval: true });
      expect(exec.replayOf).toBe('original-id');
    });

    it('should set queued timestamp', () => {
      const before = new Date();
      const exec = createExecution('flow', 'key', null);
      const after = new Date();

      expect(exec.timestamps.queued.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(exec.timestamps.queued.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(exec.timestamps.started).toBeNull();
      expect(exec.timestamps.completed).toBeNull();
      expect(exec.timestamps.transitions).toHaveLength(0);
    });
  });

  describe('validateTransition', () => {
    const validTransitions: Array<[string, string]> = [
      ['queued', 'running'],
      ['queued', 'failed'],
      ['running', 'complete'],
      ['running', 'waiting'],
      ['running', 'retrying'],
      ['running', 'failed'],
      ['waiting', 'running'],
      ['waiting', 'failed'],
      ['retrying', 'running'],
      ['retrying', 'failed'],
    ];

    it.each(validTransitions)(
      'should allow %s → %s',
      (from, to) => {
        expect(() =>
          validateTransition(from as any, to as any),
        ).not.toThrow();
      },
    );

    const invalidTransitions: Array<[string, string]> = [
      ['queued', 'complete'],
      ['queued', 'waiting'],
      ['queued', 'retrying'],
      ['running', 'queued'],
      ['complete', 'running'],
      ['complete', 'failed'],
      ['failed', 'running'],
      ['failed', 'complete'],
      ['waiting', 'complete'],
      ['retrying', 'complete'],
    ];

    it.each(invalidTransitions)(
      'should reject %s → %s with EngineError',
      (from, to) => {
        expect(() =>
          validateTransition(from as any, to as any),
        ).toThrow(EngineError);
      },
    );
  });

  describe('transitionExecution', () => {
    it('should transition from queued to running', () => {
      const exec = createExecution('flow', 'key', null);
      transitionExecution(exec, 'running');

      expect(exec.state).toBe('running');
      expect(exec.timestamps.started).not.toBeNull();
      expect(exec.timestamps.transitions).toHaveLength(1);
      expect(exec.timestamps.transitions[0].from).toBe('queued');
      expect(exec.timestamps.transitions[0].to).toBe('running');
    });

    it('should transition from running to complete', () => {
      const exec = createExecution('flow', 'key', null);
      transitionExecution(exec, 'running');
      transitionExecution(exec, 'complete');

      expect(exec.state).toBe('complete');
      expect(exec.timestamps.completed).not.toBeNull();
      expect(exec.timestamps.transitions).toHaveLength(2);
    });

    it('should record timestamps for each transition', () => {
      const exec = createExecution('flow', 'key', null);
      transitionExecution(exec, 'running');
      transitionExecution(exec, 'retrying');
      transitionExecution(exec, 'running');
      transitionExecution(exec, 'complete');

      expect(exec.timestamps.transitions).toHaveLength(4);
      for (const t of exec.timestamps.transitions) {
        expect(t.at).toBeInstanceOf(Date);
      }
    });

    it('should throw EngineError on invalid transition', () => {
      const exec = createExecution('flow', 'key', null);
      expect(() => transitionExecution(exec, 'complete')).toThrow(EngineError);
    });

    it('should set started timestamp only on first running transition', () => {
      const exec = createExecution('flow', 'key', null);
      transitionExecution(exec, 'running');
      const firstStarted = exec.timestamps.started;

      transitionExecution(exec, 'retrying');
      transitionExecution(exec, 'running');

      expect(exec.timestamps.started).toBe(firstStarted);
    });

    it('should set completed timestamp on failed', () => {
      const exec = createExecution('flow', 'key', null);
      transitionExecution(exec, 'failed');

      expect(exec.timestamps.completed).not.toBeNull();
    });
  });
});
