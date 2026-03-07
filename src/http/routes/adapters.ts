// Adapter routes: GET /v1/adapters, POST /v1/adapters/:name/tools/:tool

import { Hono } from 'hono';
import type { Runcor } from '../../engine.js';
import { EngineError } from '../../errors.js';
import { createErrorResponse } from '../errors.js';

export function createAdapterRoutes(engine: Runcor): Hono {
  const routes = new Hono();

  // GET /v1/adapters — list all adapters with connection states
  routes.get('/adapters', (c) => {
    const adapters = engine.listAdapters().map((a) => ({
      name: a.name,
      state: a.state,
      tools: a.tools.length,
      lastHealthCheck: a.lastHealthCheck,
      lastError: a.lastError,
    }));
    return c.json({ adapters });
  });

  // POST /v1/adapters/:name/tools/:tool — invoke an adapter tool
  routes.post('/adapters/:name/tools/:tool', async (c) => {
    const adapterName = c.req.param('name');
    const toolName = c.req.param('tool');

    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // Empty body is valid — no tool arguments
    }

    const args = (body.args as Record<string, unknown>) ?? {};
    const qualifiedName = `${adapterName}.${toolName}`;

    try {
      const result = await engine.callAdapterTool(qualifiedName, args);
      return c.json({ result });
    } catch (err) {
      if (err instanceof EngineError) {
        // Check for adapter-specific errors
        if (err.code === 'ADAPTER_NOT_CONNECTED' || err.code === 'ADAPTER_CIRCUIT_OPEN') {
          return c.json(
            createErrorResponse(err.code, err.message),
            502,
          );
        }
        throw err; // Let global error handler handle ADAPTER_NOT_FOUND, TOOL_NOT_FOUND etc
      }
      // Unknown adapter error → 502 (don't leak internal error details)
      return c.json(
        createErrorResponse('ADAPTER_ERROR', 'Adapter tool invocation failed'),
        502,
      );
    }
  });

  return routes;
}
