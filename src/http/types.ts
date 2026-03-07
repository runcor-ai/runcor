// HTTP Server types for Runcor

import type { Hono } from 'hono';

/** CORS configuration options */
export interface CorsOptions {
  /** Allowed origins. Default: '*' */
  origin?: string | string[];
  /** Allowed HTTP methods. Default: ['GET','POST','DELETE','OPTIONS'] */
  methods?: string[];
  /** Allowed request headers. Default: ['Content-Type'] */
  headers?: string[];
}

/** Configuration for the HTTP server, passed to createServer() */
export interface ServerOptions {
  /** TCP port to listen on. Default: 3000. Use 0 for OS-assigned port. */
  port?: number;
  /** Hostname/IP to bind to. Default: '0.0.0.0' */
  hostname?: string;
  /** Optional prefix prepended before /v1/... (e.g., '/api' → '/api/v1/...') */
  basePath?: string;
  /** Maximum request body size in bytes. Default: 1048576 (1MB) */
  bodyLimit?: number;
  /** Time in ms to wait for connections to drain on shutdown. Default: 30000 */
  shutdownTimeout?: number;
  /** CORS configuration. true = permissive defaults, false = disabled, object = custom. Default: true */
  cors?: CorsOptions | boolean;
  /** Whether to register SIGTERM/SIGINT handlers for auto-shutdown. Default: true */
  signal?: boolean;
}

/** The running HTTP server instance returned by createServer() */
export interface RuncorServer {
  /** Returns the bound address after start() */
  address(): { port: number; hostname: string };
  /** Starts listening on the configured port */
  start(): Promise<void>;
  /** Graceful shutdown: stops accepting requests, drains connections, shuts down engine */
  stop(): Promise<void>;
  /** The underlying Hono app (for testing with app.request()) */
  app: Hono;
}

/** Standardized JSON error shape for all error responses */
export interface ErrorResponse {
  error: {
    /** Machine-readable error code (SCREAMING_SNAKE_CASE) */
    code: string;
    /** Human-readable error description */
    message: string;
    /** Additional context (validation errors, policy details). Null for simple errors. */
    details: Record<string, unknown> | null;
  };
}
