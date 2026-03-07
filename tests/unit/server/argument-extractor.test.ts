// Unit tests for extractIdentity pure function
// Tests identity field extraction from MCP tool call arguments [FR-011]

import { describe, it, expect } from 'vitest';
import { extractIdentity } from '../../../src/server/mcp-server-adapter.js';

describe('extractIdentity', () => {
  it('should extract _userId, _tenantId, _metadata and return identity + flowInput', () => {
    const result = extractIdentity({
      text: 'hello',
      _userId: 'user-123',
      _tenantId: 'tenant-456',
      _metadata: { source: 'test' },
    });

    expect(result.identity).toEqual({
      userId: 'user-123',
      tenantId: 'tenant-456',
      metadata: { source: 'test' },
    });
    expect(result.flowInput).toEqual({ text: 'hello' });
  });

  it('should strip identity fields from flow input', () => {
    const result = extractIdentity({
      text: 'hello',
      _userId: 'user-123',
      count: 5,
    });

    expect(result.flowInput).toEqual({ text: 'hello', count: 5 });
    expect(result.flowInput).not.toHaveProperty('_userId');
  });

  it('should return empty identity when no identity fields present', () => {
    const result = extractIdentity({ text: 'hello', count: 5 });

    expect(result.identity).toEqual({});
    expect(result.flowInput).toEqual({ text: 'hello', count: 5 });
  });

  it('should return error for _userId with non-string type', () => {
    expect(() => extractIdentity({ _userId: 123 })).toThrow('_userId must be a string');
  });

  it('should return error for _tenantId with non-string type', () => {
    expect(() => extractIdentity({ _tenantId: true })).toThrow('_tenantId must be a string');
  });

  it('should return error for _metadata with non-object type', () => {
    expect(() => extractIdentity({ _metadata: 'not-an-object' })).toThrow('_metadata must be an object');
  });

  it('should return error for _metadata with array type', () => {
    expect(() => extractIdentity({ _metadata: [1, 2, 3] })).toThrow('_metadata must be an object');
  });

  it('should handle empty/undefined args returning empty identity and undefined input', () => {
    const result1 = extractIdentity(undefined);
    expect(result1.identity).toEqual({});
    expect(result1.flowInput).toBeUndefined();

    const result2 = extractIdentity({});
    expect(result2.identity).toEqual({});
    expect(result2.flowInput).toBeUndefined();

    const result3 = extractIdentity(null);
    expect(result3.identity).toEqual({});
    expect(result3.flowInput).toBeUndefined();
  });

  it('should handle _userId only', () => {
    const result = extractIdentity({ _userId: 'user-1', text: 'hi' });
    expect(result.identity).toEqual({ userId: 'user-1' });
    expect(result.flowInput).toEqual({ text: 'hi' });
  });

  it('should handle _metadata only', () => {
    const result = extractIdentity({ _metadata: { key: 'value' }, text: 'hi' });
    expect(result.identity).toEqual({ metadata: { key: 'value' } });
    expect(result.flowInput).toEqual({ text: 'hi' });
  });
});
