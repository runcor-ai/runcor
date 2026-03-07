import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  disableColor,
  isColorEnabled,
  red,
  green,
  yellow,
  cyan,
  dim,
  bold,
  formatTable,
  formatJson,
  formatError,
  formatSuccess,
  formatEventLog,
  relativeTime,
} from '../../../src/cli/output.js';

describe('CLI output module', () => {
  // Note: color is auto-detected from TTY + NO_COLOR.
  // In test (non-TTY), color is already disabled.

  describe('color functions (no-color mode)', () => {
    it('red returns plain text when color disabled', () => {
      disableColor();
      expect(red('hello')).toBe('hello');
    });

    it('green returns plain text when color disabled', () => {
      disableColor();
      expect(green('ok')).toBe('ok');
    });

    it('bold returns plain text when color disabled', () => {
      disableColor();
      expect(bold('title')).toBe('title');
    });

    it('dim returns plain text when color disabled', () => {
      disableColor();
      expect(dim('faint')).toBe('faint');
    });
  });

  describe('formatTable', () => {
    it('formats header, separator, and rows', () => {
      const rows = [
        { id: 'abc123', name: 'hello' },
        { id: 'def456', name: 'world' },
      ];
      const columns = [
        { key: 'id', label: 'ID', width: 8 },
        { key: 'name', label: 'NAME', width: 10 },
      ];
      const result = formatTable(rows, columns);
      const lines = result.split('\n');
      expect(lines.length).toBe(4); // header + separator + 2 rows
      expect(lines[0]).toContain('ID');
      expect(lines[0]).toContain('NAME');
      expect(lines[2]).toContain('abc123');
      expect(lines[3]).toContain('world');
    });

    it('truncates values longer than column width', () => {
      const rows = [{ longval: 'abcdefghijklmnop' }];
      const columns = [{ key: 'longval', label: 'VAL', width: 8 }];
      const result = formatTable(rows, columns);
      const lines = result.split('\n');
      // Should be 7 chars + ellipsis = 8
      expect(lines[2].trim().length).toBeLessThanOrEqual(8);
      expect(lines[2]).toContain('\u2026'); // ellipsis
    });

    it('handles empty rows', () => {
      const columns = [{ key: 'id', label: 'ID', width: 10 }];
      const result = formatTable([], columns);
      const lines = result.split('\n');
      expect(lines.length).toBe(2); // header + separator only
    });

    it('handles missing keys gracefully', () => {
      const rows = [{ id: '123' }]; // 'name' key missing
      const columns = [
        { key: 'id', label: 'ID', width: 6 },
        { key: 'name', label: 'NAME', width: 6 },
      ];
      const result = formatTable(rows, columns);
      expect(result).toContain('123');
    });
  });

  describe('formatJson', () => {
    it('produces pretty-printed JSON', () => {
      const result = formatJson({ key: 'value' });
      expect(result).toBe('{\n  "key": "value"\n}');
    });

    it('handles arrays', () => {
      const result = formatJson([1, 2, 3]);
      expect(result).toContain('[');
    });

    it('handles null', () => {
      expect(formatJson(null)).toBe('null');
    });
  });

  describe('formatError', () => {
    it('includes error message', () => {
      disableColor();
      const result = formatError('TEST_CODE', 'something went wrong');
      expect(result).toContain('something went wrong');
      expect(result).toContain('Error:');
    });
  });

  describe('formatSuccess', () => {
    it('includes success message', () => {
      disableColor();
      const result = formatSuccess('All good');
      expect(result).toBe('All good');
    });
  });

  describe('formatEventLog', () => {
    it('formats execution:state_change event', () => {
      disableColor();
      const result = formatEventLog('execution:state_change', {
        executionId: 'abc-123456789012',
        from: 'queued',
        to: 'running',
        flowName: 'hello',
      });
      expect(result).toContain('[execution]');
      expect(result).toContain('hello');
      expect(result).toContain('queued');
      expect(result).toContain('running');
      expect(result).toContain('(abc-12345678)'); // truncated to 12
    });

    it('formats cost:request event', () => {
      disableColor();
      const result = formatEventLog('cost:request', {
        executionId: 'abc-123',
        flowName: 'hello',
        cost: 0.0023,
        model: 'gpt-4o',
      });
      expect(result).toContain('[cost]');
      expect(result).toContain('$0.0023');
      expect(result).toContain('gpt-4o');
    });

    it('formats flow:registered event', () => {
      disableColor();
      const result = formatEventLog('flow:registered', { name: 'my-flow' });
      expect(result).toContain('[flow]');
      expect(result).toContain('my-flow');
    });

    it('formats unknown event generically', () => {
      disableColor();
      const result = formatEventLog('custom:event', { foo: 'bar', baz: 42 });
      expect(result).toContain('foo=bar');
      expect(result).toContain('baz=42');
    });

    it('includes timestamp', () => {
      disableColor();
      const result = formatEventLog('execution:complete', {});
      // Should contain HH:MM:SS format
      expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('relativeTime', () => {
    it('returns seconds ago for recent dates', () => {
      const date = new Date(Date.now() - 5000);
      expect(relativeTime(date)).toBe('5s ago');
    });

    it('returns minutes ago', () => {
      const date = new Date(Date.now() - 120000);
      expect(relativeTime(date)).toBe('2m ago');
    });

    it('returns hours ago', () => {
      const date = new Date(Date.now() - 7200000);
      expect(relativeTime(date)).toBe('2h ago');
    });

    it('returns days ago', () => {
      const date = new Date(Date.now() - 172800000);
      expect(relativeTime(date)).toBe('2d ago');
    });
  });
});
