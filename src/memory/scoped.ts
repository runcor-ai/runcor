// ScopedMemory class — wraps MemoryStore with a fixed namespace

import type { MemoryEntry, MemoryStore, ScopedMemory } from '../types.js';
import { EngineError } from '../errors.js';
import type { EngineInstrumentation } from '../telemetry/instrumentation.js';
import type { Context } from '@opentelemetry/api';

/**
 * Scoped memory accessor that wraps a MemoryStore with a fixed namespace.
 * Provides get/set/delete/list operations within a single scope.
 * Validates keys and values at write time.
 * Optionally creates memory spans when telemetry is configured with memorySpans=true.
 */
export class ScopedMemoryImpl implements ScopedMemory {
  constructor(
    private readonly store: MemoryStore,
    private readonly namespace: string,
    private readonly instrumentation?: EngineInstrumentation,
    private readonly parentContext?: Context,
  ) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const spanResult = this.instrumentation?.startMemorySpan(
      this.parentContext!, 'get', this.namespace, key,
    );

    try {
      const entry = await this.store.get(this.namespace, key);
      if (spanResult) this.instrumentation!.endSpanWithSuccess(spanResult.span);
      if (!entry) return null;
      return entry.value as T;
    } catch (err) {
      if (spanResult) this.instrumentation!.endSpanWithError(spanResult.span, err instanceof Error ? err : String(err));
      throw err;
    }
  }

  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    // Reject empty string keys
    if (typeof key !== 'string' || key === '') {
      throw new EngineError(
        'Memory key must be a non-empty string.',
        'INVALID_MEMORY_KEY',
      );
    }

    // Negative TTL means don't store
    if (ttl !== undefined && ttl < 0) {
      return;
    }

    // Edge case: undefined is treated as null (JSON.stringify(undefined) === undefined)
    const valueToStore = value === undefined ? null : value;

    // Validate JSON serializability via round-trip
    let serialized: unknown;
    try {
      serialized = JSON.parse(JSON.stringify(valueToStore));
    } catch {
      throw new EngineError(
        `Memory values must be JSON-serializable. Failed to serialize value for key '${key}'.`,
        'INVALID_MEMORY_VALUE',
      );
    }

    // Compute expiresAt from TTL
    // TTL of 0 means no expiry (same as omitting TTL)
    let expiresAt: Date | null = null;
    if (ttl !== undefined && ttl > 0) {
      expiresAt = new Date(Date.now() + ttl);
    }

    const entry: MemoryEntry = {
      key,
      value: serialized,
      createdAt: new Date(),
      expiresAt,
    };

    const spanResult = this.instrumentation?.startMemorySpan(
      this.parentContext!, 'set', this.namespace, key,
    );

    try {
      await this.store.set(this.namespace, key, entry);
      if (spanResult) this.instrumentation!.endSpanWithSuccess(spanResult.span);
    } catch (err) {
      if (spanResult) this.instrumentation!.endSpanWithError(spanResult.span, err instanceof Error ? err : String(err));
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const spanResult = this.instrumentation?.startMemorySpan(
      this.parentContext!, 'delete', this.namespace, key,
    );

    try {
      await this.store.delete(this.namespace, key);
      if (spanResult) this.instrumentation!.endSpanWithSuccess(spanResult.span);
    } catch (err) {
      if (spanResult) this.instrumentation!.endSpanWithError(spanResult.span, err instanceof Error ? err : String(err));
      throw err;
    }
  }

  async list(): Promise<string[]> {
    const spanResult = this.instrumentation?.startMemorySpan(
      this.parentContext!, 'list', this.namespace,
    );

    try {
      const result = await this.store.list(this.namespace);
      if (spanResult) this.instrumentation!.endSpanWithSuccess(spanResult.span);
      return result;
    } catch (err) {
      if (spanResult) this.instrumentation!.endSpanWithError(spanResult.span, err instanceof Error ? err : String(err));
      throw err;
    }
  }
}
