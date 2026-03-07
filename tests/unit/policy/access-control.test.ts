// Unit tests for access control evaluator
// Per spec FR-008, FR-010

import { describe, it, expect } from 'vitest';
import { evaluateAccess } from '../../../src/policy/access-control.js';
import type { AccessPolicy, OperationType } from '../../../src/types.js';

describe('Access Control Evaluator', () => {
  it('should allow all when no policies exist', () => {
    const result = evaluateAccess(new Map(), 'user-1', null, 'trigger', 'test-flow');
    expect(result.allowed).toBe(true);
  });

  it('should apply user-specific policy', () => {
    const policies = new Map<string, AccessPolicy>();
    policies.set('user-1', {
      identity: 'user-1',
      deniedFlows: ['secret-flow'],
    });

    const result = evaluateAccess(policies, 'user-1', null, 'trigger', 'secret-flow');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('denied');
  });

  it('should apply tenant-specific policy when no user policy exists', () => {
    const policies = new Map<string, AccessPolicy>();
    policies.set('tenant-A', {
      identity: 'tenant-A',
      allowedFlows: ['allowed-flow'],
    });

    const result = evaluateAccess(policies, 'other-user', 'tenant-A', 'trigger', 'blocked-flow');
    expect(result.allowed).toBe(false);
  });

  it('should apply wildcard policy when no user or tenant policy exists', () => {
    const policies = new Map<string, AccessPolicy>();
    policies.set('*', {
      identity: '*',
      deniedFlows: ['restricted-flow'],
    });

    const result = evaluateAccess(policies, 'user-1', null, 'trigger', 'restricted-flow');
    expect(result.allowed).toBe(false);
  });

  it('should use default allow-all when no identity provided', () => {
    const policies = new Map<string, AccessPolicy>();
    policies.set('user-1', {
      identity: 'user-1',
      deniedFlows: ['flow-a'],
    });

    const result = evaluateAccess(policies, null, null, 'trigger', 'flow-a');
    expect(result.allowed).toBe(true);
  });

  it('should follow resolution order: user > tenant > wildcard', () => {
    const policies = new Map<string, AccessPolicy>();
    policies.set('user-1', {
      identity: 'user-1',
      allowedFlows: ['user-flow'],
    });
    policies.set('tenant-A', {
      identity: 'tenant-A',
      allowedFlows: ['tenant-flow'],
    });
    policies.set('*', {
      identity: '*',
      allowedFlows: ['wildcard-flow'],
    });

    // User policy should be used (user-1 can only access user-flow)
    const result = evaluateAccess(policies, 'user-1', 'tenant-A', 'trigger', 'tenant-flow');
    expect(result.allowed).toBe(false);
  });

  it('should restrict by allowedFlows', () => {
    const policies = new Map<string, AccessPolicy>();
    policies.set('user-1', {
      identity: 'user-1',
      allowedFlows: ['flow-a', 'flow-b'],
    });

    expect(evaluateAccess(policies, 'user-1', null, 'trigger', 'flow-a').allowed).toBe(true);
    expect(evaluateAccess(policies, 'user-1', null, 'trigger', 'flow-c').allowed).toBe(false);
  });

  it('should deny takes precedence over allow for same flow', () => {
    const policies = new Map<string, AccessPolicy>();
    policies.set('user-1', {
      identity: 'user-1',
      allowedFlows: ['flow-a'],
      deniedFlows: ['flow-a'],
    });

    const result = evaluateAccess(policies, 'user-1', null, 'trigger', 'flow-a');
    expect(result.allowed).toBe(false);
  });

  it('should restrict by allowedOperations', () => {
    const policies = new Map<string, AccessPolicy>();
    policies.set('user-1', {
      identity: 'user-1',
      allowedOperations: ['trigger', 'listWaiting'],
    });

    expect(evaluateAccess(policies, 'user-1', null, 'trigger', 'flow').allowed).toBe(true);
    expect(evaluateAccess(policies, 'user-1', null, 'resume', 'flow').allowed).toBe(false);
  });

  it('should restrict by deniedOperations', () => {
    const policies = new Map<string, AccessPolicy>();
    policies.set('user-1', {
      identity: 'user-1',
      deniedOperations: ['replay'],
    });

    expect(evaluateAccess(policies, 'user-1', null, 'trigger', 'flow').allowed).toBe(true);
    expect(evaluateAccess(policies, 'user-1', null, 'replay', 'flow').allowed).toBe(false);
  });

  it('should allow all flows when allowedFlows is null', () => {
    const policies = new Map<string, AccessPolicy>();
    policies.set('user-1', {
      identity: 'user-1',
      allowedFlows: null,
    });

    expect(evaluateAccess(policies, 'user-1', null, 'trigger', 'any-flow').allowed).toBe(true);
  });
});
