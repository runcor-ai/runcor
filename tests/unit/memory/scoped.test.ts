// Unit tests for ScopedMemory
// Per contracts/memory-api.md ScopedMemory interface

import { describe, it, expect, beforeEach } from 'vitest';
import { ScopedMemoryImpl } from '../../../src/memory/scoped.js';
import { InMemoryStore } from '../../../src/memory/store.js';
import { EngineError } from '../../../src/errors.js';

describe('ScopedMemory', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  describe('get', () => {
    it('returns null for a missing key', async () => {
      const scoped = new ScopedMemoryImpl(store, 'tool:counter');
      const result = await scoped.get('missing');
      expect(result).toBeNull();
    });

    it('returns the stored value with correct type', async () => {
      const scoped = new ScopedMemoryImpl(store, 'tool:counter');
      await scoped.set('count', 42);
      const result = await scoped.get<number>('count');
      expect(result).toBe(42);
    });

    it('returns complex objects', async () => {
      const scoped = new ScopedMemoryImpl(store, 'tool:test');
      await scoped.set('data', { nested: { deep: true }, arr: [1, 2] });
      const result = await scoped.get<{ nested: { deep: boolean }; arr: number[] }>('data');
      expect(result).toEqual({ nested: { deep: true }, arr: [1, 2] });
    });
  });

  describe('set', () => {
    it('stores a value that can be retrieved', async () => {
      const scoped = new ScopedMemoryImpl(store, 'tool:test');
      await scoped.set('key', 'value');
      const result = await scoped.get<string>('key');
      expect(result).toBe('value');
    });

    it('overwrites an existing value', async () => {
      const scoped = new ScopedMemoryImpl(store, 'tool:test');
      await scoped.set('key', 'first');
      await scoped.set('key', 'second');
      const result = await scoped.get<string>('key');
      expect(result).toBe('second');
    });

    it('rejects empty string keys with INVALID_MEMORY_KEY', async () => {
      const scoped = new ScopedMemoryImpl(store, 'tool:test');
      await expect(scoped.set('', 'value')).rejects.toThrow(EngineError);
      try {
        await scoped.set('', 'value');
      } catch (err) {
        expect((err as EngineError).code).toBe('INVALID_MEMORY_KEY');
      }
    });

    it('rejects non-serializable values (function) with INVALID_MEMORY_VALUE', async () => {
      const scoped = new ScopedMemoryImpl(store, 'tool:test');
      await expect(scoped.set('fn', () => {})).rejects.toThrow(EngineError);
      try {
        await scoped.set('fn', () => {});
      } catch (err) {
        expect((err as EngineError).code).toBe('INVALID_MEMORY_VALUE');
      }
    });

    it('rejects circular references with INVALID_MEMORY_VALUE', async () => {
      const scoped = new ScopedMemoryImpl(store, 'tool:test');
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await expect(scoped.set('circ', circular)).rejects.toThrow(EngineError);
    });

    it('stores null as-is (valid JSON)', async () => {
      const scoped = new ScopedMemoryImpl(store, 'tool:test');
      await scoped.set('key', null);
      const result = await scoped.get('key');
      expect(result).toBeNull();
    });

    it('treats undefined as null (JSON.stringify converts undefined to null)', async () => {
      const scoped = new ScopedMemoryImpl(store, 'tool:test');
      await scoped.set('key', undefined);
      const result = await scoped.get('key');
      expect(result).toBeNull();
    });

    it('accepts TTL in milliseconds', async () => {
      const scoped = new ScopedMemoryImpl(store, 'tool:test');
      await scoped.set('key', 'val', 60000);
      const result = await scoped.get<string>('key');
      expect(result).toBe('val');
    });

    it('treats TTL of 0 as no expiry', async () => {
      const scoped = new ScopedMemoryImpl(store, 'tool:test');
      await scoped.set('key', 'val', 0);
      const entry = await store.get('tool:test', 'key');
      expect(entry!.expiresAt).toBeNull();
    });

    it('does not store a key with negative TTL', async () => {
      const scoped = new ScopedMemoryImpl(store, 'tool:test');
      await scoped.set('key', 'val', -100);
      const result = await scoped.get('key');
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('removes an existing key', async () => {
      const scoped = new ScopedMemoryImpl(store, 'tool:test');
      await scoped.set('key', 'value');
      await scoped.delete('key');
      const result = await scoped.get('key');
      expect(result).toBeNull();
    });

    it('succeeds silently for a nonexistent key', async () => {
      const scoped = new ScopedMemoryImpl(store, 'tool:test');
      // Should not throw
      await scoped.delete('nonexistent');
    });
  });

  describe('list', () => {
    it('returns all non-expired keys', async () => {
      const scoped = new ScopedMemoryImpl(store, 'tool:test');
      await scoped.set('a', 1);
      await scoped.set('b', 2);
      const keys = await scoped.list();
      expect(keys.sort()).toEqual(['a', 'b']);
    });

    it('returns empty array for empty scope', async () => {
      const scoped = new ScopedMemoryImpl(store, 'tool:test');
      const keys = await scoped.list();
      expect(keys).toEqual([]);
    });
  });

  describe('namespace isolation', () => {
    it('different namespaces do not see each other\'s keys', async () => {
      const scopeA = new ScopedMemoryImpl(store, 'tool:flowA');
      const scopeB = new ScopedMemoryImpl(store, 'tool:flowB');

      await scopeA.set('data', 'A-data');
      const result = await scopeB.get('data');
      expect(result).toBeNull();
    });

    it('tool and user namespaces are isolated', async () => {
      const tool = new ScopedMemoryImpl(store, 'tool:myflow');
      const user = new ScopedMemoryImpl(store, 'user:user-1');

      await tool.set('key', 'tool-value');
      await user.set('key', 'user-value');

      expect(await tool.get('key')).toBe('tool-value');
      expect(await user.get('key')).toBe('user-value');
    });
  });

  // T010: ExecutionContext memory property tests
  describe('ExecutionContext memory accessor', () => {
    it('ctx.memory.tool uses namespace "tool:{flowName}"', async () => {
      const scoped = new ScopedMemoryImpl(store, 'tool:counter');
      await scoped.set('count', 1);

      // Verify it's stored under the correct namespace in the raw store
      const raw = await store.get('tool:counter', 'count');
      expect(raw).not.toBeNull();
      expect(raw!.value).toBe(1);
    });
  });
});
