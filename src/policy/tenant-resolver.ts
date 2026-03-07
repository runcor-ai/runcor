// Tenant resolver — TenantConfig lookup and merge-override

import type { TenantConfig } from '../types.js';

/**
 * Resolve tenant identity from trigger options.
 *
 * Resolution order:
 * 1. Explicit tenantId from TriggerOptions
 * 2. Fallback to userId (user-as-tenant)
 * 3. null (no tenant — use engine defaults)
 */
export function resolveTenantId(
  tenantId?: string,
  userId?: string,
): string | null {
  if (tenantId) return tenantId;
  if (userId) return userId;
  return null;
}

/**
 * Look up tenant configuration from the tenants map.
 * Returns undefined when no configuration exists for the tenant.
 */
export function lookupTenantConfig(
  tenants: Map<string, TenantConfig>,
  tenantId: string | null,
): TenantConfig | undefined {
  if (!tenantId) return undefined;
  return tenants.get(tenantId);
}
