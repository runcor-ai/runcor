// In-process MCP adapter (v0.3.0, V2-002).
//
// Provides an MCPClientFactory that wraps `AdapterConfig.tools` (with handlers) into a synthetic
// MCP client. No subprocess, no network — tool calls dispatch directly to the handler functions
// inline. Use when an adapter needs to live in the same Node process as the engine (e.g., V2's
// local action set, runcor-integration's synthesised SQLite-schema tools).
//
// Usage:
//
//   const inProcessFactory = createInProcessClientFactory();
//   const adapterFactory: AdapterFactory = (config) => {
//     if (config.transport === 'in-process') {
//       return new ManagedAdapter(config, { clientFactory: inProcessFactory });
//     }
//     // ...dispatch other transports...
//   };
//   const engine = createEngine({ ..., adapterManagerOptions: { createAdapter: adapterFactory } });
//
// The engine doesn't auto-wire this factory — consumers compose it with their other transport
// factories. This keeps the engine transport-agnostic.

import type {
  AdapterConfig,
  AdapterToolDefinition,
  ToolCallResult,
} from '../types.js';
import type {
  MCPClient,
  MCPClientFactory,
  MCPTransport,
} from './managed-adapter.js';
import { EngineError } from '../errors.js';

/**
 * Build an MCPClient that dispatches tool calls to inline handlers from `config.tools`.
 * The client's `listTools` returns the tool list (without handler functions); `callTool`
 * looks up the handler by name and invokes it; `listResources` returns empty; `readResource`
 * throws (in-process adapters do not support resources in this version); `close` is a no-op.
 */
function buildInProcessClient(tools: AdapterToolDefinition[]): MCPClient {
  const handlers = new Map<string, AdapterToolDefinition['handler']>();
  for (const tool of tools) {
    handlers.set(tool.name, tool.handler);
  }

  return {
    async listTools() {
      return {
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      };
    },
    async listResources() {
      return { resources: [] };
    },
    async callTool(params: {
      name: string;
      arguments?: Record<string, unknown>;
    }): Promise<ToolCallResult> {
      const handler = handlers.get(params.name);
      if (!handler) {
        throw new EngineError(
          `In-process adapter: tool "${params.name}" is not registered.`,
          'TOOL_NOT_FOUND',
        );
      }
      return handler(params.arguments ?? {});
    },
    async readResource() {
      throw new EngineError(
        'In-process adapters do not support resource reads in v0.3.0.',
        'NOT_IMPLEMENTED',
      );
    },
    async close() {
      // No-op — in-process adapters have no transport to close.
    },
  };
}

/** Synthetic transport that does nothing (no IPC, no network). */
const NULL_TRANSPORT: MCPTransport = {
  async close() {
    // No-op
  },
};

/**
 * Build an `MCPClientFactory` for in-process adapters. The returned factory expects
 * `config.transport === 'in-process'` and `config.tools` to be a non-empty array; throws
 * EngineError otherwise. Health checks succeed unconditionally (the in-process adapter
 * is always "available" as long as the process is running).
 */
export function createInProcessClientFactory(): MCPClientFactory {
  return {
    async createClient(config: AdapterConfig) {
      if (config.transport !== 'in-process') {
        throw new EngineError(
          `createInProcessClientFactory: expected transport 'in-process', got '${config.transport}'.`,
          'INVALID_ADAPTER_CONFIG',
        );
      }
      if (!config.tools || config.tools.length === 0) {
        throw new EngineError(
          `In-process adapter "${config.name}" has no tools configured.`,
          'INVALID_ADAPTER_CONFIG',
        );
      }
      return {
        client: buildInProcessClient(config.tools),
        transport: NULL_TRANSPORT,
      };
    },
  };
}
