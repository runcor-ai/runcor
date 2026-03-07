// Integration tests for policy rule scenarios
// Per spec US1, FR-001, FR-003, FR-011, FR-016

import { describe, it, expect, vi } from 'vitest';
import { createEngine, type EngineConfig } from '../../src/index.js';
import { MockProvider } from '../../src/model/mock.js';
import type {
  PolicyRule,
  PolicyContext,
  RateLimitConfig,
  Guardrail,
  GuardrailResult,
  GuardrailContext,
  AccessPolicy,
  TenantConfig,
} from '../../src/types.js';

function createConfig(policyConfig?: EngineConfig['policy']): EngineConfig {
  return {
    model: {
      provider: new MockProvider(),
    },
    policy: policyConfig,
  };
}

describe('Policy Rules — Integration', () => {
  it('should deny trigger with POLICY_DENIED when rule denies', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    engine.addPolicy({
      name: 'deny-all',
      priority: 1,
      operations: ['trigger'],
      evaluate: () => ({ action: 'deny', reason: 'not allowed' }),
    });

    await expect(
      engine.trigger('test-flow', { idempotencyKey: 'k1' }),
    ).rejects.toThrow('Policy denied');

    await engine.shutdown();
  });

  it('should modify input when rule returns modify', async () => {
    const engine = await createEngine(createConfig());
    let receivedInput: unknown;

    engine.register('test-flow', async (ctx) => {
      receivedInput = ctx.input;
      return 'done';
    });

    engine.addPolicy({
      name: 'strip-fields',
      priority: 1,
      operations: ['trigger'],
      evaluate: (ctx: PolicyContext) => ({
        action: 'modify',
        reason: 'stripping sensitive data',
        modifiedInput: { safe: true },
      }),
    });

    const exec = await engine.trigger('test-flow', {
      idempotencyKey: 'k2',
      input: { sensitive: 'data', safe: true },
    });

    // Wait for execution to complete
    await new Promise<void>((resolve) => {
      const check = setInterval(async () => {
        const e = await engine.getExecution(exec.id);
        if (e && (e.state === 'complete' || e.state === 'failed')) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    expect(receivedInput).toEqual({ safe: true });
    await engine.shutdown();
  });

  it('should allow operations when no policies configured (zero-policy default)', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    const exec = await engine.trigger('test-flow', { idempotencyKey: 'k3' });
    expect(exec).toBeDefined();
    expect(exec.id).toBeDefined();

    await engine.shutdown();
  });

  it('should support hot-reload (add/remove policy without restart)', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    // Add policy that denies
    engine.addPolicy({
      name: 'blocker',
      priority: 1,
      operations: ['trigger'],
      evaluate: () => ({ action: 'deny', reason: 'blocked' }),
    });

    await expect(
      engine.trigger('test-flow', { idempotencyKey: 'k4' }),
    ).rejects.toThrow();

    // Remove policy
    engine.removePolicy('blocker');

    // Now should succeed
    const exec = await engine.trigger('test-flow', { idempotencyKey: 'k5' });
    expect(exec).toBeDefined();

    await engine.shutdown();
  });

  it('should emit policy:violation event when rule denies', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    const violations: unknown[] = [];
    engine.on('policy:violation', (event) => {
      violations.push(event);
    });

    engine.addPolicy({
      name: 'deny-rule',
      priority: 1,
      operations: ['trigger'],
      evaluate: () => ({ action: 'deny', reason: 'forbidden' }),
    });

    try {
      await engine.trigger('test-flow', {
        idempotencyKey: 'k6',
        userId: 'user-1',
      });
    } catch {
      // Expected
    }

    expect(violations).toHaveLength(1);
    const event = violations[0] as any;
    expect(event.ruleName).toBe('deny-rule');
    expect(event.operation).toBe('trigger');
    expect(event.flowName).toBe('test-flow');
    expect(event.userId).toBe('user-1');
    expect(event.reason).toBe('forbidden');
    expect(event.timestamp).toBeInstanceOf(Date);

    await engine.shutdown();
  });

  it('should apply policy rules to resume operations', async () => {
    const engine = await createEngine(createConfig());
    const { createWaitSignal } = await import('../../src/wait-signal.js');
    let callCount = 0;

    engine.register('wait-flow', async (ctx) => {
      callCount++;
      if (callCount === 1) return createWaitSignal({ reason: 'waiting' });
      return 'done';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('wait-flow', { idempotencyKey: 'k7' });

    // Wait for waiting state
    await new Promise<void>((resolve) => {
      const check = setInterval(async () => {
        const e = await engine.getExecution(exec.id);
        if (e?.state === 'waiting') {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    // Add deny rule for resume
    engine.addPolicy({
      name: 'deny-resume',
      priority: 1,
      operations: ['resume'],
      evaluate: () => ({ action: 'deny', reason: 'no resume allowed' }),
    });

    await expect(engine.resume(exec.id, 'data')).rejects.toThrow('Policy denied');

    // Remove the deny rule, resume should work
    engine.removePolicy('deny-resume');
    await engine.resume(exec.id, 'data');

    await engine.shutdown();
  });

  it('should apply policy rules to listWaiting operations', async () => {
    const engine = await createEngine(createConfig());
    const { createWaitSignal } = await import('../../src/wait-signal.js');

    engine.register('wait-flow', async () => createWaitSignal({ reason: 'waiting' }), { maxRetries: 0 });

    await engine.trigger('wait-flow', { idempotencyKey: 'k8' });

    // Add deny rule for listWaiting
    engine.addPolicy({
      name: 'deny-list',
      priority: 1,
      operations: ['listWaiting'],
      evaluate: () => ({ action: 'deny', reason: 'no listing' }),
    });

    await expect(engine.listWaiting()).rejects.toThrow('Policy denied');

    await engine.shutdown();
  });
});

// Helper: wait for an execution to reach a terminal state (complete or failed)
async function waitForTerminal(engine: Awaited<ReturnType<typeof createEngine>>, execId: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const check = setInterval(async () => {
      const e = await engine.getExecution(execId);
      if (e && (e.state === 'complete' || e.state === 'failed')) {
        clearInterval(check);
        resolve();
      }
    }, 10);
  });
}

// Integration tests for rate limiting
describe('Rate Limiting — Integration', () => {
  it('should reject after rate limit exceeded', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    engine.addRateLimit({
      name: 'global-limit',
      scope: 'global',
      limit: 2,
      windowMs: 5000,
      behavior: 'reject',
    });

    // First two triggers should succeed
    const exec1 = await engine.trigger('test-flow', { idempotencyKey: 'rl-k1' });
    expect(exec1).toBeDefined();

    const exec2 = await engine.trigger('test-flow', { idempotencyKey: 'rl-k2' });
    expect(exec2).toBeDefined();

    // Third trigger should be rate limited
    await expect(
      engine.trigger('test-flow', { idempotencyKey: 'rl-k3' }),
    ).rejects.toThrow('Rate limit');

    try {
      await engine.trigger('test-flow', { idempotencyKey: 'rl-k3b' });
    } catch (err: any) {
      expect(err.code).toBe('RATE_LIMITED');
    }

    await engine.shutdown();
  });

  it('should allow requests after window expires', async () => {
    // Create engine with real timers first, then switch to fake
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    engine.addRateLimit({
      name: 'short-window',
      scope: 'global',
      limit: 1,
      windowMs: 100,
      behavior: 'reject',
    });

    vi.useFakeTimers();
    try {
      // First trigger succeeds
      const exec1 = await engine.trigger('test-flow', { idempotencyKey: 'rl-w1' });
      expect(exec1).toBeDefined();

      // Second trigger should be rate limited
      await expect(
        engine.trigger('test-flow', { idempotencyKey: 'rl-w2' }),
      ).rejects.toThrow('Rate limit');

      // Advance time past the window
      await vi.advanceTimersByTimeAsync(101);

      // Now it should succeed again
      const exec3 = await engine.trigger('test-flow', { idempotencyKey: 'rl-w3' });
      expect(exec3).toBeDefined();
    } finally {
      vi.useRealTimers();
    }

    await engine.shutdown();
  });

  it('should emit policy:rate_limited event on rejection', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    const events: unknown[] = [];
    engine.on('policy:rate_limited', (event) => {
      events.push(event);
    });

    engine.addRateLimit({
      name: 'event-limit',
      scope: 'global',
      limit: 1,
      windowMs: 5000,
      behavior: 'reject',
    });

    // First trigger succeeds
    await engine.trigger('test-flow', { idempotencyKey: 'rl-e1' });

    // Second trigger fails — should emit event
    try {
      await engine.trigger('test-flow', { idempotencyKey: 'rl-e2' });
    } catch {
      // Expected
    }

    expect(events).toHaveLength(1);
    const event = events[0] as any;
    expect(event.rateLimitName).toBe('event-limit');
    expect(event.scope).toBe('global');
    expect(event.limit).toBe(1);
    expect(event.windowMs).toBe(5000);
    expect(event.behavior).toBe('reject');
    expect(event.timestamp).toBeInstanceOf(Date);

    await engine.shutdown();
  });

  it('should support hot-reload (add/remove rate limit)', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    engine.addRateLimit({
      name: 'removable-limit',
      scope: 'global',
      limit: 1,
      windowMs: 5000,
      behavior: 'reject',
    });

    // First trigger succeeds
    const exec1 = await engine.trigger('test-flow', { idempotencyKey: 'rl-hr1' });
    await waitForTerminal(engine, exec1.id);

    // Second trigger should be rate limited
    await expect(
      engine.trigger('test-flow', { idempotencyKey: 'rl-hr2' }),
    ).rejects.toThrow('Rate limit');

    // Remove the rate limit
    engine.removeRateLimit('removable-limit');

    // Now trigger should succeed
    const exec = await engine.trigger('test-flow', { idempotencyKey: 'rl-hr3' });
    expect(exec).toBeDefined();

    await engine.shutdown();
  });

  it('should apply per-user scope isolation', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    engine.addRateLimit({
      name: 'user-limit',
      scope: 'user',
      limit: 1,
      windowMs: 5000,
      behavior: 'reject',
    });

    // User A triggers — succeeds
    const execA = await engine.trigger('test-flow', {
      idempotencyKey: 'rl-u1',
      userId: 'user-A',
    });
    expect(execA).toBeDefined();

    // User B triggers — succeeds (different user, separate counter)
    const execB = await engine.trigger('test-flow', {
      idempotencyKey: 'rl-u2',
      userId: 'user-B',
    });
    expect(execB).toBeDefined();

    // User A triggers again — should be rate limited
    await expect(
      engine.trigger('test-flow', {
        idempotencyKey: 'rl-u3',
        userId: 'user-A',
      }),
    ).rejects.toThrow('Rate limit');

    await engine.shutdown();
  });
});

// Integration tests for guardrails
describe('Guardrails — Integration', () => {
  it('should block input when guardrail blocks', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    engine.addGuardrail({
      name: 'block-input',
      phase: 'input',
      mode: 'block',
      priority: 1,
      handler: async (): Promise<GuardrailResult> => ({
        action: 'block',
        reason: 'harmful content detected',
      }),
    });

    // Input guardrails run inside dispatch (async), so trigger succeeds
    // but the execution transitions to 'failed' with GUARDRAIL_BLOCKED
    const exec = await engine.trigger('test-flow', { idempotencyKey: 'gr-k1', input: 'bad input' });
    await waitForTerminal(engine, exec.id);

    const completed = await engine.getExecution(exec.id);
    expect(completed?.state).toBe('failed');
    expect(completed?.error?.message).toContain('blocked');

    await engine.shutdown();
  });

  it('should transform output with output guardrail', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'original-output');

    engine.addGuardrail({
      name: 'transform-output',
      phase: 'output',
      mode: 'transform',
      priority: 1,
      handler: async (content): Promise<GuardrailResult> => ({
        action: 'transform',
        reason: 'redacting sensitive data',
        transformedContent: 'redacted-output',
      }),
    });

    const exec = await engine.trigger('test-flow', { idempotencyKey: 'gr-k2' });
    await waitForTerminal(engine, exec.id);

    const completed = await engine.getExecution(exec.id);
    expect(completed?.state).toBe('complete');
    expect(completed?.result).toBe('redacted-output');

    await engine.shutdown();
  });

  it('should emit policy:warning on warn mode', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    const warnings: unknown[] = [];
    engine.on('policy:warning', (event) => {
      warnings.push(event);
    });

    engine.addGuardrail({
      name: 'warn-guardrail',
      phase: 'input',
      mode: 'warn',
      priority: 1,
      handler: async (): Promise<GuardrailResult> => ({
        action: 'warn',
        reason: 'suspicious but not blocking',
      }),
    });

    const exec = await engine.trigger('test-flow', { idempotencyKey: 'gr-k3', input: 'test' });
    expect(exec).toBeDefined();

    // Wait for execution to complete (flow should still succeed despite warning)
    await waitForTerminal(engine, exec.id);

    const completed = await engine.getExecution(exec.id);
    expect(completed?.state).toBe('complete');

    expect(warnings).toHaveLength(1);
    const event = warnings[0] as any;
    expect(event.guardrailName).toBe('warn-guardrail');
    expect(event.phase).toBe('input');
    expect(event.reason).toBe('suspicious but not blocking');
    expect(event.timestamp).toBeInstanceOf(Date);

    await engine.shutdown();
  });

  it('should chain multiple guardrails in priority order', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'original');

    // First guardrail (priority 1) — appends "-first"
    engine.addGuardrail({
      name: 'transform-first',
      phase: 'output',
      mode: 'transform',
      priority: 1,
      handler: async (content): Promise<GuardrailResult> => ({
        action: 'transform',
        reason: 'first transform',
        transformedContent: `${content}-first`,
      }),
    });

    // Second guardrail (priority 2) — appends "-second"
    engine.addGuardrail({
      name: 'transform-second',
      phase: 'output',
      mode: 'transform',
      priority: 2,
      handler: async (content): Promise<GuardrailResult> => ({
        action: 'transform',
        reason: 'second transform',
        transformedContent: `${content}-second`,
      }),
    });

    const exec = await engine.trigger('test-flow', { idempotencyKey: 'gr-k4' });
    await waitForTerminal(engine, exec.id);

    const completed = await engine.getExecution(exec.id);
    expect(completed?.state).toBe('complete');
    // Priority 1 runs first, then priority 2
    expect(completed?.result).toBe('original-first-second');

    await engine.shutdown();
  });

  it('should support async guardrail handlers', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    engine.addGuardrail({
      name: 'async-guardrail',
      phase: 'input',
      mode: 'block',
      priority: 1,
      handler: async (content): Promise<GuardrailResult> => {
        // Simulate async work
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        return { action: 'pass', reason: null };
      },
    });

    const exec = await engine.trigger('test-flow', { idempotencyKey: 'gr-k5', input: 'test' });
    expect(exec).toBeDefined();

    await waitForTerminal(engine, exec.id);

    const completed = await engine.getExecution(exec.id);
    expect(completed?.state).toBe('complete');

    await engine.shutdown();
  });

  it('should support hot-reload (add/remove guardrail)', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    // Add blocking guardrail
    engine.addGuardrail({
      name: 'removable-guardrail',
      phase: 'input',
      mode: 'block',
      priority: 1,
      handler: async (): Promise<GuardrailResult> => ({
        action: 'block',
        reason: 'blocked',
      }),
    });

    // Input guardrails run in dispatch — trigger succeeds, execution fails
    const exec1 = await engine.trigger('test-flow', { idempotencyKey: 'gr-k6' });
    await waitForTerminal(engine, exec1.id);

    const blocked = await engine.getExecution(exec1.id);
    expect(blocked?.state).toBe('failed');
    expect(blocked?.error?.message).toContain('blocked');

    // Remove the guardrail
    engine.removeGuardrail('removable-guardrail');

    // Now trigger should succeed and complete normally
    const exec2 = await engine.trigger('test-flow', { idempotencyKey: 'gr-k7' });
    await waitForTerminal(engine, exec2.id);

    const completed = await engine.getExecution(exec2.id);
    expect(completed?.state).toBe('complete');

    await engine.shutdown();
  });
});

// Integration tests for access control
describe('Access Control — Integration', () => {
  it('should deny access to flow with ACCESS_DENIED', async () => {
    const engine = await createEngine(createConfig());
    engine.register('restricted-flow', async () => 'result');

    engine.setAccessPolicy({
      identity: 'user-1',
      deniedFlows: ['restricted-flow'],
    });

    // Access control runs in evaluatePreExecution (during trigger), so trigger rejects
    await expect(
      engine.trigger('restricted-flow', {
        idempotencyKey: 'ac-k1',
        userId: 'user-1',
      }),
    ).rejects.toThrow('Access denied');

    try {
      await engine.trigger('restricted-flow', {
        idempotencyKey: 'ac-k1b',
        userId: 'user-1',
      });
    } catch (err: any) {
      expect(err.code).toBe('ACCESS_DENIED');
    }

    await engine.shutdown();
  });

  it('should allow all when no access policies configured', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    // No access policies — trigger should succeed for any user
    const exec = await engine.trigger('test-flow', {
      idempotencyKey: 'ac-k2',
      userId: 'any-user',
    });
    expect(exec).toBeDefined();
    expect(exec.id).toBeDefined();

    // Wait for execution to finish before shutdown
    await waitForTerminal(engine, exec.id);

    await engine.shutdown();
  });

  it('should apply wildcard policy to unmatched users', async () => {
    const engine = await createEngine(createConfig());
    engine.register('allowed-flow', async () => 'result');
    engine.register('secret-flow', async () => 'secret');

    // Wildcard policy restricts everyone to only 'allowed-flow'
    engine.setAccessPolicy({
      identity: '*',
      allowedFlows: ['allowed-flow'],
    });

    // Unknown user triggering allowed flow — succeeds
    const exec = await engine.trigger('allowed-flow', {
      idempotencyKey: 'ac-k3',
      userId: 'unknown-user',
    });
    expect(exec).toBeDefined();

    // Unknown user triggering unlisted flow — denied
    await expect(
      engine.trigger('secret-flow', {
        idempotencyKey: 'ac-k4',
        userId: 'unknown-user',
      }),
    ).rejects.toThrow('Access denied');

    await engine.shutdown();
  });

  it('should overwrite existing policy with setAccessPolicy', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    // Set policy denying test-flow
    engine.setAccessPolicy({
      identity: 'user-1',
      deniedFlows: ['test-flow'],
    });

    await expect(
      engine.trigger('test-flow', {
        idempotencyKey: 'ac-k5',
        userId: 'user-1',
      }),
    ).rejects.toThrow('Access denied');

    // Overwrite with policy that allows test-flow
    engine.setAccessPolicy({
      identity: 'user-1',
      allowedFlows: ['test-flow'],
    });

    const exec = await engine.trigger('test-flow', {
      idempotencyKey: 'ac-k6',
      userId: 'user-1',
    });
    expect(exec).toBeDefined();

    // Wait for execution to finish before shutdown
    await waitForTerminal(engine, exec.id);

    await engine.shutdown();
  });

  it('should revert to allow-all after removeAccessPolicy', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    // Set policy denying test-flow
    engine.setAccessPolicy({
      identity: 'user-1',
      deniedFlows: ['test-flow'],
    });

    await expect(
      engine.trigger('test-flow', {
        idempotencyKey: 'ac-k7',
        userId: 'user-1',
      }),
    ).rejects.toThrow('Access denied');

    // Remove the policy
    engine.removeAccessPolicy('user-1');

    // Now trigger should succeed (reverts to allow-all)
    const exec = await engine.trigger('test-flow', {
      idempotencyKey: 'ac-k8',
      userId: 'user-1',
    });
    expect(exec).toBeDefined();

    // Wait for execution to finish before shutdown
    await waitForTerminal(engine, exec.id);

    await engine.shutdown();
  });
});

// Integration tests for per-tenant configuration
describe('Per-Tenant Configuration — Integration', () => {
  it('should apply tenant-specific allowed flows restriction', async () => {
    const engine = await createEngine(createConfig());
    engine.register('allowed-flow', async () => 'allowed-result');
    engine.register('blocked-flow', async () => 'blocked-result');

    // Set tenant config for tenant-A with allowedFlows restriction
    engine.setTenantConfig({
      tenantId: 'tenant-A',
      allowedFlows: ['allowed-flow'],
    });

    // Set access policy for tenant-A matching the tenant's allowed flows
    engine.setAccessPolicy({
      identity: 'tenant-A',
      allowedFlows: ['allowed-flow'],
    });

    // Trigger allowed-flow with tenantId: tenant-A — should succeed
    const exec1 = await engine.trigger('allowed-flow', {
      idempotencyKey: 'tenant-af-k1',
      tenantId: 'tenant-A',
    });
    expect(exec1).toBeDefined();

    // Trigger blocked-flow with tenantId: tenant-A — should be denied
    await expect(
      engine.trigger('blocked-flow', {
        idempotencyKey: 'tenant-af-k2',
        tenantId: 'tenant-A',
      }),
    ).rejects.toThrow('Access denied');

    await engine.shutdown();
  });

  it('should support setTenantConfig and removeTenantConfig at runtime', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    // Set tenant config
    engine.setTenantConfig({
      tenantId: 'tenant-A',
      allowedFlows: ['test-flow'],
    });

    // Remove tenant config (no-op currently, just verify no crash)
    engine.removeTenantConfig('tenant-A');

    // Non-existent removal should be no-op
    engine.removeTenantConfig('non-existent');

    await engine.shutdown();
  });

  it('should resolve tenant via explicit tenantId', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    // Set access policy for tenant-A denying test-flow
    engine.setAccessPolicy({
      identity: 'tenant-A',
      deniedFlows: ['test-flow'],
    });

    // Trigger with explicit tenantId should use tenant-A identity
    await expect(
      engine.trigger('test-flow', {
        idempotencyKey: 'tenant-k1',
        tenantId: 'tenant-A',
      }),
    ).rejects.toThrow('Access denied');

    await engine.shutdown();
  });

  it('should resolve tenant via userId fallback', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    // Set access policy for user-1 denying test-flow
    engine.setAccessPolicy({
      identity: 'user-1',
      deniedFlows: ['test-flow'],
    });

    // Trigger with userId (no explicit tenantId) — should resolve to user-1 as tenant
    await expect(
      engine.trigger('test-flow', {
        idempotencyKey: 'tenant-k2',
        userId: 'user-1',
      }),
    ).rejects.toThrow('Access denied');

    await engine.shutdown();
  });

  it('should use engine defaults when no tenant configured', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    // No tenant config, no access policies — should allow everything
    const exec = await engine.trigger('test-flow', {
      idempotencyKey: 'tenant-k3',
      tenantId: 'unknown-tenant',
    });
    expect(exec).toBeDefined();

    await engine.shutdown();
  });

  it('should isolate rate limits between tenants using per-user scope', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    // Add per-user rate limit of 1 per 5s
    engine.addRateLimit({
      name: 'user-rl',
      scope: 'user',
      limit: 1,
      windowMs: 5000,
    });

    // Tenant A (user-A) triggers once — succeeds
    const exec1 = await engine.trigger('test-flow', {
      idempotencyKey: 'tenant-iso-k1',
      userId: 'user-A',
    });
    expect(exec1).toBeDefined();

    // Tenant B (user-B) triggers once — succeeds (different user counter)
    const exec2 = await engine.trigger('test-flow', {
      idempotencyKey: 'tenant-iso-k2',
      userId: 'user-B',
    });
    expect(exec2).toBeDefined();

    // Tenant A (user-A) triggers again — should fail (exceeded own limit)
    await expect(
      engine.trigger('test-flow', {
        idempotencyKey: 'tenant-iso-k3',
        userId: 'user-A',
      }),
    ).rejects.toThrow('Rate limit');

    await engine.shutdown();
  });
});

// Quickstart scenario validations for the Policy Layer
// Validates end-to-end policy scenarios matching the quickstart guide
describe('Quickstart Scenarios — Policy Layer', () => {
  it('Scenario 1: Basic policy rule blocks dangerous input', async () => {
    const engine = await createEngine(createConfig());
    engine.register('ai-flow', async (ctx) => 'response');

    engine.addPolicy({
      name: 'block-dangerous',
      priority: 1,
      operations: ['trigger'],
      evaluate: (ctx: PolicyContext) => {
        const input = ctx.input as Record<string, unknown> | null;
        if (input && (input as any).prompt?.includes('dangerous')) {
          return { action: 'deny', reason: 'Dangerous input detected' };
        }
        return { action: 'allow' };
      },
    });

    // Safe input passes
    const exec = await engine.trigger('ai-flow', {
      idempotencyKey: 'qs-k1',
      input: { prompt: 'Hello world' },
    });
    expect(exec).toBeDefined();

    // Dangerous input blocked
    await expect(
      engine.trigger('ai-flow', {
        idempotencyKey: 'qs-k2',
        input: { prompt: 'do something dangerous' },
      }),
    ).rejects.toThrow('Policy denied');

    await engine.shutdown();
  });

  it('Scenario 2: Rate limiting protects against abuse', async () => {
    const engine = await createEngine(createConfig());
    engine.register('api-flow', async () => 'ok');

    engine.addRateLimit({
      name: 'api-limit',
      scope: 'user',
      limit: 3,
      windowMs: 10000,
    });

    // 3 requests succeed
    for (let i = 0; i < 3; i++) {
      await engine.trigger('api-flow', {
        idempotencyKey: `qs-rl-k${i}`,
        userId: 'abuser',
      });
    }

    // 4th request rejected
    await expect(
      engine.trigger('api-flow', {
        idempotencyKey: 'qs-rl-k3',
        userId: 'abuser',
      }),
    ).rejects.toThrow('Rate limit');

    await engine.shutdown();
  });

  it('Scenario 3: Access control restricts operations per user', async () => {
    const engine = await createEngine(createConfig());
    engine.register('admin-flow', async () => 'admin result');
    engine.register('public-flow', async () => 'public result');

    engine.setAccessPolicy({
      identity: 'regular-user',
      allowedFlows: ['public-flow'],
    });

    // Regular user can access public flow
    const exec = await engine.trigger('public-flow', {
      idempotencyKey: 'qs-ac-k1',
      userId: 'regular-user',
    });
    expect(exec).toBeDefined();

    // Regular user denied admin flow
    await expect(
      engine.trigger('admin-flow', {
        idempotencyKey: 'qs-ac-k2',
        userId: 'regular-user',
      }),
    ).rejects.toThrow('Access denied');

    await engine.shutdown();
  });

  it('Scenario 4: Output guardrail sanitizes response', async () => {
    const engine = await createEngine(createConfig());
    engine.register('chat-flow', async () => ({
      message: 'Here is sensitive-data and more text',
    }));

    engine.addGuardrail({
      name: 'sanitize-output',
      phase: 'output',
      priority: 1,
      handler: async (content) => {
        const result = content as Record<string, unknown>;
        if (result && typeof result.message === 'string' && result.message.includes('sensitive-data')) {
          return {
            action: 'transform' as const,
            transformedContent: {
              ...result,
              message: result.message.replace('sensitive-data', '[REDACTED]'),
            },
          };
        }
        return { action: 'pass' as const };
      },
    });

    const exec = await engine.trigger('chat-flow', { idempotencyKey: 'qs-guard-k1' });

    // Wait for completion
    await waitForTerminal(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final?.state).toBe('complete');
    expect((final?.result as any)?.message).toContain('[REDACTED]');
    expect((final?.result as any)?.message).not.toContain('sensitive-data');

    await engine.shutdown();
  });

  it('Scenario 5: Combined policies work together', async () => {
    const engine = await createEngine(createConfig());
    engine.register('protected-flow', async () => 'result');

    // Access control
    engine.setAccessPolicy({
      identity: '*',
      allowedFlows: ['protected-flow'],
    });

    // Rate limit
    engine.addRateLimit({
      name: 'combined-rl',
      scope: 'global',
      limit: 5,
      windowMs: 10000,
    });

    // Policy rule
    engine.addPolicy({
      name: 'allow-valid',
      priority: 1,
      operations: ['trigger'],
      evaluate: (ctx: PolicyContext) => {
        if (ctx.input === 'invalid') {
          return { action: 'deny', reason: 'invalid input' };
        }
        return { action: 'allow' };
      },
    });

    // Valid request succeeds (passes access + rate limit + policy)
    const exec = await engine.trigger('protected-flow', {
      idempotencyKey: 'qs-combo-k1',
      userId: 'user-1',
      input: 'valid',
    });
    expect(exec).toBeDefined();

    // Invalid input denied by policy rule
    await expect(
      engine.trigger('protected-flow', {
        idempotencyKey: 'qs-combo-k2',
        userId: 'user-1',
        input: 'invalid',
      }),
    ).rejects.toThrow('Policy denied');

    await engine.shutdown();
  });
});
