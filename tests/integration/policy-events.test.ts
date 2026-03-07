// Integration tests for policy event emission
// Per spec US6, FR-001, FR-016, FR-025, FR-026

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
} from '../../src/types.js';

function createConfig(policyConfig?: EngineConfig['policy']): EngineConfig {
  return {
    model: { provider: new MockProvider() },
    policy: policyConfig,
  };
}

// Helper: wait for an execution to reach a terminal state (complete or failed)
async function waitForTerminal(
  engine: Awaited<ReturnType<typeof createEngine>>,
  execId: string,
): Promise<void> {
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

describe('Policy Events — Integration', () => {
  it('should emit policy:violation on rule denial with correct payload', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    const events: any[] = [];
    engine.on('policy:violation', (event) => events.push(event));

    engine.addPolicy({
      name: 'deny-rule',
      priority: 1,
      operations: ['trigger'],
      evaluate: () => ({ action: 'deny', reason: 'test-reason' }),
    });

    try {
      await engine.trigger('test-flow', {
        idempotencyKey: 'ev-k1',
        userId: 'user-1',
        tenantId: 'tenant-1',
      });
    } catch {}

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ruleName: 'deny-rule',
      operation: 'trigger',
      flowName: 'test-flow',
      userId: 'user-1',
      tenantId: 'tenant-1',
      reason: 'test-reason',
    });
    expect(events[0].timestamp).toBeInstanceOf(Date);

    await engine.shutdown();
  });

  it('should emit policy:warning on warn-mode guardrail with correct payload', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    const warnings: any[] = [];
    engine.on('policy:warning', (event) => warnings.push(event));

    engine.addGuardrail({
      name: 'warn-guard',
      phase: 'input',
      mode: 'warn',
      priority: 1,
      handler: async (): Promise<GuardrailResult> => ({
        action: 'warn' as const,
        reason: 'watch-out',
      }),
    });

    const exec = await engine.trigger('test-flow', {
      idempotencyKey: 'ev-k2',
      userId: 'user-2',
    });

    // Wait for execution to complete (guardrails run in dispatch)
    await waitForTerminal(engine, exec.id);

    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const w = warnings[0];
    expect(w).toMatchObject({
      guardrailName: 'warn-guard',
      phase: 'input',
      flowName: 'test-flow',
      reason: 'watch-out',
    });
    expect(w.timestamp).toBeInstanceOf(Date);

    await engine.shutdown();
  });

  it('should emit policy:rate_limited on rate limit exceeded with correct payload', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    const rlEvents: any[] = [];
    engine.on('policy:rate_limited', (event) => rlEvents.push(event));

    engine.addRateLimit({
      name: 'rl-events',
      scope: 'global',
      limit: 1,
      windowMs: 5000,
    });

    // First trigger succeeds
    await engine.trigger('test-flow', { idempotencyKey: 'ev-k3' });

    // Second trigger should fail and emit event
    try {
      await engine.trigger('test-flow', { idempotencyKey: 'ev-k4' });
    } catch {}

    expect(rlEvents).toHaveLength(1);
    expect(rlEvents[0]).toMatchObject({
      rateLimitName: 'rl-events',
      scope: 'global',
      limit: 1,
      windowMs: 5000,
      behavior: 'reject',
    });
    expect(rlEvents[0].timestamp).toBeInstanceOf(Date);

    await engine.shutdown();
  });

  it('should match event listener call counts to policy decision counts (SC-003)', async () => {
    const engine = await createEngine(createConfig());
    engine.register('test-flow', async () => 'result');

    let violationCount = 0;
    engine.on('policy:violation', () => violationCount++);

    engine.addPolicy({
      name: 'deny-all',
      priority: 1,
      operations: ['trigger'],
      evaluate: () => ({ action: 'deny', reason: 'nope' }),
    });

    // Attempt 5 triggers — all should fail and emit exactly 1 violation each
    for (let i = 0; i < 5; i++) {
      try {
        await engine.trigger('test-flow', { idempotencyKey: `ev-count-k${i}` });
      } catch {}
    }

    expect(violationCount).toBe(5);

    await engine.shutdown();
  });
});
