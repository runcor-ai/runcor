// Unit tests for tenant resolver
// Per spec US5, FR-009, FR-010

import { describe, it, expect } from 'vitest';
import { resolveTenantId, lookupTenantConfig } from '../../../src/policy/tenant-resolver.js';
import type { TenantConfig } from '../../../src/types.js';

describe('resolveTenantId', () => {
  it('should return explicit tenantId when provided', () => {
    const result = resolveTenantId('tenant-A', 'user-1');
    expect(result).toBe('tenant-A');
  });

  it('should fallback to userId when no tenantId', () => {
    const result = resolveTenantId(undefined, 'user-1');
    expect(result).toBe('user-1');
  });

  it('should return null when no tenantId or userId', () => {
    const result = resolveTenantId(undefined, undefined);
    expect(result).toBeNull();
  });
});

describe('lookupTenantConfig', () => {
  const tenants = new Map<string, TenantConfig>();
  tenants.set('tenant-A', {
    tenantId: 'tenant-A',
    rateLimits: null,
    allowedFlows: ['flow-a', 'flow-b'],
    guardrailOverrides: null,
    accessPolicies: null,
  });

  it('should return config for known tenantId', () => {
    const result = lookupTenantConfig(tenants, 'tenant-A');
    expect(result).toBeDefined();
    expect(result!.tenantId).toBe('tenant-A');
    expect(result!.allowedFlows).toEqual(['flow-a', 'flow-b']);
  });

  it('should return undefined for unknown tenantId', () => {
    const result = lookupTenantConfig(tenants, 'tenant-unknown');
    expect(result).toBeUndefined();
  });

  it('should return undefined when tenantId is null', () => {
    const result = lookupTenantConfig(tenants, null);
    expect(result).toBeUndefined();
  });
});
