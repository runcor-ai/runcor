// HTTP Server factory for Runcor

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Runcor } from '../engine.js';
import { EngineError } from '../errors.js';
import { mapEngineError, createErrorResponse } from './errors.js';
import { createHealthRoutes } from './routes/health.js';
import { createFlowRoutes } from './routes/flows.js';
import { createExecutionRoutes } from './routes/executions.js';
import { createAdapterRoutes } from './routes/adapters.js';
import { createEventRoutes } from './routes/events.js';
import { createProviderRoutes } from './routes/providers.js';
import { createCostRoutes } from './routes/cost.js';
import { createDiscernmentRoutes } from './routes/discernment.js';
import { createDashboardRoute } from './routes/dashboard.js';
import { createSSEManager } from './sse.js';
import type { SSEManager } from './sse.js';
import type { ServerOptions, RuncorServer, CorsOptions } from './types.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const DEFAULT_PORT = 3000;
const DEFAULT_HOSTNAME = '127.0.0.1';
const DEFAULT_BODY_LIMIT = 1048576; // 1MB
const DEFAULT_SHUTDOWN_TIMEOUT = 30000; // 30s

/** Create an HTTP server wrapping a Runcor engine instance */
export function createServer(engine: Runcor, options?: ServerOptions): RuncorServer {
  const port = options?.port ?? DEFAULT_PORT;
  const hostname = options?.hostname ?? DEFAULT_HOSTNAME;
  const bodyLimit = options?.bodyLimit ?? DEFAULT_BODY_LIMIT;
  const shutdownTimeout = options?.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT;
  const signalHandling = options?.signal ?? true;
  const corsOption = options?.cors ?? true;

  // Normalize basePath: strip trailing slash, treat '/' as empty
  let basePath = (options?.basePath ?? '').replace(/\/+$/, '');
  if (basePath === '/') basePath = '';

  const app = new Hono();
  let shuttingDown = false;
  let httpServer: { close: (callback?: () => void) => void } | null = null;
  let boundPort = port;
  const boundHostname = hostname;
  const signalHandlers: Array<[string, () => void]> = [];
  let sseManager: SSEManager | null = null;
  let stopCalled = false;
  const startTime = Date.now();

  // CORS middleware
  if (corsOption !== false) {
    const corsConfig: CorsOptions = typeof corsOption === 'object' ? corsOption : {};
    const origin = corsConfig.origin ?? '*';
    app.use('*', cors({
      origin: Array.isArray(origin) ? origin : origin,
      allowMethods: corsConfig.methods ?? ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: corsConfig.headers ?? ['Content-Type'],
    }));

    if (origin === '*') {
      console.warn('[runcor] WARNING: CORS origin is set to "*" (allow all). This is not recommended for production. Configure specific origins via server.cors.origin in runcor.yaml.');
    }
  }

  // Authentication middleware — when AUTH_TOKEN is set, require Bearer token
  // on all mutating endpoints (POST, DELETE). Read-only endpoints remain open.
  const authToken = process.env.AUTH_TOKEN;
  if (authToken) {
    app.use('*', async (c, next) => {
      const method = c.req.method;
      if (method === 'POST' || method === 'DELETE' || method === 'PUT' || method === 'PATCH') {
        const authHeader = c.req.header('authorization');
        if (!authHeader || authHeader !== `Bearer ${authToken}`) {
          return c.json(
            createErrorResponse('UNAUTHORIZED', 'Invalid or missing Authorization header'),
            401,
          );
        }
      }
      return next();
    });
  }

  // Shutdown-aware middleware — return 503 for new requests during shutdown
  app.use('*', async (c, next) => {
    if (shuttingDown) {
      return c.json(
        createErrorResponse('ENGINE_SHUTTING_DOWN', 'Server is shutting down'),
        503,
      );
    }
    return next();
  });

  // Body size limit middleware — checks Content-Length header and actual body size
  app.use('*', async (c, next) => {
    const contentLength = c.req.header('content-length');
    if (contentLength && parseInt(contentLength, 10) > bodyLimit) {
      return c.json(
        createErrorResponse('PAYLOAD_TOO_LARGE', `Request body exceeds maximum size of ${bodyLimit} bytes`),
        413,
      );
    }
    // For requests without Content-Length (e.g. chunked), verify actual body size
    const method = c.req.method;
    if ((method === 'POST' || method === 'PUT' || method === 'PATCH') && !contentLength) {
      try {
        const body = await c.req.arrayBuffer();
        if (body.byteLength > bodyLimit) {
          return c.json(
            createErrorResponse('PAYLOAD_TOO_LARGE', `Request body exceeds maximum size of ${bodyLimit} bytes`),
            413,
          );
        }
      } catch {
        // If body can't be read, let downstream handlers deal with it
      }
    }
    return next();
  });

  // Global error handler
  app.onError((err, c) => {
    if (err instanceof EngineError) {
      const status = mapEngineError(err);
      return c.json(createErrorResponse(err.code, err.message), status as ContentfulStatusCode);
    }
    if (err instanceof SyntaxError && err.message.includes('JSON')) {
      return c.json(
        createErrorResponse('INVALID_JSON', 'Malformed JSON in request body'),
        400,
      );
    }
    return c.json(
      createErrorResponse('INTERNAL_ERROR', 'An unexpected error occurred'),
      500,
    );
  });

  // Route prefix
  const prefix = `${basePath}/v1`;

  // Create SSE manager for event streaming
  const sseMgr = createSSEManager(engine);
  sseManager = sseMgr;

  // Mount route groups
  app.route(prefix, createHealthRoutes(engine, startTime));
  app.route(prefix, createFlowRoutes(engine));
  app.route(prefix, createExecutionRoutes(engine));
  app.route(prefix, createAdapterRoutes(engine));
  app.route(prefix, createEventRoutes(sseMgr));
  app.route(prefix, createProviderRoutes(engine));
  app.route(prefix, createCostRoutes(engine));
  app.route(prefix, createDiscernmentRoutes(engine));
  app.route(prefix, createDashboardRoute());

  const server: RuncorServer = {
    app,
    address() {
      return { port: boundPort, hostname: boundHostname };
    },
    async start() {
      const { serve } = await import('@hono/node-server');

      await new Promise<void>((resolve, reject) => {
        try {
          httpServer = serve({
            fetch: app.fetch,
            port,
            hostname,
          }, (info) => {
            boundPort = info.port;
            resolve();
          });
        } catch (err) {
          reject(err);
        }
      });

      // Register signal handlers if enabled
      if (signalHandling) {
        const handler = () => {
          server.stop();
        };
        process.on('SIGTERM', handler);
        process.on('SIGINT', handler);
        signalHandlers.push(['SIGTERM', handler], ['SIGINT', handler]);
      }
    },
    async stop() {
      if (stopCalled) return; // Idempotent
      stopCalled = true;
      shuttingDown = true;

      // Close SSE connections with shutdown comment
      if (sseManager) {
        sseManager.shutdown();
      }

      // Close HTTP listener to stop accepting new connections
      if (httpServer) {
        const srv = httpServer;
        await new Promise<void>((resolve) => {
          srv.close(() => resolve());
          setTimeout(resolve, shutdownTimeout);
        });
      }

      // Shut down the engine
      await engine.shutdown();

      // Clean up signal handlers
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
      signalHandlers.length = 0;
    },
  };

  return server;
}
