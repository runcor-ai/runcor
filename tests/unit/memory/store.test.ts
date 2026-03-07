// Unit tests for InMemoryStore
// Per contracts/memory-api.md MemoryStore interface

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStore } from '../../../src/memory/store.js';
import type { MemoryEntry } from '../../../src/types.js';

describe('InMemoryStore', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  describe('get', () => {
    it('returns null for a missing key', async () => {
      const result = await store.get('ns', 'missing');
      expect(result).toBeNull();
    });

    it('returns the stored entry for an existing key', async () => {
      const entry: MemoryEntry = {
        key: 'mykey',
        value: 42,
        createdAt: new Date(),
        expiresAt: null,
      };
      await store.set('ns', 'mykey', entry);
      const result = await store.get('ns', 'mykey');
      expect(result).not.toBeNull();
      expect(result!.value).toBe(42);
      expect(result!.key).toBe('mykey');
    });

    it('returns null for an expired entry and removes it', async () => {
      const entry: MemoryEntry = {
        key: 'expiring',
        value: 'old',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() - 1000), // already expired
      };
      await store.set('ns', 'expiring', entry);
      const result = await store.get('ns', 'expiring');
      expect(result).toBeNull();
    });

    it('isolates entries by namespace', async () => {
      const entry: MemoryEntry = {
        key: 'shared',
        value: 'ns1-data',
        createdAt: new Date(),
        expiresAt: null,
      };
      await store.set('ns1', 'shared', entry);
      const result = await store.get('ns2', 'shared');
      expect(result).toBeNull();
    });
  });

  describe('set', () => {
    it('stores an entry that can be retrieved', async () => {
      const entry: MemoryEntry = {
        key: 'k',
        value: { nested: true },
        createdAt: new Date(),
        expiresAt: null,
      };
      await store.set('ns', 'k', entry);
      const result = await store.get('ns', 'k');
      expect(result!.value).toEqual({ nested: true });
    });

    it('overwrites an existing entry', async () => {
      const entry1: MemoryEntry = {
        key: 'k',
        value: 'first',
        createdAt: new Date(),
        expiresAt: null,
      };
      const entry2: MemoryEntry = {
        key: 'k',
        value: 'second',
        createdAt: new Date(),
        expiresAt: null,
      };
      await store.set('ns', 'k', entry1);
      await store.set('ns', 'k', entry2);
      const result = await store.get('ns', 'k');
      expect(result!.value).toBe('second');
    });
  });

  describe('delete', () => {
    it('removes an existing entry', async () => {
      const entry: MemoryEntry = {
        key: 'k',
        value: 'val',
        createdAt: new Date(),
        expiresAt: null,
      };
      await store.set('ns', 'k', entry);
      await store.delete('ns', 'k');
      const result = await store.get('ns', 'k');
      expect(result).toBeNull();
    });

    it('succeeds silently for a nonexistent key', async () => {
      // Should not throw
      await store.delete('ns', 'nonexistent');
    });
  });

  describe('list', () => {
    it('returns all keys in a namespace', async () => {
      await store.set('ns', 'a', { key: 'a', value: 1, createdAt: new Date(), expiresAt: null });
      await store.set('ns', 'b', { key: 'b', value: 2, createdAt: new Date(), expiresAt: null });
      await store.set('other', 'c', { key: 'c', value: 3, createdAt: new Date(), expiresAt: null });

      const keys = await store.list('ns');
      expect(keys.sort()).toEqual(['a', 'b']);
    });

    it('returns empty array for empty namespace', async () => {
      const keys = await store.list('empty-ns');
      expect(keys).toEqual([]);
    });

    it('excludes expired keys from listing', async () => {
      await store.set('ns', 'alive', {
        key: 'alive',
        value: 1,
        createdAt: new Date(),
        expiresAt: null,
      });
      await store.set('ns', 'dead', {
        key: 'dead',
        value: 2,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() - 1000), // already expired
      });

      const keys = await store.list('ns');
      expect(keys).toEqual(['alive']);
    });
  });

  describe('deleteNamespace', () => {
    it('removes all entries in a namespace', async () => {
      await store.set('ns', 'a', { key: 'a', value: 1, createdAt: new Date(), expiresAt: null });
      await store.set('ns', 'b', { key: 'b', value: 2, createdAt: new Date(), expiresAt: null });
      await store.set('other', 'c', { key: 'c', value: 3, createdAt: new Date(), expiresAt: null });

      await store.deleteNamespace('ns');

      expect(await store.list('ns')).toEqual([]);
      // Other namespace unaffected
      expect(await store.list('other')).toEqual(['c']);
    });

    it('succeeds silently for an empty namespace', async () => {
      await store.deleteNamespace('nonexistent');
    });
  });
});
