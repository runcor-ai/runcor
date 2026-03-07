// Unit tests for PolicyEngine policy rule management
// Per spec FR-001, FR-016, FR-025, FR-026

import { describe, it, expect, vi } from 'vitest';
import { PolicyEngine } from '../../../src/policy/policy-engine.js';
import { EngineInstrumentation } from '../../../src/telemetry/instrumentation.js';
import type { PolicyRule } from '../../../src/types.js';

function makeInstrumentation(): EngineInstrumentation {
  return new EngineInstrumentation({});
}

function makePolicyEngine(config?: Parameters<typeof PolicyEngine['prototype']['constructor']>[0]): PolicyEngine {
  return new PolicyEngine(config, makeInstrumentation(), () => {});
}

function makeRule(overrides?: Partial<PolicyRule>): PolicyRule {
  return {
    name: 'test-rule',
    priority: 100,
    operations: ['trigger'],
    evaluate: () => ({ action: 'allow', reason: null }),
    ...overrides,
  };
}

describe('PolicyEngine — Policy Rule Management', () => {
  it('should add a policy rule', () => {
    const engine = makePolicyEngine();
    expect(() => engine.addPolicy(makeRule({ name: 'rule-1' }))).not.toThrow();
  });

  it('should throw DUPLICATE_POLICY when adding a rule with existing name', () => {
    const engine = makePolicyEngine();
    engine.addPolicy(makeRule({ name: 'rule-1' }));
    expect(() => engine.addPolicy(makeRule({ name: 'rule-1' }))).toThrow();
    try {
      engine.addPolicy(makeRule({ name: 'rule-1' }));
    } catch (err: any) {
      expect(err.code).toBe('DUPLICATE_POLICY');
    }
  });

  it('should remove a policy rule by name', () => {
    const engine = makePolicyEngine();
    engine.addPolicy(makeRule({ name: 'rule-1' }));
    engine.removePolicy('rule-1');
    // Should be able to add again after removal
    expect(() => engine.addPolicy(makeRule({ name: 'rule-1' }))).not.toThrow();
  });

  it('should be a no-op when removing a non-existent rule', () => {
    const engine = makePolicyEngine();
    expect(() => engine.removePolicy('nonexistent')).not.toThrow();
  });

  it('should throw INVALID_CONFIG for empty operations array', () => {
    const engine = makePolicyEngine();
    expect(() =>
      engine.addPolicy(makeRule({ name: 'bad-ops', operations: [] })),
    ).toThrow();
    try {
      engine.addPolicy(makeRule({ name: 'bad-ops', operations: [] }));
    } catch (err: any) {
      expect(err.code).toBe('INVALID_POLICY_CONFIG');
    }
  });

  it('should initialize from PolicyConfig', () => {
    const rule = makeRule({ name: 'initial-rule' });
    const engine = makePolicyEngine({
      rules: [rule],
    });
    // Adding the same name should throw (it's already registered)
    expect(() => engine.addPolicy(makeRule({ name: 'initial-rule' }))).toThrow();
  });

  it('should allow update via remove then re-add', () => {
    const engine = makePolicyEngine();
    engine.addPolicy(makeRule({ name: 'rule-1', priority: 100 }));
    engine.removePolicy('rule-1');
    expect(() =>
      engine.addPolicy(makeRule({ name: 'rule-1', priority: 50 })),
    ).not.toThrow();
  });
});

// Zero-policy default and telemetry span verification
describe('PolicyEngine — Zero-Policy Default', () => {
  it('should return input immediately when no policies configured', async () => {
    const instrumentation = new EngineInstrumentation({});
    const emitEvent = vi.fn();
    const pe = new PolicyEngine(undefined, instrumentation, emitEvent);

    const result = await pe.evaluatePreExecution({
      operation: 'trigger',
      flowName: 'test-flow',
      userId: null,
      tenantId: null,
      input: { data: 'test' },
      executionId: null,
      metadata: {},
    });

    expect(result).toEqual({ data: 'test' });
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('should not create telemetry spans when no policies configured', async () => {
    const instrumentation = new EngineInstrumentation({});
    const startSpy = vi.spyOn(instrumentation, 'startPolicyEvaluateSpan');
    const emitEvent = vi.fn();
    const pe = new PolicyEngine(undefined, instrumentation, emitEvent);

    await pe.evaluatePreExecution({
      operation: 'trigger',
      flowName: 'test-flow',
      userId: null,
      tenantId: null,
      input: 'test',
      executionId: null,
      metadata: {},
    });

    expect(startSpy).not.toHaveBeenCalled();
  });

  it('should return content immediately from evaluateInputGuardrails when no guardrails', async () => {
    const instrumentation = new EngineInstrumentation({});
    const emitEvent = vi.fn();
    const pe = new PolicyEngine(undefined, instrumentation, emitEvent);

    const result = await pe.evaluateInputGuardrails('test content', {
      executionId: 'exec-1',
      flowName: 'test-flow',
      userId: null,
      tenantId: null,
      phase: 'input',
    });

    expect(result).toBe('test content');
  });

  it('should return content immediately from evaluateOutputGuardrails when no guardrails', async () => {
    const instrumentation = new EngineInstrumentation({});
    const emitEvent = vi.fn();
    const pe = new PolicyEngine(undefined, instrumentation, emitEvent);

    const result = await pe.evaluateOutputGuardrails('test content', {
      executionId: 'exec-1',
      flowName: 'test-flow',
      userId: null,
      tenantId: null,
      phase: 'output',
    });

    expect(result).toBe('test content');
  });
});
