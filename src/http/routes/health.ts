// GET /v1/health route

import { Hono } from 'hono';
import type { Runcor } from '../../engine.js';

export function createHealthRoutes(engine: Runcor, startTime: number): Hono {
  const routes = new Hono();

  routes.get('/health', (c) => {
    const status = engine.getStatus();
    const flows = engine.listFlows().length;
    const adapters = engine.listAdapters().length;
    const uptime = Date.now() - startTime;

    const capabilities = engine.getCapabilities();

    return c.json({ status, uptime, flows, adapters, capabilities });
  });

  return routes;
}
