// GET /v1/events — Server-Sent Events stream

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SSEManager, SSEFilters } from '../sse.js';
import { createErrorResponse } from '../errors.js';

export function createEventRoutes(sseManager: SSEManager): Hono {
  const routes = new Hono();

  routes.get('/events', (c) => {
    // Parse query filters
    const typeParam = c.req.query('type');
    const executionId = c.req.query('executionId') || null;

    const types: Set<string> | null = typeParam
      ? new Set(typeParam.split(',').map((t) => t.trim()).filter(Boolean))
      : null;

    const filters: SSEFilters = { types, executionId };

    return streamSSE(c, async (stream) => {
      // Send initial connected comment
      await stream.write(': connected\n\n');

      // Register with SSE manager (may throw if at connection limit)
      let connectionId: string;
      try {
        connectionId = sseManager.addConnection(
        {
          writeSSE: async (event) => {
            await stream.writeSSE(event);
          },
          write: async (data) => {
            await stream.write(data);
          },
          close: async () => {
            // streamSSE handles close on return
          },
        },
        filters,
      );
      } catch {
        await stream.write(': error: max connections reached\n\n');
        return;
      }

      // Wait for abort signal (client disconnect)
      const abortPromise = new Promise<void>((resolve) => {
        stream.onAbort(() => {
          resolve();
        });
      });

      await abortPromise;
      sseManager.removeConnection(connectionId);
    });
  });

  return routes;
}
