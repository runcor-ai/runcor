/**
 * ResourceCache — TTL-based cache for MCP adapter resource content.
 *
 * Stores ResourceContent keyed by composite key `{adapterName}:{uri}`.
 * Entries expire automatically after their TTL elapses.
 */

import type { ResourceContent } from '../types.js';

interface CacheEntry {
  content: ResourceContent;
  expiresAt: number;
}

export class ResourceCache {
  private readonly cache = new Map<string, CacheEntry>();

  /** Build the composite cache key from adapter name and resource URI. */
  private key(adapterName: string, uri: string): string {
    return `${adapterName}:${uri}`;
  }

  /**
   * Get cached resource content, or null if expired/missing.
   * Expired entries are lazily deleted on access.
   */
  get(adapterName: string, uri: string): ResourceContent | null {
    const entry = this.cache.get(this.key(adapterName, uri));
    if (!entry) {
      return null;
    }
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(this.key(adapterName, uri));
      return null;
    }
    return entry.content;
  }

  /** Store resource content with a TTL in milliseconds. */
  set(
    adapterName: string,
    uri: string,
    content: ResourceContent,
    ttlMs: number,
  ): void {
    this.cache.set(this.key(adapterName, uri), {
      content,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /** Check if a non-expired entry exists for the given adapter and URI. */
  has(adapterName: string, uri: string): boolean {
    return this.get(adapterName, uri) !== null;
  }

  /** Clear all cached entries for a specific adapter. */
  clearAdapter(adapterName: string): void {
    const prefix = `${adapterName}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /** Clear all cached entries across all adapters. */
  clearAll(): void {
    this.cache.clear();
  }
}
