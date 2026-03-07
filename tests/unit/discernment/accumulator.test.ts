// Unit tests for SignalAccumulator

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { SignalAccumulator } from '../../../src/discernment/accumulator.js';

describe('SignalAccumulator', () => {
  let accumulator: SignalAccumulator;
  let emitter: EventEmitter;

  beforeEach(() => {
    emitter = new EventEmitter();
    accumulator = new SignalAccumulator();
    accumulator.attach(emitter);
  });

  describe('event subscription', () => {
    it('records policy:violation events', () => {
      emitter.emit('policy:violation', {
        ruleName: 'deny-rule',
        operation: 'trigger',
        flowName: 'flow-a',
        userId: 'user-1',
        tenantId: null,
        reason: 'denied',
        timestamp: new Date(),
      });

      const violations = accumulator.getViolations('flow-a', new Date(0));
      expect(violations).toHaveLength(1);
      expect(violations[0].payload.ruleName).toBe('deny-rule');
    });

    it('records policy:rate_limited events', () => {
      emitter.emit('policy:rate_limited', {
        rateLimitName: 'global-limit',
        scope: 'flow',
        flowName: 'flow-a',
        userId: null,
        tenantId: null,
        limit: 10,
        windowMs: 60000,
        currentCount: 11,
        behavior: 'reject',
        timestamp: new Date(),
      });

      const violations = accumulator.getViolations('flow-a', new Date(0));
      expect(violations).toHaveLength(1);
    });

    it('records adapter:tool_call events', () => {
      emitter.emit('adapter:tool_call', {
        adapter: 'slack',
        tool: 'send-message',
        durationMs: 100,
        success: true,
      });

      const calls = accumulator.getToolCalls('__global', new Date(0));
      expect(calls).toHaveLength(1);
      expect(calls[0].payload.adapter).toBe('slack');
    });
  });

  describe('query within lookback window', () => {
    it('returns entries within window', () => {
      const old = new Date('2026-01-01T00:00:00Z');
      const recent = new Date('2026-02-15T00:00:00Z');
      const cutoff = new Date('2026-02-01T00:00:00Z');

      // Inject entries with specific timestamps
      (accumulator as any).entries.get('violation')?.push(
        { flowName: 'flow-a', timestamp: old, payload: { ruleName: 'r1' } },
      );
      (accumulator as any).entries.get('violation')?.push(
        { flowName: 'flow-a', timestamp: recent, payload: { ruleName: 'r2' } },
      );

      const results = accumulator.getViolations('flow-a', cutoff);
      expect(results).toHaveLength(1);
      expect(results[0].payload.ruleName).toBe('r2');
    });
  });

  describe('prune', () => {
    it('removes entries older than cutoff', () => {
      const old = new Date('2026-01-01T00:00:00Z');

      emitter.emit('policy:violation', {
        ruleName: 'old-rule',
        operation: 'trigger',
        flowName: 'flow-a',
        userId: null,
        tenantId: null,
        reason: 'denied',
        timestamp: old,
      });

      // Prune everything before Feb
      accumulator.prune(new Date('2026-02-01T00:00:00Z'));

      const violations = accumulator.getViolations('flow-a', new Date(0));
      expect(violations).toHaveLength(0);
    });
  });

  describe('per-flow bucketing', () => {
    it('isolates entries by flow name', () => {
      emitter.emit('policy:violation', {
        ruleName: 'r1',
        operation: 'trigger',
        flowName: 'flow-a',
        userId: null,
        tenantId: null,
        reason: 'denied',
        timestamp: new Date(),
      });

      emitter.emit('policy:violation', {
        ruleName: 'r2',
        operation: 'trigger',
        flowName: 'flow-b',
        userId: null,
        tenantId: null,
        reason: 'denied',
        timestamp: new Date(),
      });

      expect(accumulator.getViolations('flow-a', new Date(0))).toHaveLength(1);
      expect(accumulator.getViolations('flow-b', new Date(0))).toHaveLength(1);
    });
  });

  describe('empty results', () => {
    it('returns empty for unknown flow', () => {
      expect(accumulator.getViolations('unknown', new Date(0))).toEqual([]);
      expect(accumulator.getToolCalls('unknown', new Date(0))).toEqual([]);
      expect(accumulator.getMcpInvocations('unknown', new Date(0))).toEqual([]);
    });
  });

  describe('detach', () => {
    it('stops recording events after detach', () => {
      accumulator.detach();

      emitter.emit('policy:violation', {
        ruleName: 'r1',
        operation: 'trigger',
        flowName: 'flow-a',
        userId: null,
        tenantId: null,
        reason: 'denied',
        timestamp: new Date(),
      });

      expect(accumulator.getViolations('flow-a', new Date(0))).toEqual([]);
    });
  });

  describe('multiple event types', () => {
    it('tracks violations and tool calls independently', () => {
      emitter.emit('policy:violation', {
        ruleName: 'r1',
        operation: 'trigger',
        flowName: 'flow-a',
        userId: null,
        tenantId: null,
        reason: 'denied',
        timestamp: new Date(),
      });

      emitter.emit('adapter:tool_call', {
        adapter: 'slack',
        tool: 'send',
        durationMs: 50,
        success: true,
      });

      expect(accumulator.getViolations('flow-a', new Date(0))).toHaveLength(1);
      // Tool calls don't have per-flow bucketing in the event payload, they go to __global
      expect(accumulator.getToolCalls('__global', new Date(0))).toHaveLength(1);
    });
  });
});
