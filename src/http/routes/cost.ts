// GET /v1/cost/summary — aggregated cost data
// Dashboard UI

import { Hono } from 'hono';
import type { Runcor } from '../../engine.js';

export function createCostRoutes(engine: Runcor): Hono {
  const routes = new Hono();

  routes.get('/cost/summary', (c) => {
    const ledger = engine.getCostLedger();
    if (!ledger) {
      return c.json({
        total: 0,
        entryCount: 0,
        byFlow: [],
        byUser: [],
        byProvider: [],
      });
    }

    const entries = ledger.query({});
    const total = ledger.getTotal({});
    const entryCount = entries.length;

    // Aggregate by flow
    const flowMap = new Map<string, { cost: number; count: number }>();
    const userMap = new Map<string, { cost: number; count: number }>();
    const providerMap = new Map<string, { cost: number; count: number }>();

    for (const entry of entries) {
      // By flow
      const flow = flowMap.get(entry.flowName) ?? { cost: 0, count: 0 };
      flow.cost += entry.cost;
      flow.count++;
      flowMap.set(entry.flowName, flow);

      // By user
      const userId = entry.userId ?? 'system';
      const user = userMap.get(userId) ?? { cost: 0, count: 0 };
      user.cost += entry.cost;
      user.count++;
      userMap.set(userId, user);

      // By provider
      const prov = providerMap.get(entry.provider) ?? { cost: 0, count: 0 };
      prov.cost += entry.cost;
      prov.count++;
      providerMap.set(entry.provider, prov);
    }

    const toSorted = (map: Map<string, { cost: number; count: number }>) =>
      Array.from(map.entries())
        .map(([name, { cost, count }]) => ({ name, cost, count }))
        .sort((a, b) => b.cost - a.cost);

    // Map executionId → provider (first provider seen per execution)
    const execProvider: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.executionId && !execProvider[entry.executionId]) {
        execProvider[entry.executionId] = entry.provider;
      }
    }

    return c.json({
      total,
      entryCount,
      byFlow: toSorted(flowMap),
      byUser: toSorted(userMap),
      byProvider: toSorted(providerMap),
      execProviders: execProvider,
    });
  });

  return routes;
}
