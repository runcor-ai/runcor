// MemoryStore interface + InMemoryStore implementation

import type { MemoryEntry, MemoryStore } from '../types.js';

/**
 * Default in-memory implementation of MemoryStore.
 * Uses a single Map with composite keys (namespace:key).
 * Lazy expiry — expired entries are removed on read.
 */
export class InMemoryStore implements MemoryStore {
  private readonly data = new Map<string, MemoryEntry>();

  private compositeKey(namespace: string, key: string): string {
    return `${namespace}:${key}`;
  }

  async get(namespace: string, key: string): Promise<MemoryEntry | null> {
    const ck = this.compositeKey(namespace, key);
    const entry = this.data.get(ck);
    if (!entry) return null;

    // Lazy expiry: remove if expired
    if (entry.expiresAt && entry.expiresAt.getTime() <= Date.now()) {
      this.data.delete(ck);
      return null;
    }

    return entry;
  }

  async set(namespace: string, key: string, entry: MemoryEntry): Promise<void> {
    const ck = this.compositeKey(namespace, key);
    this.data.set(ck, entry);
  }

  async delete(namespace: string, key: string): Promise<void> {
    const ck = this.compositeKey(namespace, key);
    this.data.delete(ck);
  }

  async list(namespace: string): Promise<string[]> {
    const prefix = `${namespace}:`;
    const keys: string[] = [];
    const toDelete: string[] = [];

    for (const [ck, entry] of this.data) {
      if (!ck.startsWith(prefix)) continue;

      // Lazy expiry during list
      if (entry.expiresAt && entry.expiresAt.getTime() <= Date.now()) {
        toDelete.push(ck);
        continue;
      }

      keys.push(entry.key);
    }

    // Clean up expired entries
    for (const ck of toDelete) {
      this.data.delete(ck);
    }

    return keys;
  }

  async deleteNamespace(namespace: string): Promise<void> {
    const prefix = `${namespace}:`;
    const toDelete: string[] = [];

    for (const ck of this.data.keys()) {
      if (ck.startsWith(prefix)) {
        toDelete.push(ck);
      }
    }

    for (const ck of toDelete) {
      this.data.delete(ck);
    }
  }
}
