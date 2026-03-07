// Unit tests for rule evaluator
// Per spec FR-001 through FR-003, FR-018

import { describe, it, expect } from 'vitest';
import { evaluateRules } from '../../../src/policy/rule-evaluator.js';
import type { PolicyRule, PolicyContext, PolicyDecision } from '../../../src/types.js';

function makeContext(overrides?: Partial<PolicyContext>): PolicyContext {
  return {
    operation: 'trigger',
    flowName: 'test-flow',
    userId: 'user-1',
    tenantId: null,
    input: { message: 'hello' },
    executionId: null,
    metadata: {},
    ...overrides,
  };
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

describe('Rule Evaluator', () => {
  it('should return allow when no rules are provided', () => {
    const result = evaluateRules([], makeContext());
    expect(result.action).toBe('allow');
    expect(result.reason).toBeNull();
  });

  it('should evaluate rules in priority order (lower number first)', () => {
    const order: string[] = [];

    const rules: PolicyRule[] = [
      makeRule({
        name: 'low-priority',
        priority: 200,
        evaluate: () => {
          order.push('low');
          return { action: 'allow', reason: null };
        },
      }),
      makeRule({
        name: 'high-priority',
        priority: 50,
        evaluate: () => {
          order.push('high');
          return { action: 'allow', reason: null };
        },
      }),
      makeRule({
        name: 'medium-priority',
        priority: 100,
        evaluate: () => {
          order.push('medium');
          return { action: 'allow', reason: null };
        },
      }),
    ];

    evaluateRules(rules, makeContext());
    expect(order).toEqual(['high', 'medium', 'low']);
  });

  it('should short-circuit on deny (stop evaluating remaining rules)', () => {
    const order: string[] = [];

    const rules: PolicyRule[] = [
      makeRule({
        name: 'first',
        priority: 1,
        evaluate: () => {
          order.push('first');
          return { action: 'allow', reason: null };
        },
      }),
      makeRule({
        name: 'denier',
        priority: 2,
        evaluate: () => {
          order.push('denier');
          return { action: 'deny', reason: 'blocked' };
        },
      }),
      makeRule({
        name: 'never-reached',
        priority: 3,
        evaluate: () => {
          order.push('never-reached');
          return { action: 'allow', reason: null };
        },
      }),
    ];

    const result = evaluateRules(rules, makeContext());
    expect(result.action).toBe('deny');
    expect(result.reason).toBe('blocked');
    expect(order).toEqual(['first', 'denier']);
  });

  it('should return modifiedInput on modify action', () => {
    const rules: PolicyRule[] = [
      makeRule({
        name: 'modifier',
        priority: 1,
        evaluate: () => ({
          action: 'modify',
          reason: null,
          modifiedInput: { message: 'modified' },
        }),
      }),
    ];

    const result = evaluateRules(rules, makeContext());
    expect(result.action).toBe('modify');
    expect(result.modifiedInput).toEqual({ message: 'modified' });
  });

  it('should pass through on allow', () => {
    const rules: PolicyRule[] = [
      makeRule({
        name: 'allower',
        priority: 1,
        evaluate: () => ({ action: 'allow', reason: null }),
      }),
    ];

    const result = evaluateRules(rules, makeContext());
    expect(result.action).toBe('allow');
  });

  it('should treat invalid action as deny (FR-018, fail-closed)', () => {
    const rules: PolicyRule[] = [
      makeRule({
        name: 'invalid-action',
        priority: 1,
        evaluate: () => ({ action: 'invalid' as any, reason: null }),
      }),
    ];

    const result = evaluateRules(rules, makeContext());
    expect(result.action).toBe('deny');
  });

  it('should compose multiple rules — allow, modify, allow', () => {
    const rules: PolicyRule[] = [
      makeRule({
        name: 'allow-first',
        priority: 1,
        evaluate: () => ({ action: 'allow', reason: null }),
      }),
      makeRule({
        name: 'modifier',
        priority: 2,
        evaluate: () => ({
          action: 'modify',
          reason: 'stripping field',
          modifiedInput: { cleaned: true },
        }),
      }),
      makeRule({
        name: 'allow-last',
        priority: 3,
        evaluate: () => ({ action: 'allow', reason: null }),
      }),
    ];

    const result = evaluateRules(rules, makeContext());
    // The last modify wins (accumulated)
    expect(result.action).toBe('modify');
    expect(result.modifiedInput).toEqual({ cleaned: true });
  });

  it('should only evaluate rules matching the operation type', () => {
    const evaluated: string[] = [];

    const rules: PolicyRule[] = [
      makeRule({
        name: 'trigger-only',
        priority: 1,
        operations: ['trigger'],
        evaluate: () => {
          evaluated.push('trigger-only');
          return { action: 'allow', reason: null };
        },
      }),
      makeRule({
        name: 'resume-only',
        priority: 2,
        operations: ['resume'],
        evaluate: () => {
          evaluated.push('resume-only');
          return { action: 'deny', reason: 'no resume' };
        },
      }),
    ];

    const result = evaluateRules(rules, makeContext({ operation: 'trigger' }));
    expect(result.action).toBe('allow');
    expect(evaluated).toEqual(['trigger-only']);
  });

  it('should handle rules that throw as deny (fail-closed)', () => {
    const rules: PolicyRule[] = [
      makeRule({
        name: 'thrower',
        priority: 1,
        evaluate: () => {
          throw new Error('rule error');
        },
      }),
    ];

    const result = evaluateRules(rules, makeContext());
    expect(result.action).toBe('deny');
  });

  it('should pass context to rule evaluate function', () => {
    let receivedContext: PolicyContext | null = null;

    const rules: PolicyRule[] = [
      makeRule({
        name: 'context-checker',
        priority: 1,
        evaluate: (ctx) => {
          receivedContext = ctx;
          return { action: 'allow', reason: null };
        },
      }),
    ];

    const context = makeContext({
      flowName: 'my-flow',
      userId: 'u-42',
      input: { data: 'test' },
    });

    evaluateRules(rules, context);
    expect(receivedContext).not.toBeNull();
    expect(receivedContext!.flowName).toBe('my-flow');
    expect(receivedContext!.userId).toBe('u-42');
    expect(receivedContext!.input).toEqual({ data: 'test' });
  });
});

// Performance benchmark for rule evaluator
// Per spec SC-001 — rule evaluation must complete in <1ms p95
describe('Rule Evaluator — Performance (SC-001)', () => {
  it('should evaluate rules in <1ms p95 over 1000 evaluations', () => {
    // Create 10 rules with different priorities
    const rules: PolicyRule[] = Array.from({ length: 10 }, (_, i) => ({
      name: `rule-${i}`,
      priority: i,
      operations: ['trigger' as const],
      evaluate: (ctx: PolicyContext) => ({ action: 'allow' as const }),
    }));

    const context: PolicyContext = {
      operation: 'trigger',
      flowName: 'perf-flow',
      userId: 'user-1',
      tenantId: null,
      input: { data: 'test' },
      executionId: null,
      metadata: {},
    };

    const times: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const start = performance.now();
      evaluateRules(rules, context);
      times.push(performance.now() - start);
    }

    // Sort to find p95
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];

    expect(p95).toBeLessThan(1); // < 1ms at p95
  });
});
