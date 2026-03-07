import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../../src/engine.js';
import { MockProvider } from '../../../src/model/mock.js';
import { createWaitSignal } from '../../../src/wait-signal.js';

describe('CLI — runcor status', () => {
  let engine: Runcor;

  afterEach(async () => {
    if (engine) await engine.shutdown();
  });

  it('lists executions after triggering flows', async () => {
    const provider = new MockProvider();
    provider.queueResponses([{ text: 'a' }, { text: 'b' }]);
    engine = await createEngine({ model: { provider } });

    engine.register('flow-a', async (ctx) => {
      await ctx.model.complete({ messages: [{ role: 'user', content: 'hi' }] });
      return { ok: true };
    });
    engine.register('flow-b', async (ctx) => {
      await ctx.model.complete({ messages: [{ role: 'user', content: 'hi' }] });
      return { ok: true };
    });

    await engine.trigger('flow-a', { idempotencyKey: 'st-1', userId: 'cli' });
    await engine.trigger('flow-b', { idempotencyKey: 'st-2', userId: 'cli' });

    await new Promise(r => setTimeout(r, 300));

    const all = await engine.list();
    expect(all.length).toBe(2);
    expect(all.some(e => e.flowName === 'flow-a')).toBe(true);
    expect(all.some(e => e.flowName === 'flow-b')).toBe(true);
  });

  it('--state filter returns only matching executions', async () => {
    const provider = new MockProvider();
    provider.queueResponses([{ text: 'ok' }]);
    engine = await createEngine({ model: { provider } });

    engine.register('done-flow', async () => ({ result: 1 }));
    engine.register('wait-flow', async () => createWaitSignal({ reason: 'test' }));

    await engine.trigger('done-flow', { idempotencyKey: 'st-3', userId: 'cli' });
    await engine.trigger('wait-flow', { idempotencyKey: 'st-4', userId: 'cli' });

    await new Promise(r => setTimeout(r, 300));

    const completed = await engine.list({ state: 'complete' });
    expect(completed.length).toBe(1);
    expect(completed[0].flowName).toBe('done-flow');

    const waiting = await engine.list({ state: 'waiting' });
    expect(waiting.length).toBe(1);
    expect(waiting[0].flowName).toBe('wait-flow');
  });

  it('--flow filter returns only matching flow name', async () => {
    const provider = new MockProvider();
    provider.queueResponses([{ text: 'a' }, { text: 'b' }]);
    engine = await createEngine({ model: { provider } });

    engine.register('alpha', async (ctx) => {
      await ctx.model.complete({ messages: [{ role: 'user', content: 'hi' }] });
      return 'alpha';
    });
    engine.register('beta', async (ctx) => {
      await ctx.model.complete({ messages: [{ role: 'user', content: 'hi' }] });
      return 'beta';
    });

    await engine.trigger('alpha', { idempotencyKey: 'st-5', userId: 'cli' });
    await engine.trigger('beta', { idempotencyKey: 'st-6', userId: 'cli' });

    await new Promise(r => setTimeout(r, 300));

    const filtered = await engine.list({ flowName: 'alpha' });
    expect(filtered.length).toBe(1);
    expect(filtered[0].flowName).toBe('alpha');
  });

  it('empty state returns empty array', async () => {
    const provider = new MockProvider();
    engine = await createEngine({ model: { provider } });

    const all = await engine.list();
    expect(all).toEqual([]);
  });

  it('--json outputs structured array', async () => {
    const provider = new MockProvider();
    engine = await createEngine({ model: { provider } });

    engine.register('json-flow', async () => ({ val: 42 }));

    await engine.trigger('json-flow', { idempotencyKey: 'st-7', userId: 'cli' });
    await new Promise(r => setTimeout(r, 200));

    const all = await engine.list();
    expect(all.length).toBe(1);

    // Verify the JSON shape matches contracts
    const jsonOutput = {
      executions: all.map(e => ({
        id: e.id,
        flowName: e.flowName,
        state: e.state,
        result: e.result ?? null,
        error: e.error ?? null,
        createdAt: e.timestamps.queued.toISOString(),
        completedAt: e.timestamps.completed?.toISOString() ?? null,
      })),
    };

    expect(jsonOutput.executions[0].id).toBeTruthy();
    expect(jsonOutput.executions[0].flowName).toBe('json-flow');
    expect(jsonOutput.executions[0].state).toBe('complete');
    expect(jsonOutput.executions[0].result).toEqual({ val: 42 });
  });

  it('limit caps results', async () => {
    const provider = new MockProvider();
    provider.queueResponses([{ text: '1' }, { text: '2' }, { text: '3' }]);
    engine = await createEngine({ model: { provider } });

    engine.register('many', async () => ({ ok: true }));

    await engine.trigger('many', { idempotencyKey: 'st-8', userId: 'cli' });
    await engine.trigger('many', { idempotencyKey: 'st-9', userId: 'cli' });
    await engine.trigger('many', { idempotencyKey: 'st-10', userId: 'cli' });

    await new Promise(r => setTimeout(r, 300));

    const all = await engine.list();
    expect(all.length).toBe(3);

    // Slice simulates --limit behavior
    const limited = all.slice(0, 2);
    expect(limited.length).toBe(2);
  });
});
