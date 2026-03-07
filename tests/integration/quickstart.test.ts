// Quickstart.md validation — verify all code examples work end-to-end

import { describe, it, expect } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';

describe('Quickstart Examples', () => {
  it('Example 2: counter flow with tool-scoped memory', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const results: string[] = [];

    engine.register('counter', async (ctx) => {
      const count = (await ctx.memory.tool.get<number>('count')) ?? 0;
      await ctx.memory.tool.set('count', count + 1);
      const msg = `This flow has been called ${count + 1} time(s)`;
      results.push(msg);
      return msg;
    });

    // First call
    await engine.trigger('counter', { idempotencyKey: 'counter-1' });
    await new Promise((resolve) => engine.once('execution:complete', resolve));

    // Second call
    await engine.trigger('counter', { idempotencyKey: 'counter-2' });
    await new Promise((resolve) => engine.once('execution:complete', resolve));

    expect(results[0]).toBe('This flow has been called 1 time(s)');
    expect(results[1]).toBe('This flow has been called 2 time(s)');
  });

  it('Example 4: user-scoped memory for personalization', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    let loadedTheme: string | null = null;

    engine.register('save-pref', async (ctx) => {
      await ctx.memory.user.set('theme', ctx.input);
      return 'Preference saved';
    });

    engine.register('load-pref', async (ctx) => {
      const theme = await ctx.memory.user.get<string>('theme');
      loadedTheme = theme ?? 'default';
      return loadedTheme;
    });

    // Save for user-42
    await engine.trigger('save-pref', {
      idempotencyKey: 'pref-1',
      userId: 'user-42',
      input: 'dark',
    });
    await new Promise((resolve) => engine.once('execution:complete', resolve));

    // Load for user-42 — gets "dark"
    await engine.trigger('load-pref', {
      idempotencyKey: 'pref-2',
      userId: 'user-42',
    });
    await new Promise((resolve) => engine.once('execution:complete', resolve));

    expect(loadedTheme).toBe('dark');
  });

  it('Example 5: session-scoped memory for multi-step workflows', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const results: string[] = [];

    engine.register('step1', async (ctx) => {
      await ctx.memory.session.set('data', { validated: true });
      results.push('Step 1 complete');
      return 'Step 1 complete';
    });

    engine.register('step2', async (ctx) => {
      const prev = await ctx.memory.session.get<{ validated: boolean }>('data');
      if (!prev?.validated) throw new Error('Step 1 not completed');
      results.push('Step 2 complete');
      return 'Step 2 complete';
    });

    await engine.trigger('step1', {
      idempotencyKey: 'wiz-1',
      sessionId: 'session-abc',
    });
    await new Promise((resolve) => engine.once('execution:complete', resolve));

    await engine.trigger('step2', {
      idempotencyKey: 'wiz-2',
      sessionId: 'session-abc',
    });
    await new Promise((resolve) => engine.once('execution:complete', resolve));

    expect(results).toEqual(['Step 1 complete', 'Step 2 complete']);
  });

  it('Example 6: TTL for automatic expiry', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const results: string[] = [];

    engine.register('cached', async (ctx) => {
      const cached = await ctx.memory.tool.get<string>('result');
      if (cached) {
        results.push(`(cached) ${cached}`);
        return `(cached) ${cached}`;
      }

      // Simulate a "fresh" result
      const fresh = 'computed-value';
      await ctx.memory.tool.set('result', fresh, 30000); // expires in 30s
      results.push(fresh);
      return fresh;
    });

    // First call — computes fresh
    await engine.trigger('cached', { idempotencyKey: 'c-1' });
    await new Promise((resolve) => engine.once('execution:complete', resolve));

    // Second call — returns cached
    await engine.trigger('cached', { idempotencyKey: 'c-2' });
    await new Promise((resolve) => engine.once('execution:complete', resolve));

    expect(results[0]).toBe('computed-value');
    expect(results[1]).toBe('(cached) computed-value');
  });
});
