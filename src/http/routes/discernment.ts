// GET /v1/discernment — discernment status, objectives, reports, recommendations
// Dashboard UI

import { Hono } from 'hono';
import type { Runcor } from '../../engine.js';

export function createDiscernmentRoutes(engine: Runcor): Hono {
  const routes = new Hono();

  routes.get('/discernment', (c) => {
    const capabilities = engine.getCapabilities();
    if (!capabilities.discernment) {
      return c.json({
        enabled: false,
        objectives: [],
        latestReport: null,
        recommendations: [],
      });
    }

    const objectives = engine.listObjectives();
    const reports = engine.listDiscernmentReports(1);
    const latestReport = reports.length > 0
      ? {
          id: reports[0].id,
          timestamp: reports[0].timestamp,
          autonomy: reports[0].autonomy,
          signalCount: reports[0].signals.length,
          recommendationCount: reports[0].recommendations.length,
        }
      : null;

    const recommendations = engine.getRecommendations()
      .filter((r) => r.status !== 'dismissed')
      .map((r) => ({
        id: r.id,
        target: r.target,
        targetType: r.targetType,
        action: r.action,
        confidence: r.confidence,
        explanation: r.explanation,
        status: r.status,
      }));

    return c.json({
      enabled: true,
      objectives,
      latestReport,
      recommendations,
    });
  });

  return routes;
}
