// Unit tests for guardrail runner
// Per spec FR-004, FR-005, FR-018

import { describe, it, expect, vi } from 'vitest';
import { runGuardrails } from '../../../src/policy/guardrail-runner.js';
import { EngineError } from '../../../src/errors.js';
import type { Guardrail, GuardrailContext, GuardrailResult } from '../../../src/types.js';

function makeContext(overrides?: Partial<GuardrailContext>): GuardrailContext {
  return {
    executionId: 'exec-1',
    flowName: 'test-flow',
    userId: 'user-1',
    tenantId: null,
    phase: 'input',
    ...overrides,
  };
}

function makeGuardrail(overrides?: Partial<Guardrail>): Guardrail {
  return {
    name: 'test-guardrail',
    phase: 'input',
    mode: 'block',
    priority: 100,
    handler: async () => ({ action: 'pass', reason: null }),
    ...overrides,
  };
}

describe('Guardrail Runner', () => {
  it('should return content unchanged when no guardrails are provided', async () => {
    const result = await runGuardrails([], { message: 'hello' }, makeContext());
    expect(result.content).toEqual({ message: 'hello' });
    expect(result.warnings).toEqual([]);
  });

  // ── Priority Ordering ──

  it('should evaluate guardrails in priority order (lower number first)', async () => {
    const order: string[] = [];

    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'low-priority',
        priority: 200,
        handler: async () => {
          order.push('low');
          return { action: 'pass', reason: null };
        },
      }),
      makeGuardrail({
        name: 'high-priority',
        priority: 50,
        handler: async () => {
          order.push('high');
          return { action: 'pass', reason: null };
        },
      }),
      makeGuardrail({
        name: 'medium-priority',
        priority: 100,
        handler: async () => {
          order.push('medium');
          return { action: 'pass', reason: null };
        },
      }),
    ];

    await runGuardrails(guardrails, 'content', makeContext());
    expect(order).toEqual(['high', 'medium', 'low']);
  });

  // ── Phase Filtering ──

  it('should only run guardrails matching the context phase (input)', async () => {
    const evaluated: string[] = [];

    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'input-guard',
        phase: 'input',
        handler: async () => {
          evaluated.push('input-guard');
          return { action: 'pass', reason: null };
        },
      }),
      makeGuardrail({
        name: 'output-guard',
        phase: 'output',
        handler: async () => {
          evaluated.push('output-guard');
          return { action: 'pass', reason: null };
        },
      }),
    ];

    await runGuardrails(guardrails, 'content', makeContext({ phase: 'input' }));
    expect(evaluated).toEqual(['input-guard']);
  });

  it('should only run guardrails matching the context phase (output)', async () => {
    const evaluated: string[] = [];

    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'input-guard',
        phase: 'input',
        handler: async () => {
          evaluated.push('input-guard');
          return { action: 'pass', reason: null };
        },
      }),
      makeGuardrail({
        name: 'output-guard',
        phase: 'output',
        handler: async () => {
          evaluated.push('output-guard');
          return { action: 'pass', reason: null };
        },
      }),
    ];

    await runGuardrails(guardrails, 'content', makeContext({ phase: 'output' }));
    expect(evaluated).toEqual(['output-guard']);
  });

  // ── Block Mode ──

  it('should throw EngineError with GUARDRAIL_BLOCKED when a guardrail blocks', async () => {
    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'blocker',
        handler: async () => ({
          action: 'block',
          reason: 'contains PII',
        }),
      }),
    ];

    await expect(
      runGuardrails(guardrails, 'sensitive data', makeContext()),
    ).rejects.toThrow(EngineError);

    try {
      await runGuardrails(guardrails, 'sensitive data', makeContext());
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).code).toBe('GUARDRAIL_BLOCKED');
      expect((err as EngineError).message).toContain('blocker');
      expect((err as EngineError).message).toContain('contains PII');
    }
  });

  it('should stop evaluating remaining guardrails after a block', async () => {
    const evaluated: string[] = [];

    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'first',
        priority: 1,
        handler: async () => {
          evaluated.push('first');
          return { action: 'pass', reason: null };
        },
      }),
      makeGuardrail({
        name: 'blocker',
        priority: 2,
        handler: async () => {
          evaluated.push('blocker');
          return { action: 'block', reason: 'blocked' };
        },
      }),
      makeGuardrail({
        name: 'never-reached',
        priority: 3,
        handler: async () => {
          evaluated.push('never-reached');
          return { action: 'pass', reason: null };
        },
      }),
    ];

    await expect(
      runGuardrails(guardrails, 'content', makeContext()),
    ).rejects.toThrow(EngineError);

    expect(evaluated).toEqual(['first', 'blocker']);
  });

  // ── Warn Mode ──

  it('should continue and return warning when a guardrail warns', async () => {
    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'warner',
        handler: async () => ({
          action: 'warn',
          reason: 'content may be inappropriate',
        }),
      }),
    ];

    const result = await runGuardrails(guardrails, 'edgy content', makeContext());
    expect(result.content).toBe('edgy content');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toEqual({
      guardrailName: 'warner',
      reason: 'content may be inappropriate',
      phase: 'input',
    });
  });

  it('should collect multiple warnings from multiple guardrails', async () => {
    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'warner-1',
        priority: 1,
        handler: async () => ({
          action: 'warn',
          reason: 'warning one',
        }),
      }),
      makeGuardrail({
        name: 'warner-2',
        priority: 2,
        handler: async () => ({
          action: 'warn',
          reason: 'warning two',
        }),
      }),
    ];

    const result = await runGuardrails(guardrails, 'content', makeContext());
    expect(result.content).toBe('content');
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0].guardrailName).toBe('warner-1');
    expect(result.warnings[1].guardrailName).toBe('warner-2');
  });

  // ── Transform Mode ──

  it('should chain transformed content through sequential guardrails', async () => {
    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'uppercaser',
        priority: 1,
        handler: async (content) => ({
          action: 'transform',
          reason: null,
          transformedContent: (content as string).toUpperCase(),
        }),
      }),
      makeGuardrail({
        name: 'prefixer',
        priority: 2,
        handler: async (content) => ({
          action: 'transform',
          reason: null,
          transformedContent: `[SAFE] ${content as string}`,
        }),
      }),
    ];

    const result = await runGuardrails(guardrails, 'hello', makeContext());
    expect(result.content).toBe('[SAFE] HELLO');
  });

  it('should pass transformed content to the next guardrail in sequence', async () => {
    const seenContent: unknown[] = [];

    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'transformer',
        priority: 1,
        handler: async (content) => {
          seenContent.push(content);
          return {
            action: 'transform',
            reason: null,
            transformedContent: { transformed: true },
          };
        },
      }),
      makeGuardrail({
        name: 'observer',
        priority: 2,
        handler: async (content) => {
          seenContent.push(content);
          return { action: 'pass', reason: null };
        },
      }),
    ];

    await runGuardrails(guardrails, { original: true }, makeContext());
    expect(seenContent[0]).toEqual({ original: true });
    expect(seenContent[1]).toEqual({ transformed: true });
  });

  // ── Pass Action ──

  it('should continue with unchanged content on pass action', async () => {
    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'passer',
        handler: async () => ({ action: 'pass', reason: null }),
      }),
    ];

    const originalContent = { data: 'original' };
    const result = await runGuardrails(guardrails, originalContent, makeContext());
    expect(result.content).toEqual({ data: 'original' });
  });

  // ── failureMode: 'block' (default) ──

  it('should throw GUARDRAIL_BLOCKED when handler throws and failureMode is block (default)', async () => {
    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'thrower',
        handler: async () => {
          throw new Error('handler crashed');
        },
      }),
    ];

    try {
      await runGuardrails(guardrails, 'content', makeContext());
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).code).toBe('GUARDRAIL_BLOCKED');
      expect((err as EngineError).message).toContain('thrower');
      expect((err as EngineError).message).toContain('handler crashed');
    }
  });

  it('should throw GUARDRAIL_BLOCKED when handler throws and failureMode is explicitly block', async () => {
    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'explicit-block',
        failureMode: 'block',
        handler: async () => {
          throw new Error('explicit block failure');
        },
      }),
    ];

    await expect(
      runGuardrails(guardrails, 'content', makeContext()),
    ).rejects.toThrow(EngineError);
  });

  // ── failureMode: 'pass' ──

  it('should continue when handler throws and failureMode is pass', async () => {
    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'failing-pass',
        priority: 1,
        failureMode: 'pass',
        handler: async () => {
          throw new Error('handler crashed');
        },
      }),
      makeGuardrail({
        name: 'next-guard',
        priority: 2,
        handler: async () => ({
          action: 'transform',
          reason: null,
          transformedContent: 'processed',
        }),
      }),
    ];

    const result = await runGuardrails(guardrails, 'content', makeContext());
    expect(result.content).toBe('processed');
    expect(result.warnings).toEqual([]);
  });

  it('should skip the failing guardrail and preserve content when failureMode is pass', async () => {
    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'failing-pass',
        failureMode: 'pass',
        handler: async () => {
          throw new Error('oops');
        },
      }),
    ];

    const result = await runGuardrails(guardrails, 'original', makeContext());
    expect(result.content).toBe('original');
  });

  // ── flowName Filtering ──

  it('should include guardrails with null flowName (applies to all flows)', async () => {
    const evaluated: string[] = [];

    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'global-guard',
        flowName: null,
        handler: async () => {
          evaluated.push('global-guard');
          return { action: 'pass', reason: null };
        },
      }),
    ];

    await runGuardrails(guardrails, 'content', makeContext({ flowName: 'any-flow' }));
    expect(evaluated).toEqual(['global-guard']);
  });

  it('should include guardrails with undefined flowName (applies to all flows)', async () => {
    const evaluated: string[] = [];

    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'global-guard',
        // flowName not set (undefined)
        handler: async () => {
          evaluated.push('global-guard');
          return { action: 'pass', reason: null };
        },
      }),
    ];

    await runGuardrails(guardrails, 'content', makeContext({ flowName: 'any-flow' }));
    expect(evaluated).toEqual(['global-guard']);
  });

  it('should only run guardrails matching the specific flowName', async () => {
    const evaluated: string[] = [];

    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'flow-a-guard',
        flowName: 'flow-a',
        handler: async () => {
          evaluated.push('flow-a-guard');
          return { action: 'pass', reason: null };
        },
      }),
      makeGuardrail({
        name: 'flow-b-guard',
        flowName: 'flow-b',
        handler: async () => {
          evaluated.push('flow-b-guard');
          return { action: 'pass', reason: null };
        },
      }),
      makeGuardrail({
        name: 'global-guard',
        flowName: null,
        handler: async () => {
          evaluated.push('global-guard');
          return { action: 'pass', reason: null };
        },
      }),
    ];

    await runGuardrails(guardrails, 'content', makeContext({ flowName: 'flow-a' }));
    expect(evaluated).toEqual(['flow-a-guard', 'global-guard']);
  });

  // ── Multiple Guardrails in Sequence ──

  it('should run multiple guardrails in sequence with mixed actions', async () => {
    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'transformer',
        priority: 1,
        handler: async (content) => ({
          action: 'transform',
          reason: null,
          transformedContent: `${content as string}-transformed`,
        }),
      }),
      makeGuardrail({
        name: 'warner',
        priority: 2,
        handler: async () => ({
          action: 'warn',
          reason: 'heads up',
        }),
      }),
      makeGuardrail({
        name: 'passer',
        priority: 3,
        handler: async () => ({
          action: 'pass',
          reason: null,
        }),
      }),
    ];

    const result = await runGuardrails(guardrails, 'input', makeContext());
    expect(result.content).toBe('input-transformed');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].guardrailName).toBe('warner');
    expect(result.warnings[0].reason).toBe('heads up');
  });

  it('should run guardrails sequentially, not in parallel', async () => {
    let activeCount = 0;
    let maxActive = 0;

    const makeSlowGuardrail = (name: string, priority: number): Guardrail =>
      makeGuardrail({
        name,
        priority,
        handler: async () => {
          activeCount++;
          if (activeCount > maxActive) maxActive = activeCount;
          // Simulate async work
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeCount--;
          return { action: 'pass', reason: null };
        },
      });

    const guardrails: Guardrail[] = [
      makeSlowGuardrail('guard-1', 1),
      makeSlowGuardrail('guard-2', 2),
      makeSlowGuardrail('guard-3', 3),
    ];

    await runGuardrails(guardrails, 'content', makeContext());
    // If run in parallel, maxActive would be > 1
    expect(maxActive).toBe(1);
  });

  // ── Edge Cases ──

  it('should handle block with null reason', async () => {
    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'blocker',
        handler: async () => ({
          action: 'block',
          reason: null,
        }),
      }),
    ];

    try {
      await runGuardrails(guardrails, 'content', makeContext());
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).code).toBe('GUARDRAIL_BLOCKED');
    }
  });

  it('should include correct phase in warnings', async () => {
    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'output-warner',
        phase: 'output',
        handler: async () => ({
          action: 'warn',
          reason: 'output warning',
        }),
      }),
    ];

    const result = await runGuardrails(
      guardrails,
      'content',
      makeContext({ phase: 'output' }),
    );
    expect(result.warnings[0].phase).toBe('output');
  });

  it('should handle non-Error throws in handler with block failureMode', async () => {
    const guardrails: Guardrail[] = [
      makeGuardrail({
        name: 'string-thrower',
        handler: async () => {
          throw 'string error'; // eslint-disable-line no-throw-literal
        },
      }),
    ];

    try {
      await runGuardrails(guardrails, 'content', makeContext());
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).code).toBe('GUARDRAIL_BLOCKED');
      expect((err as EngineError).message).toContain('Unknown guardrail error');
    }
  });
});
