// SSE (Server-Sent Events) manager for Runcor HTTP Server

import type { Runcor } from '../engine.js';

/** Event category mapping: engine event name → SSE filter category */
const EVENT_CATEGORY_MAP: Record<string, string> = {
  'execution:state_change': 'execution',
  'execution:complete': 'execution',
  'cost:request': 'cost',
  'cost:budget_warning': 'cost',
  'cost:budget_exceeded': 'cost',
  'policy:violation': 'policy',
  'policy:warning': 'policy',
  'policy:rate_limited': 'policy',
  'eval:score': 'eval',
  'eval:complete': 'eval',
  'eval:flagged': 'eval',
  'adapter:connected': 'adapter',
  'adapter:disconnected': 'adapter',
  'adapter:error': 'adapter',
  'adapter:tools_discovered': 'adapter',
  'adapter:tool_call': 'adapter',
  'flow:registered': 'flow',
  'flow:unregistered': 'flow',
  'scheduler:trigger': 'scheduler',
  'scheduler:skip': 'scheduler',
  'scheduler:registered': 'scheduler',
  'scheduler:removed': 'scheduler',
};

/** Get the SSE category for an engine event */
export function getEventCategory(eventName: string): string | null {
  return EVENT_CATEGORY_MAP[eventName] ?? null;
}

/** Filters applied to an SSE connection */
export interface SSEFilters {
  /** Event categories to receive (null = all) */
  types: Set<string> | null;
  /** Filter to events for a specific execution (null = all) */
  executionId: string | null;
}

/** Internal connection tracking */
interface SSEConnection {
  id: string;
  writer: {
    writeSSE(event: { event?: string; data: string }): Promise<void>;
    write(data: string): Promise<void>;
    close(): Promise<void>;
  };
  filters: SSEFilters;
  connectedAt: Date;
}

/** SSE Manager — tracks connections and broadcasts events */
export interface SSEManager {
  addConnection(writer: SSEConnection['writer'], filters: SSEFilters): string;
  removeConnection(id: string): void;
  broadcast(eventType: string, data: unknown): void;
  shutdown(): void;
  getConnectionCount(): number;
}

let connectionCounter = 0;
const MAX_SSE_CONNECTIONS = 100;

/** Create an SSE manager that subscribes to engine events and fans out to clients */
export function createSSEManager(engine: Runcor): SSEManager {
  const connections = new Map<string, SSEConnection>();
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let isShutdown = false;
  const eventListeners: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

  // Start keepalive ping interval (30 seconds)
  pingInterval = setInterval(() => {
    for (const conn of connections.values()) {
      try {
        conn.writer.write(': ping\n\n').catch(() => {
          // Connection may have been closed — remove it
          connections.delete(conn.id);
        });
      } catch {
        connections.delete(conn.id);
      }
    }
  }, 30000);

  // Subscribe to all engine events and broadcast
  const eventHandler = (eventType: string, payload: unknown) => {
    if (isShutdown) return;
    manager.broadcast(eventType, payload);
  };

  // Subscribe to each known event type (store refs for cleanup)
  for (const eventName of Object.keys(EVENT_CATEGORY_MAP)) {
    const handler = (payload: unknown) => {
      eventHandler(eventName, payload);
    };
    engine.on(eventName as any, handler);
    eventListeners.push({ event: eventName, handler });
  }

  const manager: SSEManager = {
    addConnection(writer, filters) {
      if (connections.size >= MAX_SSE_CONNECTIONS) {
        throw new Error('Maximum SSE connections reached');
      }
      connectionCounter = (connectionCounter + 1) % Number.MAX_SAFE_INTEGER;
      const id = `sse-${connectionCounter}`;
      connections.set(id, { id, writer, filters, connectedAt: new Date() });
      return id;
    },

    removeConnection(id) {
      connections.delete(id);
    },

    broadcast(eventType, data) {
      const category = getEventCategory(eventType);
      if (!category) return; // Unknown event type — skip

      for (const conn of connections.values()) {
        // Check type filter
        if (conn.filters.types && !conn.filters.types.has(category)) {
          continue;
        }

        // Check executionId filter
        if (conn.filters.executionId) {
          const payload = data as Record<string, unknown>;
          if (payload.executionId !== conn.filters.executionId) {
            continue;
          }
        }

        // Write to client as unnamed SSE message with type embedded in JSON
        // (EventSource.onmessage only fires for unnamed events; named events
        // require dedicated addEventListener calls which the dashboard doesn't use)
        try {
          conn.writer.writeSSE({
            data: JSON.stringify({ type: eventType, ...(data as object) }),
          }).catch(() => {
            connections.delete(conn.id);
          });
        } catch {
          connections.delete(conn.id);
        }
      }
    },

    shutdown() {
      isShutdown = true;

      // Clear ping interval
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }

      // Remove engine event listeners to prevent memory leaks
      for (const { event, handler } of eventListeners) {
        engine.off(event as any, handler);
      }
      eventListeners.length = 0;

      // Send shutdown comment to all connections and close them
      for (const conn of connections.values()) {
        try {
          conn.writer.write(': shutdown\n\n').catch(() => {});
          conn.writer.close().catch(() => {});
        } catch {
          // Best effort
        }
      }
      connections.clear();
    },

    getConnectionCount() {
      return connections.size;
    },
  };

  return manager;
}
