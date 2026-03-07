// Access control — identity-based access policy evaluation
// Resolution order: user-specific > tenant-specific > wildcard ('*') > default allow-all

import type { AccessPolicy, OperationType } from '../types.js';

export interface AccessResult {
  allowed: boolean;
  reason: string | null;
}

/**
 * Evaluate access control for an identity against a flow and operation.
 *
 * Resolution order:
 * 1. User-specific policy (userId)
 * 2. Tenant-specific policy (tenantId)
 * 3. Wildcard policy ('*')
 * 4. Default: allow-all
 *
 * When no identity is provided (userId and tenantId both null),
 * defaults to allow-all (no identity = no restrictions).
 */
export function evaluateAccess(
  policies: Map<string, AccessPolicy>,
  userId: string | null,
  tenantId: string | null,
  operation: OperationType,
  flowName: string,
): AccessResult {
  // No identity — check wildcard policy before defaulting to allow-all
  if (!userId && !tenantId) {
    const wildcardPolicy = policies.get('*');
    if (!wildcardPolicy) {
      return { allowed: true, reason: null };
    }
    // Fall through to evaluate the wildcard policy
  }

  // Resolution order: user > tenant > wildcard
  let policy: AccessPolicy | undefined;

  if (userId) {
    policy = policies.get(userId);
  }
  if (!policy && tenantId) {
    policy = policies.get(tenantId);
  }
  if (!policy) {
    policy = policies.get('*');
  }

  // No matching policy = allow-all
  if (!policy) {
    return { allowed: true, reason: null };
  }

  // Check operation restrictions
  // Denied operations take precedence
  if (policy.deniedOperations && policy.deniedOperations.includes(operation)) {
    return {
      allowed: false,
      reason: `Operation "${operation}" is denied for identity "${policy.identity}"`,
    };
  }

  if (policy.allowedOperations && !policy.allowedOperations.includes(operation)) {
    return {
      allowed: false,
      reason: `Operation "${operation}" is not allowed for identity "${policy.identity}"`,
    };
  }

  // Check flow restrictions
  // Denied flows take precedence over allowed flows
  if (policy.deniedFlows && policy.deniedFlows.includes(flowName)) {
    return {
      allowed: false,
      reason: `Flow "${flowName}" is denied for identity "${policy.identity}"`,
    };
  }

  if (policy.allowedFlows && !policy.allowedFlows.includes(flowName)) {
    return {
      allowed: false,
      reason: `Flow "${flowName}" is not allowed for identity "${policy.identity}"`,
    };
  }

  return { allowed: true, reason: null };
}
