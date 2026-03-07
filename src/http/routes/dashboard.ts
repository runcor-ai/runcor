// GET /v1/dashboard — serves the built-in dashboard HTML
// Dashboard UI

import { Hono } from 'hono';
import { DASHBOARD_HTML } from '../dashboard-html.js';

export function createDashboardRoute(): Hono {
  const routes = new Hono();

  routes.get('/dashboard', (c) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:");
    return c.html(DASHBOARD_HTML);
  });

  return routes;
}
