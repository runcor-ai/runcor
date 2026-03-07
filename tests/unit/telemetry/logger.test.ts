// Unit tests for structured logging via EngineInstrumentation.log()
// Per tasks T046-T049

import { describe, it, expect, vi } from 'vitest';
import { EngineInstrumentation } from '../../../src/telemetry/instrumentation.js';
import { trace, context as otelContext } from '@opentelemetry/api';
import type { LogRecord } from '../../../src/types.js';

// ── T046: EngineLogger creation and log method ──

describe('Structured Logging', () => {
  describe('log method constructs LogRecord', () => {
    it('calls logHandler with correct level and message', () => {
      const records: LogRecord[] = [];
      const handler = (record: LogRecord) => { records.push(record); };
      const inst = new EngineInstrumentation({ logHandler: handler });

      inst.log('info', 'Test message', { key: 'value' });

      expect(records).toHaveLength(1);
      expect(records[0].level).toBe('info');
      expect(records[0].message).toBe('Test message');
    });

    it('includes attributes in LogRecord', () => {
      const records: LogRecord[] = [];
      const handler = (record: LogRecord) => { records.push(record); };
      const inst = new EngineInstrumentation({ logHandler: handler });

      inst.log('debug', 'Debug msg', { executionId: 'exec-1', flowName: 'myFlow' });

      expect(records[0].attributes).toEqual({ executionId: 'exec-1', flowName: 'myFlow' });
    });

    it('includes timestamp', () => {
      const records: LogRecord[] = [];
      const handler = (record: LogRecord) => { records.push(record); };
      const inst = new EngineInstrumentation({ logHandler: handler });

      const before = new Date();
      inst.log('info', 'Timestamped', {});
      const after = new Date();

      expect(records[0].timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(records[0].timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('includes traceId and spanId when span is provided', () => {
      const records: LogRecord[] = [];
      const handler = (record: LogRecord) => { records.push(record); };
      const inst = new EngineInstrumentation({ logHandler: handler });

      const { span } = inst.startTriggerSpan('exec-1', 'flow', undefined, 'key-1');
      inst.log('info', 'With span', {}, span);

      // No-op spans have zero trace/span IDs, but the field should be set
      expect(records[0].traceId).toBeDefined();
      expect(records[0].spanId).toBeDefined();
    });

    it('sets traceId and spanId to null when no span provided', () => {
      const records: LogRecord[] = [];
      const handler = (record: LogRecord) => { records.push(record); };
      const inst = new EngineInstrumentation({ logHandler: handler });

      inst.log('info', 'No span', {});

      expect(records[0].traceId).toBeNull();
      expect(records[0].spanId).toBeNull();
    });
  });

  // ── T047: Log level assignments ──

  describe('log level assignments', () => {
    it('supports info level for lifecycle events', () => {
      const records: LogRecord[] = [];
      const handler = (record: LogRecord) => { records.push(record); };
      const inst = new EngineInstrumentation({ logHandler: handler });

      inst.log('info', 'Execution started', { executionId: 'e1', flowName: 'f1' });

      expect(records[0].level).toBe('info');
    });

    it('supports warn level for budget warnings', () => {
      const records: LogRecord[] = [];
      const handler = (record: LogRecord) => { records.push(record); };
      const inst = new EngineInstrumentation({ logHandler: handler });

      inst.log('warn', 'Budget warning', { scope: 'global', utilization: 0.85 });

      expect(records[0].level).toBe('warn');
    });

    it('supports error level for failures', () => {
      const records: LogRecord[] = [];
      const handler = (record: LogRecord) => { records.push(record); };
      const inst = new EngineInstrumentation({ logHandler: handler });

      inst.log('error', 'Execution failed', { error: 'timeout' });

      expect(records[0].level).toBe('error');
    });

    it('supports debug level for memory and cost operations', () => {
      const records: LogRecord[] = [];
      const handler = (record: LogRecord) => { records.push(record); };
      const inst = new EngineInstrumentation({ logHandler: handler });

      inst.log('debug', 'Memory get', { namespace: 'tool:myFlow', key: 'data' });

      expect(records[0].level).toBe('debug');
    });
  });

  // ── T048: No-op logging ──

  describe('no-op logging', () => {
    it('does not call any handler when logHandler is not configured', () => {
      const inst = new EngineInstrumentation({});

      // Should silently do nothing
      expect(() => inst.log('info', 'Should be silent', {})).not.toThrow();
    });

    it('does not call handler even with span context', () => {
      const inst = new EngineInstrumentation({});
      const { span } = inst.startTriggerSpan('exec-1', 'flow', undefined, 'key-1');

      expect(() => inst.log('error', 'No handler', { err: 'fail' }, span)).not.toThrow();
    });
  });

  // ── T049: Log handler error resilience ──

  describe('log handler error resilience', () => {
    it('swallows errors thrown by logHandler', () => {
      const brokenHandler = () => { throw new Error('handler broke'); };
      const inst = new EngineInstrumentation({ logHandler: brokenHandler });

      expect(() => inst.log('info', 'Should not throw', {})).not.toThrow();
    });

    it('continues logging after handler error', () => {
      let callCount = 0;
      const handler = () => {
        callCount++;
        if (callCount === 1) throw new Error('first call fails');
      };
      const inst = new EngineInstrumentation({ logHandler: handler });

      inst.log('info', 'First call', {});
      inst.log('info', 'Second call', {});

      expect(callCount).toBe(2);
    });
  });
});
