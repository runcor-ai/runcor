// Flow routes: GET /v1/flows, POST /v1/flows/:name/trigger

import { Hono } from 'hono';
import type { Runcor } from '../../engine.js';
import { createErrorResponse } from '../errors.js';
import type { TriggerOptions } from '../../types.js';

export function createFlowRoutes(engine: Runcor): Hono {
  const routes = new Hono();

  // GET /v1/flows — list registered flows
  routes.get('/flows', (c) => {
    const flows = engine.listFlows().map((f) => ({
      name: f.name,
      config: f.config,
    }));
    return c.json({ flows });
  });

  // POST /v1/flows/:name/trigger — trigger a flow execution
  routes.post('/flows/:name/trigger', async (c) => {
    const flowName = c.req.param('name');

    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // Empty body is allowed — idempotencyKey is still required
    }

    // Validate required field
    const idempotencyKey = body.idempotencyKey;
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return c.json(
        createErrorResponse('VALIDATION_ERROR', 'Missing required field: idempotencyKey', {
          field: 'idempotencyKey',
          reason: 'required',
        }),
        400,
      );
    }

    // Extract known fields, ignore unknown (lenient parsing)
    const options: TriggerOptions = {
      idempotencyKey: idempotencyKey as string,
      input: body.input ?? null,
    };
    if (body.userId !== undefined) options.userId = body.userId as string;
    if (body.sessionId !== undefined) options.sessionId = body.sessionId as string;
    if (body.tenantId !== undefined) options.tenantId = body.tenantId as string;
    if (body.metadata !== undefined) options.metadata = body.metadata as Record<string, unknown>;
    if (body.timeout !== undefined) options.timeout = body.timeout as number;
    if (body.waitTimeout !== undefined) options.waitTimeout = body.waitTimeout as number;

    // Delegate to engine — EngineError is caught by global error handler
    const execution = await engine.trigger(flowName, options);
    return c.json({ execution }, 201);
  });

  return routes;
}
