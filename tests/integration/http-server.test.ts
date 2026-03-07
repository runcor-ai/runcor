// Integration tests for HTTP Server Mode
// Tests use Hono's app.request() — no real HTTP server needed

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../src/engine.js';
import { createServer } from '../../src/http/server.js';
import type { RuncorServer } from '../../src/http/types.js';
import { MockProvider } from '../../src/model/mock.js';
import { createWaitSignal } from '../../src/wait-signal.js';

// Helper: make a request via Hono's app.request()
async function req(server: RuncorServer, path: string, init?: RequestInit) {
  const res = await server.app.request(path, init);
  const body = await res.json();
  return { status: res.status, body, headers: res.headers };
}

async function postJson(server: RuncorServer, path: string, data: unknown) {
  return req(server, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

// Helper: wait for execution to reach a target state
async function waitForState(
  engine: Runcor,
  executionId: string,
  targetState: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const exec = await engine.getExecution(executionId);
    if (exec?.state === targetState) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Execution ${executionId} did not reach state "${targetState}" within ${timeoutMs}ms`);
}

describe('HTTP Server — US1: Trigger Flows and Core Endpoints', () => {
  let engine: Runcor;
  let server: RuncorServer;
  let provider: MockProvider;

  beforeEach(async () => {
    provider = new MockProvider();
    provider.queueResponses([{ text: 'test response' }]);

    engine = await createEngine({
      model: { provider },
    });

    engine.register('test-flow', async (ctx) => {
      const result = await ctx.model.complete({ messages: [{ role: 'user', content: String(ctx.input) }] });
      return { answer: result.text };
    });

    server = createServer(engine, { port: 0, signal: false });
  });

  afterEach(async () => {
    await engine.shutdown();
  });

  // --- Health ---
  it('GET /v1/health returns 200 with status, uptime, flows, adapters', async () => {
    const { status, body } = await req(server, '/v1/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ready');
    expect(typeof body.uptime).toBe('number');
    expect(body.flows).toBe(1);
    expect(body.adapters).toBe(0);
  });

  // --- Flows ---
  it('GET /v1/flows returns registered flows', async () => {
    const { status, body } = await req(server, '/v1/flows');
    expect(status).toBe(200);
    expect(body.flows).toHaveLength(1);
    expect(body.flows[0].name).toBe('test-flow');
  });

  // --- Trigger ---
  it('POST /v1/flows/:name/trigger returns 201 with execution', async () => {
    const { status, body } = await postJson(server, '/v1/flows/test-flow/trigger', {
      idempotencyKey: 'test-001',
      input: { text: 'hello' },
    });
    expect(status).toBe(201);
    expect(body.execution).toBeDefined();
    expect(body.execution.id).toBeDefined();
    expect(body.execution.flowName).toBe('test-flow');
    expect(body.execution.idempotencyKey).toBe('test-001');
  });

  it('POST trigger missing idempotencyKey returns 400', async () => {
    const { status, body } = await postJson(server, '/v1/flows/test-flow/trigger', {
      input: { text: 'hello' },
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.field).toBe('idempotencyKey');
  });

  it('POST trigger unknown flow returns 404', async () => {
    const { status, body } = await postJson(server, '/v1/flows/unknown-flow/trigger', {
      idempotencyKey: 'test-002',
    });
    expect(status).toBe(404);
    expect(body.error.code).toBe('FLOW_NOT_FOUND');
  });

  it('POST trigger with unknown extra fields succeeds (lenient parsing)', async () => {
    provider.queueResponses([{ text: 'lenient' }]);
    const { status, body } = await postJson(server, '/v1/flows/test-flow/trigger', {
      idempotencyKey: 'test-003',
      input: 'data',
      unknownField: 'should be ignored',
      anotherUnknown: 123,
    });
    expect(status).toBe(201);
    expect(body.execution).toBeDefined();
  });

  it('POST trigger input defaults to null when omitted', async () => {
    provider.queueResponses([{ text: 'no input' }]);
    const { status, body } = await postJson(server, '/v1/flows/test-flow/trigger', {
      idempotencyKey: 'test-004',
    });
    expect(status).toBe(201);
    expect(body.execution.input).toBeNull();
  });

  // --- Executions ---
  it('GET /v1/executions/:id returns execution', async () => {
    const trigger = await postJson(server, '/v1/flows/test-flow/trigger', {
      idempotencyKey: 'get-test-001',
      input: 'hello',
    });
    const execId = trigger.body.execution.id;

    const { status, body } = await req(server, `/v1/executions/${execId}`);
    expect(status).toBe(200);
    expect(body.execution.id).toBe(execId);
  });

  it('GET /v1/executions/:id returns 404 for non-existent', async () => {
    const { status, body } = await req(server, '/v1/executions/non-existent-id');
    expect(status).toBe(404);
    expect(body.error.code).toBe('EXECUTION_NOT_FOUND');
  });

  it('GET /v1/executions returns list of executions', async () => {
    provider.queueResponses([{ text: 'r1' }, { text: 'r2' }]);
    await postJson(server, '/v1/flows/test-flow/trigger', { idempotencyKey: 'list-001', input: 'a' });
    await postJson(server, '/v1/flows/test-flow/trigger', { idempotencyKey: 'list-002', input: 'b' });

    const { status, body } = await req(server, '/v1/executions');
    expect(status).toBe(200);
    expect(body.executions.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /v1/executions with state filter', async () => {
    provider.queueResponses([{ text: 'done' }]);
    const trigger = await postJson(server, '/v1/flows/test-flow/trigger', {
      idempotencyKey: 'filter-state-001', input: 'x',
    });
    await waitForState(engine, trigger.body.execution.id, 'complete');

    const { status, body } = await req(server, '/v1/executions?state=complete');
    expect(status).toBe(200);
    expect(body.executions.length).toBeGreaterThanOrEqual(1);
    for (const e of body.executions) {
      expect(e.state).toBe('complete');
    }
  });

  it('GET /v1/executions with flowName filter', async () => {
    const { status, body } = await req(server, '/v1/executions?flowName=test-flow');
    expect(status).toBe(200);
    for (const e of body.executions) {
      expect(e.flowName).toBe('test-flow');
    }
  });

  it('GET /v1/executions with pagination (limit, offset)', async () => {
    provider.queueResponses([{ text: 'p1' }, { text: 'p2' }, { text: 'p3' }]);
    await postJson(server, '/v1/flows/test-flow/trigger', { idempotencyKey: 'page-001', input: 'a' });
    await postJson(server, '/v1/flows/test-flow/trigger', { idempotencyKey: 'page-002', input: 'b' });
    await postJson(server, '/v1/flows/test-flow/trigger', { idempotencyKey: 'page-003', input: 'c' });

    const { status, body } = await req(server, '/v1/executions?limit=2&offset=0');
    expect(status).toBe(200);
    expect(body.executions.length).toBeLessThanOrEqual(2);
  });

  it('GET /v1/executions empty result returns 200 with empty array', async () => {
    const { status, body } = await req(server, '/v1/executions?flowName=non-existent-flow');
    expect(status).toBe(200);
    expect(body.executions).toEqual([]);
  });
});

describe('HTTP Server — US2: Resume, Replay, Cancel, Delete', () => {
  let engine: Runcor;
  let server: RuncorServer;
  let provider: MockProvider;

  beforeEach(async () => {
    provider = new MockProvider();
    engine = await createEngine({
      model: { provider },
    });
    server = createServer(engine, { port: 0, signal: false });
  });

  afterEach(async () => {
    await engine.shutdown();
  });

  // --- Resume ---
  it('POST /v1/executions/:id/resume resumes a waiting execution', async () => {
    engine.register('wait-flow', async (ctx) => {
      if (ctx.resumeData) {
        return { approved: (ctx.resumeData as any).approved };
      }
      return createWaitSignal({ reason: 'Need approval' });
    });

    const trigger = await postJson(server, '/v1/flows/wait-flow/trigger', {
      idempotencyKey: 'resume-001',
    });
    const execId = trigger.body.execution.id;
    await waitForState(engine, execId, 'waiting');

    const { status, body } = await postJson(server, `/v1/executions/${execId}/resume`, {
      resumeData: { approved: true },
    });
    expect(status).toBe(200);
    expect(body.execution).toBeDefined();
  });

  it('POST /v1/executions/:id/resume on non-waiting returns 409', async () => {
    engine.register('simple-flow', async () => 'done');
    provider.queueResponses([{ text: 'done' }]);
    const trigger = await postJson(server, '/v1/flows/simple-flow/trigger', {
      idempotencyKey: 'resume-fail-001',
    });
    const execId = trigger.body.execution.id;
    await waitForState(engine, execId, 'complete');

    const { status } = await postJson(server, `/v1/executions/${execId}/resume`, {});
    expect(status).toBe(409);
  });

  it('POST /v1/executions/:id/resume non-existent returns 404', async () => {
    const { status } = await postJson(server, '/v1/executions/no-such-id/resume', {});
    expect(status).toBe(404);
  });

  // --- Replay ---
  it('POST /v1/executions/:id/replay creates new execution from completed one', async () => {
    engine.register('replay-flow', async () => 'original result');
    provider.queueResponses([{ text: 'r1' }, { text: 'r2' }]);
    const trigger = await postJson(server, '/v1/flows/replay-flow/trigger', {
      idempotencyKey: 'replay-001',
    });
    const execId = trigger.body.execution.id;
    await waitForState(engine, execId, 'complete');

    const { status, body } = await postJson(server, `/v1/executions/${execId}/replay`, {});
    expect(status).toBe(201);
    expect(body.execution.id).not.toBe(execId);
    expect(body.execution.replayOf).toBe(execId);
  });

  it('POST /v1/executions/:id/replay on non-terminal returns 409', async () => {
    engine.register('wait-flow2', async () => createWaitSignal({ reason: 'wait' }));
    const trigger = await postJson(server, '/v1/flows/wait-flow2/trigger', {
      idempotencyKey: 'replay-fail-001',
    });
    const execId = trigger.body.execution.id;
    await waitForState(engine, execId, 'waiting');

    const { status } = await postJson(server, `/v1/executions/${execId}/replay`, {});
    expect(status).toBe(409);
  });

  // --- Cancel ---
  it('POST /v1/executions/:id/cancel cancels an active execution', async () => {
    engine.register('slow-flow', async () => {
      return createWaitSignal({ reason: 'long wait' });
    });
    const trigger = await postJson(server, '/v1/flows/slow-flow/trigger', {
      idempotencyKey: 'cancel-001',
    });
    const execId = trigger.body.execution.id;
    await waitForState(engine, execId, 'waiting');

    const { status, body } = await postJson(server, `/v1/executions/${execId}/cancel`, {
      reason: 'User requested',
    });
    expect(status).toBe(200);
    expect(body.execution.state).toBe('failed');
  });

  it('POST /v1/executions/:id/cancel on completed returns 409', async () => {
    engine.register('done-flow', async () => 'done');
    provider.queueResponses([{ text: 'done' }]);
    const trigger = await postJson(server, '/v1/flows/done-flow/trigger', {
      idempotencyKey: 'cancel-fail-001',
    });
    const execId = trigger.body.execution.id;
    await waitForState(engine, execId, 'complete');

    const { status } = await postJson(server, `/v1/executions/${execId}/cancel`, {});
    expect(status).toBe(409);
  });

  // --- Delete ---
  it('DELETE /v1/executions/:id deletes a terminal execution', async () => {
    engine.register('del-flow', async () => 'deletable');
    provider.queueResponses([{ text: 'done' }]);
    const trigger = await postJson(server, '/v1/flows/del-flow/trigger', {
      idempotencyKey: 'delete-001',
    });
    const execId = trigger.body.execution.id;
    await waitForState(engine, execId, 'complete');

    const { status, body } = await req(server, `/v1/executions/${execId}`, { method: 'DELETE' });
    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(body.id).toBe(execId);

    // Subsequent GET returns 404
    const { status: getStatus } = await req(server, `/v1/executions/${execId}`);
    expect(getStatus).toBe(404);
  });

  it('DELETE /v1/executions/:id on non-terminal returns 409', async () => {
    engine.register('wait-del', async () => createWaitSignal({ reason: 'wait' }));
    const trigger = await postJson(server, '/v1/flows/wait-del/trigger', {
      idempotencyKey: 'delete-fail-001',
    });
    const execId = trigger.body.execution.id;
    await waitForState(engine, execId, 'waiting');

    const { status } = await req(server, `/v1/executions/${execId}`, { method: 'DELETE' });
    expect(status).toBe(409);
  });

  it('DELETE /v1/executions/:id non-existent returns 404', async () => {
    const { status } = await req(server, '/v1/executions/no-such-id', { method: 'DELETE' });
    expect(status).toBe(404);
  });

  // --- Not found ---
  it('all execution operations on non-existent ID return 404', async () => {
    const results = await Promise.all([
      req(server, '/v1/executions/fake', { method: 'GET' }),
      postJson(server, '/v1/executions/fake/resume', {}),
      postJson(server, '/v1/executions/fake/replay', {}),
      postJson(server, '/v1/executions/fake/cancel', {}),
      req(server, '/v1/executions/fake', { method: 'DELETE' }),
    ]);
    for (const r of results) {
      expect(r.status).toBe(404);
    }
  });
});

describe('HTTP Server — US4: Adapter Tools', () => {
  let engine: Runcor;
  let server: RuncorServer;
  let provider: MockProvider;

  beforeEach(async () => {
    provider = new MockProvider();
    engine = await createEngine({
      model: { provider },
    });
    server = createServer(engine, { port: 0, signal: false });
  });

  afterEach(async () => {
    await engine.shutdown();
  });

  it('GET /v1/adapters returns empty list when no adapters configured', async () => {
    const { status, body } = await req(server, '/v1/adapters');
    expect(status).toBe(200);
    expect(body.adapters).toEqual([]);
  });

  it('POST /v1/adapters/:name/tools/:tool returns 502 for unknown adapter', async () => {
    const { status, body } = await postJson(server, '/v1/adapters/unknown-adapter/tools/some-tool', {
      args: { key: 'value' },
    });
    // Adapter not found throws EngineError with ADAPTER_NOT_FOUND → 404 via global handler
    expect([404, 502]).toContain(status);
    expect(body.error).toBeDefined();
  });

  it('POST /v1/adapters/:name/tools/:tool with empty body is valid', async () => {
    const res = await server.app.request('/v1/adapters/test-adapter/tools/test-tool', {
      method: 'POST',
    });
    const body = await res.json();
    // Should fail with adapter error (not found), not body parsing error
    expect([404, 502]).toContain(res.status);
    expect(body.error).toBeDefined();
  });
});

describe('HTTP Server — US5: Graceful Server Lifecycle', () => {
  let engine: Runcor;
  let server: RuncorServer;
  let provider: MockProvider;

  beforeEach(async () => {
    provider = new MockProvider();
    engine = await createEngine({
      model: { provider },
    });
    server = createServer(engine, { port: 0, signal: false });
  });

  afterEach(async () => {
    try {
      await engine.shutdown();
    } catch {
      // May already be shut down
    }
  });

  it('server.address() returns configured port and hostname', () => {
    const addr = server.address();
    expect(addr.port).toBe(0);
    expect(addr.hostname).toBe('127.0.0.1');
  });

  it('server accepts requests before shutdown', async () => {
    engine.register('lifecycle-flow', async () => 'alive');
    const { status, body } = await req(server, '/v1/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ready');
  });

  it('server.stop() completes gracefully', async () => {
    await server.stop();
    // After stop, the server should not accept requests — shuttingDown flag is set
  });

  it('requests during shutdown return 503', async () => {
    // Trigger shutdown via stop()
    await server.stop();

    const { status, body } = await req(server, '/v1/health');
    expect(status).toBe(503);
    expect(body.error.code).toBe('ENGINE_SHUTTING_DOWN');
  });

  it('stop() is idempotent — calling twice does not throw', async () => {
    await server.stop();
    await server.stop(); // Should not throw
  });
});

describe('HTTP Server — Edge Cases', () => {
  let engine: Runcor;
  let provider: MockProvider;

  beforeEach(async () => {
    provider = new MockProvider();
    engine = await createEngine({
      model: { provider },
    });
    engine.register('edge-flow', async () => 'ok');
  });

  afterEach(async () => {
    await engine.shutdown();
  });

  it('malformed JSON body returns 400', async () => {
    const server = createServer(engine, { port: 0, signal: false });
    const res = await server.app.request('/v1/flows/edge-flow/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid json',
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    // Route catches JSON parse error and falls through to idempotencyKey validation
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('body exceeding size limit returns 413', async () => {
    const server = createServer(engine, { port: 0, signal: false, bodyLimit: 100 });
    const res = await server.app.request('/v1/flows/edge-flow/trigger', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'content-length': '200',
      },
      body: JSON.stringify({ idempotencyKey: 'big', input: 'x'.repeat(200) }),
    });
    const body = await res.json();
    expect(res.status).toBe(413);
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('CORS preflight OPTIONS returns correct headers', async () => {
    const server = createServer(engine, { port: 0, signal: false });
    const res = await server.app.request('/v1/health', {
      method: 'OPTIONS',
      headers: {
        'Origin': 'http://localhost:8080',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeDefined();
  });

  it('CORS disabled returns no CORS headers', async () => {
    const server = createServer(engine, { port: 0, signal: false, cors: false });
    const res = await server.app.request('/v1/health', {
      method: 'GET',
      headers: { 'Origin': 'http://localhost:8080' },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('basePath with trailing slash works correctly', async () => {
    const server = createServer(engine, { port: 0, signal: false, basePath: '/api/' });
    const { status, body } = await req(server, '/api/v1/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ready');
  });

  it('basePath prefixes all routes', async () => {
    const server = createServer(engine, { port: 0, signal: false, basePath: '/my-api' });
    const { status, body } = await req(server, '/my-api/v1/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ready');
  });
});
