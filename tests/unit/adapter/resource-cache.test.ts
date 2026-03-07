// Unit tests for ResourceCache
// Per spec T008: composite-key caching with TTL expiry

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ResourceCache } from '../../../src/adapter/resource-cache.js';
import type { ResourceContent } from '../../../src/types.js';

describe('ResourceCache', () => {
  let cache: ResourceCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new ResourceCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('set and get', () => {
    it('stores and retrieves a resource by composite key (adapterName:uri)', () => {
      const content: ResourceContent = {
        uri: 'file:///readme.md',
        text: '# Hello',
        mimeType: 'text/markdown',
      };

      cache.set('github', 'file:///readme.md', content, 60_000);

      const result = cache.get('github', 'file:///readme.md');
      expect(result).toEqual(content);
    });

    it('keeps entries from different adapters separate', () => {
      const contentA: ResourceContent = { uri: 'config.json', text: '{"a":1}' };
      const contentB: ResourceContent = { uri: 'config.json', text: '{"b":2}' };

      cache.set('adapterA', 'config.json', contentA, 60_000);
      cache.set('adapterB', 'config.json', contentB, 60_000);

      expect(cache.get('adapterA', 'config.json')).toEqual(contentA);
      expect(cache.get('adapterB', 'config.json')).toEqual(contentB);
    });
  });

  describe('TTL expiry', () => {
    it('returns null after TTL has elapsed', () => {
      const content: ResourceContent = {
        uri: 'data.csv',
        text: 'a,b,c',
        mimeType: 'text/csv',
      };

      cache.set('files', 'data.csv', content, 5_000);

      // Still valid before TTL
      vi.advanceTimersByTime(4_999);
      expect(cache.get('files', 'data.csv')).toEqual(content);

      // Expired at exactly TTL boundary
      vi.advanceTimersByTime(1);
      expect(cache.get('files', 'data.csv')).toBeNull();
    });

    it('returns null well after TTL has elapsed', () => {
      const content: ResourceContent = { uri: 'temp', text: 'x' };

      cache.set('adapter', 'temp', content, 1_000);
      vi.advanceTimersByTime(10_000);

      expect(cache.get('adapter', 'temp')).toBeNull();
    });
  });

  describe('get returns null for missing key', () => {
    it('returns null when no entry exists for the adapter/uri pair', () => {
      expect(cache.get('nonexistent', 'missing://resource')).toBeNull();
    });

    it('returns null for correct adapter but wrong uri', () => {
      const content: ResourceContent = { uri: 'exists', text: 'yes' };
      cache.set('adapter', 'exists', content, 60_000);

      expect(cache.get('adapter', 'does-not-exist')).toBeNull();
    });

    it('returns null for correct uri but wrong adapter', () => {
      const content: ResourceContent = { uri: 'exists', text: 'yes' };
      cache.set('adapterA', 'exists', content, 60_000);

      expect(cache.get('adapterB', 'exists')).toBeNull();
    });
  });

  describe('clearAdapter', () => {
    it('removes all entries for the specified adapter', () => {
      const c1: ResourceContent = { uri: 'r1', text: '1' };
      const c2: ResourceContent = { uri: 'r2', text: '2' };
      const c3: ResourceContent = { uri: 'r3', text: '3' };

      cache.set('target', 'r1', c1, 60_000);
      cache.set('target', 'r2', c2, 60_000);
      cache.set('other', 'r3', c3, 60_000);

      cache.clearAdapter('target');

      expect(cache.get('target', 'r1')).toBeNull();
      expect(cache.get('target', 'r2')).toBeNull();
      // Other adapter untouched
      expect(cache.get('other', 'r3')).toEqual(c3);
    });

    it('does nothing when adapter has no entries', () => {
      const content: ResourceContent = { uri: 'x', text: 'y' };
      cache.set('keep', 'x', content, 60_000);

      cache.clearAdapter('empty');

      expect(cache.get('keep', 'x')).toEqual(content);
    });
  });

  describe('clearAll', () => {
    it('removes all entries across all adapters', () => {
      cache.set('a', 'r1', { uri: 'r1', text: '1' }, 60_000);
      cache.set('b', 'r2', { uri: 'r2', text: '2' }, 60_000);
      cache.set('c', 'r3', { uri: 'r3', text: '3' }, 60_000);

      cache.clearAll();

      expect(cache.get('a', 'r1')).toBeNull();
      expect(cache.get('b', 'r2')).toBeNull();
      expect(cache.get('c', 'r3')).toBeNull();
    });

    it('is safe to call on an empty cache', () => {
      expect(() => cache.clearAll()).not.toThrow();
    });
  });

  describe('has', () => {
    it('returns true for a cached, non-expired entry', () => {
      cache.set('adapter', 'res', { uri: 'res', text: 'data' }, 60_000);

      expect(cache.has('adapter', 'res')).toBe(true);
    });

    it('returns false for a missing entry', () => {
      expect(cache.has('adapter', 'nope')).toBe(false);
    });

    it('returns false after TTL expiry', () => {
      cache.set('adapter', 'res', { uri: 'res', text: 'data' }, 3_000);

      vi.advanceTimersByTime(3_000);

      expect(cache.has('adapter', 'res')).toBe(false);
    });
  });

  describe('overwrite', () => {
    it('setting the same key overwrites the previous value', () => {
      const original: ResourceContent = {
        uri: 'doc',
        text: 'version 1',
        mimeType: 'text/plain',
      };
      const updated: ResourceContent = {
        uri: 'doc',
        text: 'version 2',
        mimeType: 'text/plain',
      };

      cache.set('adapter', 'doc', original, 60_000);
      cache.set('adapter', 'doc', updated, 60_000);

      expect(cache.get('adapter', 'doc')).toEqual(updated);
    });

    it('overwriting resets the TTL', () => {
      const content: ResourceContent = { uri: 'doc', text: 'v1' };
      const refreshed: ResourceContent = { uri: 'doc', text: 'v2' };

      cache.set('adapter', 'doc', content, 5_000);

      // Advance 4 seconds (still valid)
      vi.advanceTimersByTime(4_000);

      // Overwrite with fresh TTL
      cache.set('adapter', 'doc', refreshed, 5_000);

      // Advance another 4 seconds — original would have expired, but overwrite reset TTL
      vi.advanceTimersByTime(4_000);

      expect(cache.get('adapter', 'doc')).toEqual(refreshed);

      // Advance past the new TTL
      vi.advanceTimersByTime(1_000);
      expect(cache.get('adapter', 'doc')).toBeNull();
    });
  });
});
