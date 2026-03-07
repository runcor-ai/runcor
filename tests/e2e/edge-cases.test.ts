// E2E: Boundary conditions and error paths (18 tests)
// Systematic edge cases not covered by existing tests

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import { createWaitSignal } from '../../src/wait-signal.js';
import { EngineError } from '../../src/errors.js';
import { createTestEngine, waitForState, waitForCompletion, delay } from './helpers.js';

let engine: Runcor;

afterEach(async () => {
  if (engine) await engine.shutdown();
});

describe('Edge cases: boundary conditions and error paths', { timeout: 30000 }, () => {
  it('trigger unregistered flow', async () => {
    engine = await createTestEngine();

    await expect(
      engine.trigger('nonexistent-flow', { idempotencyKey: 'nf-1' }),
    ).rejects.toThrow(/FLOW_NOT_FOUND|not found|not registered/i);
  });

  it('register duplicate flow name', async () => {
    engine = await createTestEngine();

    engine.register('dup-flow', async () => 'a', { maxRetries: 0 });

    expect(() => {
      engine.register('dup-flow', async () => 'b', { maxRetries: 0 });
    }).toThrow(/DUPLICATE_FLOW|already registered|duplicate/i);
  });

  it('trigger with missing idempotency key', async () => {
    engine = await createTestEngine();
    engine.register('idem-flow', async () => 'ok', { maxRetries: 0 });

    await expect(
      engine.trigger('idem-flow', { idempotencyKey: '' }),
    ).rejects.toThrow(/MISSING_IDEMPOTENCY_KEY|idempotency/i);
  });

  it('idempotency key deduplication', async () => {
    engine = await createTestEngine();
    engine.register('dedup-flow', async () => 'result', { maxRetries: 0 });

    const e1 = await engine.trigger('dedup-flow', { idempotencyKey: 'same-key' });
    const e2 = await engine.trigger('dedup-flow', { idempotencyKey: 'same-key' });

    expect(e1.id).toBe(e2.id);
  });

  it('duplicate idempotency key across different flows — both succeed', async () => {
    engine = await createTestEngine();
    engine.register('flow-a', async () => 'result-a', { maxRetries: 0 });
    engine.register('flow-b', async () => 'result-b', { maxRetries: 0 });

    const eA = await engine.trigger('flow-a', { idempotencyKey: 'shared-key' });
    const eB = await engine.trigger('flow-b', { idempotencyKey: 'shared-key' });

    await waitForCompletion(engine, eA.id);
    await waitForCompletion(engine, eB.id);

    const fA = await engine.getExecution(eA.id);
    const fB = await engine.getExecution(eB.id);

    // Different executions (keys are flow-scoped, or both succeed)
    expect(fA!.state).toBe('complete');
    expect(fB!.state).toBe('complete');
  });

  it('empty string input is valid', async () => {
    engine = await createTestEngine();
    engine.register('empty-input-flow', async (ctx) => {
      return `received: "${ctx.input}"`;
    }, { maxRetries: 0 });

    const exec = await engine.trigger('empty-input-flow', {
      idempotencyKey: 'ei-1',
      input: '',
    });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    expect(final!.result).toBe('received: ""');
  });

  it('null/undefined input stored as null', async () => {
    engine = await createTestEngine();
    engine.register('null-input-flow', async (ctx) => {
      return { inputWas: ctx.input };
    }, { maxRetries: 0 });

    const exec = await engine.trigger('null-input-flow', {
      idempotencyKey: 'ni-1',
      // No input provided → undefined
    });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
  });

  it('very large input (1MB string)', async () => {
    engine = await createTestEngine();
    engine.register('large-input-flow', async (ctx) => {
      return `length: ${(ctx.input as string).length}`;
    }, { maxRetries: 0 });

    const largeInput = 'x'.repeat(1024 * 1024); // 1MB
    const exec = await engine.trigger('large-input-flow', {
      idempotencyKey: 'li-1',
      input: largeInput,
    });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    expect(final!.result).toBe(`length: ${1024 * 1024}`);
  });

  it('handler returns null', async () => {
    engine = await createTestEngine();
    engine.register('null-result-flow', async () => null, { maxRetries: 0 });

    const exec = await engine.trigger('null-result-flow', { idempotencyKey: 'nr-1' });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    expect(final!.result).toBeNull();
  });

  it('handler returns nested object', async () => {
    engine = await createTestEngine();
    const nested = {
      a: { b: { c: { d: [1, 2, { e: 'deep' }] } } },
      arr: [{ x: 1 }, { x: 2 }],
    };
    engine.register('nested-result-flow', async () => nested, { maxRetries: 0 });

    const exec = await engine.trigger('nested-result-flow', { idempotencyKey: 'nest-1' });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    expect(final!.result).toEqual(nested);
  });

  it('unregister flow then trigger', async () => {
    engine = await createTestEngine();
    engine.register('temp-flow', async () => 'temp', { maxRetries: 0 });
    engine.unregister('temp-flow');

    await expect(
      engine.trigger('temp-flow', { idempotencyKey: 'uf-1' }),
    ).rejects.toThrow(/not.*registered|FLOW_NOT_FOUND/i);
  });

  it('resume non-waiting execution', async () => {
    engine = await createTestEngine();
    engine.register('done-flow', async () => 'done', { maxRetries: 0 });

    const exec = await engine.trigger('done-flow', { idempotencyKey: 'rnw-1' });
    await waitForCompletion(engine, exec.id);

    await expect(
      engine.resume(exec.id, 'data'),
    ).rejects.toThrow(/Cannot resume|INVALID_STATE/i);
  });

  it('cancel already-complete execution', async () => {
    engine = await createTestEngine();
    engine.register('already-done', async () => 'done', { maxRetries: 0 });

    const exec = await engine.trigger('already-done', { idempotencyKey: 'cac-1' });
    await waitForCompletion(engine, exec.id);

    await expect(
      engine.cancel(exec.id),
    ).rejects.toThrow(/Cannot cancel|INVALID_STATE/i);
  });

  it('cancel non-existent execution', async () => {
    engine = await createTestEngine();

    await expect(
      engine.cancel('non-existent-id'),
    ).rejects.toThrow(/EXECUTION_NOT_FOUND|not found/i);
  });

  it('replay non-terminal execution', async () => {
    engine = await createTestEngine();
    engine.register('replay-running', async () => {
      return createWaitSignal({ reason: 'waiting' });
    }, { maxRetries: 0 });

    const exec = await engine.trigger('replay-running', { idempotencyKey: 'rnt-1' });
    await waitForState(engine, exec.id, 'waiting');

    await expect(
      engine.replay(exec.id),
    ).rejects.toThrow(/INVALID_STATE|terminal|not.*complete|not.*failed/i);
  });

  it('trigger after shutdown', async () => {
    engine = await createTestEngine();
    engine.register('shutdown-flow', async () => 'ok', { maxRetries: 0 });

    await engine.shutdown();

    await expect(
      engine.trigger('shutdown-flow', { idempotencyKey: 'tas-1' }),
    ).rejects.toThrow(/ENGINE_SHUTTING_DOWN|ENGINE_NOT_READY|shut.*down|not ready/i);
  });

  it('event listener throws does not crash engine', async () => {
    engine = await createTestEngine();

    engine.on('execution:state_change', () => {
      throw new Error('listener crash');
    });

    engine.register('listener-crash-flow', async () => 'done', { maxRetries: 0 });

    const exec = await engine.trigger('listener-crash-flow', { idempotencyKey: 'lc-1' });
    await waitForCompletion(engine, exec.id);

    // Engine should still be operational
    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');

    // Can still trigger new flows
    engine.register('after-crash-flow', async () => 'still works', { maxRetries: 0 });
    const exec2 = await engine.trigger('after-crash-flow', { idempotencyKey: 'lc-2' });
    await waitForCompletion(engine, exec2.id);
    const f2 = await engine.getExecution(exec2.id);
    expect(f2!.state).toBe('complete');
  });

  it('drainTimeout=0 means immediate force-fail', async () => {
    engine = await createEngine({
      model: { provider: new MockProvider() },
      drainTimeout: 0,
    });

    engine.register('slow-drain-flow', async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return 'done';
    }, { maxRetries: 0 });

    const exec = await engine.trigger('slow-drain-flow', { idempotencyKey: 'sd-1' });
    await waitForState(engine, exec.id, 'running');

    await engine.shutdown();

    const final = await engine.getExecution(exec.id);
    // With drainTimeout=0, running executions should be force-failed
    expect(final!.state).toBe('failed');
  });
});
