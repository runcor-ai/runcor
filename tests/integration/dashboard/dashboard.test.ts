// Integration tests for built-in dashboard
// Dashboard integration tests

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../../src/engine.js';
import { MockProvider } from '../../../src/model/mock.js';
import { createServer } from '../../../src/http/server.js';
import type { RuncorServer } from '../../../src/http/types.js';

describe('Dashboard Integration', () => {
  let engine: Runcor;
  let server: RuncorServer;

  afterEach(async () => {
    if (server) await server.stop();
    else if (engine) await engine.shutdown();
  });

  it('GET /v1/dashboard returns HTML', async () => {
    engine = await createEngine({
      model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
    });
    server = createServer(engine, { port: 0, signal: false });
    await server.start();
    const { port } = server.address();

    const resp = await fetch(`http://localhost:${port}/v1/dashboard`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/html');
    const html = await resp.text();
    expect(html).toContain('runcor dashboard');
  });

  it('GET /v1/health returns capabilities', async () => {
    engine = await createEngine({
      model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
      cost: {},
    });
    server = createServer(engine, { port: 0, signal: false });
    await server.start();
    const { port } = server.address();

    const resp = await fetch(`http://localhost:${port}/v1/health`);
    const data = await resp.json();
    expect(data.capabilities).toBeDefined();
    expect(data.capabilities.cost).toBe(true);
    expect(data.capabilities.discernment).toBe(false);
  });

  it('GET /v1/providers returns provider list', async () => {
    const p1 = new MockProvider();
    const p2 = new MockProvider('response');
    Object.defineProperty(p2, 'name', { get: () => 'mock-2' });
    engine = await createEngine({
      model: { providers: [
        { provider: p1, priority: 1 },
        { provider: p2, priority: 2 },
      ] },
    });
    server = createServer(engine, { port: 0, signal: false });
    await server.start();
    const { port } = server.address();

    const resp = await fetch(`http://localhost:${port}/v1/providers`);
    const data = await resp.json();
    expect(data.providers).toHaveLength(2);
    expect(data.providers[0].healthState).toBe('healthy');
  });

  it('GET /v1/cost/summary returns zeroed when no entries', async () => {
    engine = await createEngine({
      model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
      cost: {},
    });
    server = createServer(engine, { port: 0, signal: false });
    await server.start();
    const { port } = server.address();

    const resp = await fetch(`http://localhost:${port}/v1/cost/summary`);
    const data = await resp.json();
    expect(data.total).toBe(0);
    expect(data.entryCount).toBe(0);
    expect(data.byFlow).toEqual([]);
  });

  it('GET /v1/cost/summary returns zeroed when cost disabled', async () => {
    engine = await createEngine({
      model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
    });
    server = createServer(engine, { port: 0, signal: false });
    await server.start();
    const { port } = server.address();

    const resp = await fetch(`http://localhost:${port}/v1/cost/summary`);
    const data = await resp.json();
    expect(data.total).toBe(0);
    expect(data.byFlow).toEqual([]);
  });

  it('GET /v1/discernment returns disabled when not configured', async () => {
    engine = await createEngine({
      model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
    });
    server = createServer(engine, { port: 0, signal: false });
    await server.start();
    const { port } = server.address();

    const resp = await fetch(`http://localhost:${port}/v1/discernment`);
    const data = await resp.json();
    expect(data.enabled).toBe(false);
    expect(data.objectives).toEqual([]);
    expect(data.latestReport).toBeNull();
  });

  it('GET /v1/discernment returns objectives when enabled', async () => {
    engine = await createEngine({
      model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
      discernment: {
        enabled: true,
        autonomy: 'observe',
        schedule: 'daily',
        objectives: [{ name: 'test-obj', description: 'Test' }],
      },
    });
    server = createServer(engine, { port: 0, signal: false });
    await server.start();
    const { port } = server.address();

    const resp = await fetch(`http://localhost:${port}/v1/discernment`);
    const data = await resp.json();
    expect(data.enabled).toBe(true);
    expect(data.objectives).toHaveLength(1);
    expect(data.objectives[0].name).toBe('test-obj');
  });

  it('GET /v1/executions/:id/detail returns 404 for missing execution', async () => {
    engine = await createEngine({
      model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
    });
    server = createServer(engine, { port: 0, signal: false });
    await server.start();
    const { port } = server.address();

    const resp = await fetch(`http://localhost:${port}/v1/executions/nonexistent/detail`);
    expect(resp.status).toBe(404);
  });

  it('GET /v1/executions/:id/detail returns composite data', async () => {
    engine = await createEngine({
      model: {
        providers: [{ provider: new MockProvider(), priority: 1, costPerToken: { input: 0.001, output: 0.002 } }],
      },
      cost: {},
    });
    server = createServer(engine, { port: 0, signal: false });
    await server.start();
    const { port } = server.address();

    engine.register('detail-flow', async (ctx) => {
      const r = await ctx.model.complete({ prompt: 'hi' });
      return r.text;
    });

    const execution = await engine.trigger('detail-flow', { idempotencyKey: 'detail-int-1' });

    // Wait for completion
    await new Promise<void>((resolve) => {
      engine.on('execution:complete', (e) => {
        if (e.executionId === execution.id) resolve();
      });
    });

    const resp = await fetch(`http://localhost:${port}/v1/executions/${execution.id}/detail`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.execution).toBeDefined();
    expect(data.execution.state).toBe('complete');
    expect(data.costEntries).not.toBeNull();
    expect(data.costEntries.length).toBeGreaterThanOrEqual(1);
    expect(data.evaluation).toBeNull(); // no evaluators
  });

  // T039: Graceful degradation across 3 config tiers
  describe('graceful degradation (SC-005)', () => {
    it('minimal config — provider only', async () => {
      engine = await createEngine({
        model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
      });
      server = createServer(engine, { port: 0, signal: false });
      await server.start();
      const { port } = server.address();

      const health = await (await fetch(`http://localhost:${port}/v1/health`)).json();
      expect(health.capabilities.cost).toBe(false);
      expect(health.capabilities.discernment).toBe(false);

      // All endpoints still return 200 (not 500)
      const providers = await fetch(`http://localhost:${port}/v1/providers`);
      expect(providers.status).toBe(200);

      const cost = await fetch(`http://localhost:${port}/v1/cost/summary`);
      expect(cost.status).toBe(200);

      const disc = await fetch(`http://localhost:${port}/v1/discernment`);
      expect(disc.status).toBe(200);

      const dashboard = await fetch(`http://localhost:${port}/v1/dashboard`);
      expect(dashboard.status).toBe(200);
    });

    it('partial config — provider + cost + adapters', async () => {
      engine = await createEngine({
        model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
        cost: {},
      });
      server = createServer(engine, { port: 0, signal: false });
      await server.start();
      const { port } = server.address();

      const health = await (await fetch(`http://localhost:${port}/v1/health`)).json();
      expect(health.capabilities.cost).toBe(true);
      expect(health.capabilities.discernment).toBe(false);
    });

    it('full config — all subsystems', async () => {
      engine = await createEngine({
        model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
        cost: {},
        discernment: {
          enabled: true,
          autonomy: 'observe',
          schedule: 'daily',
          objectives: [{ name: 'test', description: 'Test' }],
        },
      });
      server = createServer(engine, { port: 0, signal: false });
      await server.start();
      const { port } = server.address();

      const health = await (await fetch(`http://localhost:${port}/v1/health`)).json();
      expect(health.capabilities.cost).toBe(true);
      expect(health.capabilities.discernment).toBe(true);
    });
  });
});
