// GET /v1/providers — provider health status
// Dashboard UI

import { Hono } from 'hono';
import type { Runcor } from '../../engine.js';

export function createProviderRoutes(engine: Runcor): Hono {
  const routes = new Hono();

  routes.get('/providers', (c) => {
    const health = engine.getProviderHealth();

    const providers = health.map((p) => ({
      name: p.name,
      healthState: p.healthState,
      priority: p.priority,
    }));

    return c.json({ providers });
  });

  return routes;
}
