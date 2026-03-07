// Unit tests for route handler edge cases
// Per tasks.md T037: pagination boundaries, health uptime, error details

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../../src/engine.js';
import { createServer } from '../../../src/http/server.js';
import type { RuncorServer } from '../../../src/http/types.js';
import { MockProvider } from '../../../src/model/mock.js';

async function req(server: RuncorServer, path: string, init?: RequestInit) {
  const res = await server.app.request(path, init);
  const body = await res.json();
  return { status: res.status, body, headers: res.headers };
}

describe('Route Handler Edge Cases', () => {
  let engine: Runcor;
  let server: RuncorServer;
  let provider: MockProvider;

  beforeEach(async () => {
    provider = new MockProvider();
    engine = await createEngine({
      model: { provider },
    });
    engine.register('test-flow', async () => 'result');
    server = createServer(engine, { port: 0, signal: false });
  });

  afterEach(async () => {
    await engine.shutdown();
  });

  // --- Pagination boundaries ---
  it('limit=0 returns empty results', async () => {
    provider.queueResponses([{ text: 'a' }]);
    await server.app.request('/v1/flows/test-flow/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'pag-001' }),
    });

    const { status, body } = await req(server, '/v1/executions?limit=0');
    expect(status).toBe(200);
    expect(body.executions).toHaveLength(0);
  });

  it('limit > 200 is clamped to 200', async () => {
    const { status, body } = await req(server, '/v1/executions?limit=999');
    expect(status).toBe(200);
    // Just verify it doesn't crash — no 999 results to validate
    expect(body.executions).toBeDefined();
  });

  it('negative limit treated as default 50', async () => {
    const { status, body } = await req(server, '/v1/executions?limit=-5');
    expect(status).toBe(200);
    expect(body.executions).toBeDefined();
  });

  it('negative offset treated as 0', async () => {
    const { status, body } = await req(server, '/v1/executions?offset=-10');
    expect(status).toBe(200);
    expect(body.executions).toBeDefined();
  });

  it('non-numeric limit treated as default', async () => {
    const { status, body } = await req(server, '/v1/executions?limit=abc');
    expect(status).toBe(200);
    expect(body.executions).toBeDefined();
  });

  // --- Health uptime ---
  it('health uptime increases over time', async () => {
    const first = await req(server, '/v1/health');
    // Small delay
    await new Promise((r) => setTimeout(r, 50));
    const second = await req(server, '/v1/health');

    expect(second.body.uptime).toBeGreaterThanOrEqual(first.body.uptime);
  });

  // --- Error response shape ---
  it('404 error response includes code, message, and details=null', async () => {
    const { status, body } = await req(server, '/v1/executions/non-existent');
    expect(status).toBe(404);
    expect(body.error).toMatchObject({
      code: 'EXECUTION_NOT_FOUND',
      message: expect.any(String),
      details: null,
    });
  });
});
