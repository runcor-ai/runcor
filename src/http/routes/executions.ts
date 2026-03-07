// Execution routes: GET /v1/executions, GET /v1/executions/:id
// Plus routes: POST resume, replay, cancel; DELETE

import { Hono } from 'hono';
import type { Runcor } from '../../engine.js';
import { createErrorResponse } from '../errors.js';
import type { StateFilter } from '../../types.js';

export function createExecutionRoutes(engine: Runcor): Hono {
  const routes = new Hono();

  // GET /v1/executions — list with optional filters and pagination
  routes.get('/executions', async (c) => {
    const state = c.req.query('state') || undefined;
    const flowName = c.req.query('flowName') || undefined;
    const limitParam = c.req.query('limit');
    const offsetParam = c.req.query('offset');

    let limit = limitParam ? parseInt(limitParam, 10) : 50;
    if (isNaN(limit) || limit < 0) limit = 50;
    if (limit > 200) limit = 200;

    let offset = offsetParam ? parseInt(offsetParam, 10) : 0;
    if (isNaN(offset) || offset < 0) offset = 0;

    const filter: StateFilter = {};
    if (state) filter.state = state as import('../../types.js').ExecutionState;
    if (flowName) filter.flowName = flowName;

    const all = await engine.list(filter);
    const executions = all.slice(offset, offset + limit);

    return c.json({ executions });
  });

  // GET /v1/executions/:id — get single execution
  routes.get('/executions/:id', async (c) => {
    const id = c.req.param('id');
    const execution = await engine.getExecution(id);
    if (!execution) {
      return c.json(
        createErrorResponse('EXECUTION_NOT_FOUND', 'Execution not found'),
        404,
      );
    }
    return c.json({ execution });
  });

  // GET /v1/executions/:id/detail — composite view with cost + eval
  routes.get('/executions/:id/detail', async (c) => {
    const id = c.req.param('id');
    const execution = await engine.getExecution(id);
    if (!execution) {
      return c.json(
        createErrorResponse('EXECUTION_NOT_FOUND', 'Execution not found'),
        404,
      );
    }

    // Cost entries for this execution
    const ledger = engine.getCostLedger();
    const costEntries = ledger ? ledger.query({ executionId: id }) : null;

    // Evaluation record for this execution
    const evaluation = engine.getEvaluation(id);

    return c.json({ execution, costEntries, evaluation });
  });

  // POST /v1/executions/:id/resume — resume a waiting execution
  routes.post('/executions/:id/resume', async (c) => {
    const id = c.req.param('id');

    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // Empty body is valid — resume with no data
    }

    const execution = await engine.resume(id, body.resumeData);
    return c.json({ execution });
  });

  // POST /v1/executions/:id/replay — replay a terminal execution
  routes.post('/executions/:id/replay', async (c) => {
    const id = c.req.param('id');
    const execution = await engine.replay(id);
    return c.json({ execution }, 201);
  });

  // POST /v1/executions/:id/cancel — cancel an active execution
  routes.post('/executions/:id/cancel', async (c) => {
    const id = c.req.param('id');

    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // Empty body is valid
    }

    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    await engine.cancel(id, reason);

    // Re-fetch the execution to return updated state
    const execution = await engine.getExecution(id);
    return c.json({ execution });
  });

  // DELETE /v1/executions/:id — delete a terminal execution
  routes.delete('/executions/:id', async (c) => {
    const id = c.req.param('id');
    await engine.deleteExecution(id);
    return c.json({ deleted: true, id });
  });

  return routes;
}
