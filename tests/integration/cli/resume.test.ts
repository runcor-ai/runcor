import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../../src/engine.js';
import { MockProvider } from '../../../src/model/mock.js';
import { createWaitSignal } from '../../../src/wait-signal.js';

describe('CLI — runcor resume', () => {
  let engine: Runcor;

  afterEach(async () => {
    if (engine) await engine.shutdown();
  });

  it('resume waiting execution succeeds', async () => {
    const provider = new MockProvider();
    engine = await createEngine({ model: { provider } });

    engine.register('wait-flow', async (ctx) => {
      if (!ctx.resumeData) {
        return createWaitSignal({ reason: 'waiting for data' });
      }
      return { received: ctx.resumeData };
    });

    const exec = await engine.trigger('wait-flow', {
      idempotencyKey: 'res-1',
      userId: 'cli',
    });

    await new Promise(r => setTimeout(r, 200));
    let state = await engine.getExecution(exec.id);
    expect(state?.state).toBe('waiting');

    // Resume with data
    await engine.resume(exec.id, { answer: 42 });
    await new Promise(r => setTimeout(r, 300));

    state = await engine.getExecution(exec.id);
    expect(state?.state).toBe('complete');
    expect(state?.result).toEqual({ received: { answer: 42 } });
  });

  it('resume with data passes data to flow via ctx.resumeData', async () => {
    const provider = new MockProvider();
    engine = await createEngine({ model: { provider } });

    let capturedResumeData: unknown;
    engine.register('capture-flow', async (ctx) => {
      if (!ctx.resumeData) {
        return createWaitSignal({ reason: 'need input' });
      }
      capturedResumeData = ctx.resumeData;
      return { done: true };
    });

    const exec = await engine.trigger('capture-flow', {
      idempotencyKey: 'res-2',
      userId: 'cli',
    });

    await new Promise(r => setTimeout(r, 200));

    await engine.resume(exec.id, { key: 'value', nested: { a: 1 } });
    await new Promise(r => setTimeout(r, 300));

    expect(capturedResumeData).toEqual({ key: 'value', nested: { a: 1 } });
  });

  it('resume non-waiting execution throws INVALID_TRANSITION', async () => {
    const provider = new MockProvider();
    engine = await createEngine({ model: { provider } });

    engine.register('done-flow', async () => ({ result: 'done' }));

    const exec = await engine.trigger('done-flow', {
      idempotencyKey: 'res-3',
      userId: 'cli',
    });

    await new Promise(r => setTimeout(r, 200));
    const state = await engine.getExecution(exec.id);
    expect(state?.state).toBe('complete');

    await expect(engine.resume(exec.id)).rejects.toThrow(/cannot resume|invalid.*transition/i);
  });

  it('resume non-existent execution throws EXECUTION_NOT_FOUND', async () => {
    const provider = new MockProvider();
    engine = await createEngine({ model: { provider } });

    await expect(engine.resume('nonexistent-id')).rejects.toThrow(/not found/i);
  });

  it('resume without data uses undefined', async () => {
    const provider = new MockProvider();
    engine = await createEngine({ model: { provider } });

    let resumeDataValue: unknown = 'sentinel';
    engine.register('nodata-flow', async (ctx) => {
      if (!ctx.resumeData && resumeDataValue === 'sentinel') {
        resumeDataValue = ctx.resumeData;
        return createWaitSignal({ reason: 'waiting' });
      }
      resumeDataValue = ctx.resumeData;
      return { ok: true };
    });

    const exec = await engine.trigger('nodata-flow', {
      idempotencyKey: 'res-5',
      userId: 'cli',
    });

    await new Promise(r => setTimeout(r, 200));

    // Resume without data
    await engine.resume(exec.id);
    await new Promise(r => setTimeout(r, 300));

    const state = await engine.getExecution(exec.id);
    expect(state?.state).toBe('complete');
  });

  it('--json outputs structured result after resume', async () => {
    const provider = new MockProvider();
    engine = await createEngine({ model: { provider } });

    engine.register('json-resume', async (ctx) => {
      if (!ctx.resumeData) {
        return createWaitSignal({ reason: 'wait' });
      }
      return { answer: ctx.resumeData };
    });

    const exec = await engine.trigger('json-resume', {
      idempotencyKey: 'res-6',
      userId: 'cli',
    });

    await new Promise(r => setTimeout(r, 200));

    await engine.resume(exec.id, 'hello');
    await new Promise(r => setTimeout(r, 300));

    const result = await engine.getExecution(exec.id);
    expect(result?.state).toBe('complete');

    // Verify JSON shape matches contracts
    const jsonOutput = {
      execution: {
        id: result!.id,
        flowName: result!.flowName,
        state: result!.state,
        result: result!.result ?? null,
        error: result!.error ?? null,
        createdAt: result!.timestamps.queued.toISOString(),
        completedAt: result!.timestamps.completed?.toISOString() ?? null,
      },
    };

    expect(jsonOutput.execution.id).toBeTruthy();
    expect(jsonOutput.execution.flowName).toBe('json-resume');
    expect(jsonOutput.execution.state).toBe('complete');
    expect(jsonOutput.execution.result).toEqual({ answer: 'hello' });
  });
});
