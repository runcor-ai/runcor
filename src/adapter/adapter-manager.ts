// AdapterManager — orchestrates adapter lifecycle, tool routing, and resource caching.

import type {
  AdapterConfig,
  AdapterInfo,
  AdapterToolInfo,
  ToolCallResult,
  ResourceContent,
  AdapterManagerConfig,
} from '../types.js';
import { EngineError } from '../errors.js';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import { ToolRouter } from './tool-router.js';
import { ResourceCache } from './resource-cache.js';
import { ManagedAdapter } from './managed-adapter.js';
import type { EngineInstrumentation } from '../telemetry/instrumentation.js';

/**
 * Redact sensitive fields from an AdapterConfig for safe logging/telemetry.
 * Strips `headers` and replaces with '[REDACTED]' marker.
 */
function redactSecrets(config: AdapterConfig): Record<string, unknown> {
  const { headers, ...safe } = config;
  return { ...safe, headers: headers ? '[REDACTED]' : undefined };
}

/** Factory function type for creating ManagedAdapter instances. */
type AdapterFactory = (config: AdapterConfig) => ManagedAdapter;

/**
 * Manages the lifecycle of MCP adapter connections, routes tool calls,
 * and caches resource reads.
 *
 * Instantiated 1:1 with the Runcor engine. When no adapters are configured,
 * all methods are effectively no-ops (zero-adapter default).
 */
export class AdapterManager {
  private readonly adapters = new Map<string, ManagedAdapter>();
  private readonly toolRouter = new ToolRouter();
  private readonly resourceCache = new ResourceCache();
  private readonly instrumentation: EngineInstrumentation;
  private readonly emitEvent: (type: string, payload: unknown) => void;
  private readonly createAdapter: AdapterFactory;

  constructor(
    config: AdapterManagerConfig | undefined,
    instrumentation: EngineInstrumentation,
    emitEvent: (type: string, payload: unknown) => void,
    createAdapter?: AdapterFactory,
  ) {
    this.instrumentation = instrumentation;
    this.emitEvent = emitEvent;
    this.createAdapter = createAdapter ?? ((c: AdapterConfig) => new ManagedAdapter(c));

    // Note: startup adapters from config.adapters are NOT auto-connected here.
    // The engine is responsible for calling addAdapter() for each during initialization.
    // This keeps the constructor synchronous and testable.
  }

  // ── Validation ──

  /**
   * Validate an AdapterConfig before attempting to connect.
   * Throws EngineError with descriptive code on validation failure.
   */
  private validateConfig(config: AdapterConfig): void {
    if (!config.name || config.name.trim().length === 0) {
      throw new EngineError(
        'Adapter name must be a non-empty string.',
        'INVALID_ADAPTER_CONFIG',
      );
    }

    if (config.transport === 'stdio' && !config.command) {
      throw new EngineError(
        `Adapter "${config.name}": stdio transport requires a "command" field.`,
        'INVALID_ADAPTER_CONFIG',
      );
    }

    if (config.transport === 'sse' && !config.url) {
      throw new EngineError(
        `Adapter "${config.name}": sse transport requires a "url" field.`,
        'INVALID_ADAPTER_CONFIG',
      );
    }

    if (config.transport === 'in-process' && (!config.tools || config.tools.length === 0)) {
      throw new EngineError(
        `Adapter "${config.name}": in-process transport requires a non-empty "tools" field.`,
        'INVALID_ADAPTER_CONFIG',
      );
    }
  }

  // ── Adapter Lifecycle ──

  /**
   * Register and connect an adapter.
   *
   * - Validates config (name non-empty, transport-specific required fields)
   * - Checks for duplicate name -> throws DUPLICATE_ADAPTER
   * - Creates ManagedAdapter, connects, registers discovered tools
   * - Emits adapter:connected event on success
   *
   * @throws EngineError DUPLICATE_ADAPTER if name already registered
   * @throws EngineError INVALID_ADAPTER_CONFIG if config is invalid
   */
  async addAdapter(config: AdapterConfig): Promise<void> {
    this.validateConfig(config);

    if (this.adapters.has(config.name)) {
      throw new EngineError(
        `Adapter "${config.name}" is already registered.`,
        'DUPLICATE_ADAPTER',
      );
    }

    const adapter = this.createAdapter(config);

    // Set up state change callback
    adapter.onStateChange = (_adapter, _from, to) => {
      if (to === 'connected') {
        this.emitEvent('adapter:connected', { name: config.name });
      } else if (to === 'disconnected') {
        this.emitEvent('adapter:disconnected', { name: config.name });
      } else if (to === 'error') {
        this.emitEvent('adapter:error', {
          name: config.name,
          error: adapter.getLastError() ?? 'Unknown error',
        });
      }
    };

    // Set up tools discovered callback
    adapter.onToolsDiscovered = (_adapter, toolNames) => {
      // Re-register tools in ToolRouter
      this.toolRouter.unregister(config.name);
      this.toolRouter.register(config.name, adapter.getTools());
      this.emitEvent('adapter:tools_discovered', {
        name: config.name,
        tools: toolNames,
      });
    };

    // Connect the adapter
    const { span } = this.instrumentation.startAdapterConnectSpan(
      config.name,
      config.transport,
    );

    try {
      await adapter.connect();

      // Register discovered tools in ToolRouter
      const tools = adapter.getTools();
      if (tools.length > 0) {
        this.toolRouter.register(config.name, tools);
      }

      // Store the adapter
      this.adapters.set(config.name, adapter);

      // Track connection metric
      this.instrumentation.incrementAdapterConnections();

      this.instrumentation.endSpanWithSuccess(span);

      this.instrumentation.log('info', `Adapter "${config.name}" connected`, {
        adapter: config.name,
        transport: config.transport,
        toolCount: tools.length,
      }, span);
    } catch (err) {
      this.instrumentation.endSpanWithError(
        span,
        err instanceof Error ? err : new Error(String(err)),
      );

      this.instrumentation.log('error', `Failed to connect adapter "${config.name}"`, {
        adapter: config.name,
        config: redactSecrets(config),
        error: err instanceof Error ? err.message : String(err),
      }, span);

      throw err;
    }
  }

  /**
   * Unregister and disconnect an adapter.
   *
   * - Unregisters tools from ToolRouter
   * - Clears resource cache for this adapter
   * - Disconnects the adapter
   * - No-op if adapter not found
   */
  async removeAdapter(name: string): Promise<void> {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      return; // No-op for non-existent adapter
    }

    // Unregister tools
    this.toolRouter.unregister(name);

    // Clear resource cache
    this.resourceCache.clearAdapter(name);

    // Disconnect
    try {
      await adapter.disconnect();
    } catch {
      // Best-effort disconnect — don't let cleanup failures bubble up
    }

    // Remove from Map
    this.adapters.delete(name);

    // Track connection metric
    this.instrumentation.decrementAdapterConnections();
  }

  // ── Info Queries ──

  /**
   * Get runtime info for a specific adapter.
   * Returns null if adapter not found.
   */
  getAdapterInfo(name: string): AdapterInfo | null {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      return null;
    }

    return this.buildAdapterInfo(adapter);
  }

  /**
   * Get runtime info for all registered adapters.
   */
  listAdapters(): AdapterInfo[] {
    const result: AdapterInfo[] = [];
    for (const adapter of this.adapters.values()) {
      result.push(this.buildAdapterInfo(adapter));
    }
    return result;
  }

  /** Build an AdapterInfo snapshot from a ManagedAdapter's getters. */
  private buildAdapterInfo(adapter: ManagedAdapter): AdapterInfo {
    return {
      name: adapter.name,
      state: adapter.state,
      tools: adapter.getTools(),
      resources: adapter.getResources(),
      lastHealthCheck: adapter.getLastHealthCheck(),
      lastError: adapter.getLastError(),
      consecutiveFailures: adapter.getConsecutiveFailures(),
    };
  }

  /**
   * Check whether any adapters are registered.
   */
  hasAdapters(): boolean {
    return this.adapters.size > 0;
  }

  // ── Tool Operations ──

  /**
   * Call a tool by its fully-qualified name (adapterName.toolName).
   *
   * - Parses the qualified name (splits on first '.')
   * - Resolves the adapter via ToolRouter
   * - Delegates to ManagedAdapter.callTool()
   * - Emits adapter:tool_call event
   * - Records telemetry span and metrics
   *
   * @throws EngineError TOOL_NOT_FOUND if the tool is not registered
   * @throws EngineError ADAPTER_NOT_FOUND if the adapter does not exist in the Map
   */
  async callTool(
    qualifiedName: string,
    args?: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    // Resolve the adapter via ToolRouter
    const adapterName = this.toolRouter.resolve(qualifiedName);
    if (adapterName === null) {
      throw new EngineError(
        `Tool "${qualifiedName}" is not registered on any adapter.`,
        'TOOL_NOT_FOUND',
      );
    }

    // Get the adapter
    const adapter = this.adapters.get(adapterName);
    if (!adapter) {
      throw new EngineError(
        `Adapter "${adapterName}" not found.`,
        'ADAPTER_NOT_FOUND',
      );
    }

    // Extract tool name from qualified name (everything after first '.')
    const dotIndex = qualifiedName.indexOf('.');
    const toolName = dotIndex >= 0 ? qualifiedName.slice(dotIndex + 1) : qualifiedName;

    // Start telemetry span
    const { span, context: spanCtx } = this.instrumentation.startAdapterToolCallSpan(
      // Use the active context as parent (import not needed - startAdapterToolCallSpan
      // takes a parent context, we use a fresh root context via the internal method)
      ROOT_CONTEXT,
      adapterName,
      toolName,
    );

    const startTime = Date.now();
    let success = true;

    try {
      const result = await adapter.callTool(toolName, args);

      this.instrumentation.endSpanWithSuccess(span);

      return result;
    } catch (err) {
      success = false;

      this.instrumentation.endSpanWithError(
        span,
        err instanceof Error ? err : new Error(String(err)),
      );

      throw err;
    } finally {
      const durationMs = Date.now() - startTime;

      // Record metrics
      this.instrumentation.recordAdapterToolCall(
        adapterName,
        toolName,
        success ? 'success' : 'error',
        durationMs,
      );

      // Emit event
      this.emitEvent('adapter:tool_call', {
        adapter: adapterName,
        tool: toolName,
        durationMs,
        success,
      });
    }
  }

  /**
   * List all available tools, optionally filtered by adapter name.
   * Only includes tools from adapters in the 'connected' state.
   */
  listTools(filter?: { adapter?: string }): AdapterToolInfo[] {
    // Get tools from ToolRouter
    const allTools = this.toolRouter.list(filter);

    // Filter to only include tools from connected adapters
    return allTools.filter((tool) => {
      const adapter = this.adapters.get(tool.adapterName);
      return adapter !== undefined && adapter.state === 'connected';
    });
  }

  // ── Resource Operations ──

  /**
   * Read a resource from a specific adapter by URI.
   * Uses the ResourceCache for TTL-based caching.
   *
   * @throws EngineError ADAPTER_NOT_FOUND if adapter doesn't exist
   */
  async readResource(
    adapterName: string,
    uri: string,
  ): Promise<ResourceContent> {
    const adapter = this.adapters.get(adapterName);
    if (!adapter) {
      throw new EngineError(
        `Adapter "${adapterName}" not found.`,
        'ADAPTER_NOT_FOUND',
      );
    }

    // Check cache
    const cached = this.resourceCache.get(adapterName, uri);
    if (cached !== null) {
      return cached;
    }

    // Start telemetry span
    const { span } = this.instrumentation.startAdapterResourceReadSpan(
      ROOT_CONTEXT,
      adapterName,
      uri,
    );

    try {
      const content = await adapter.readResource(uri);

      // Cache the result
      const ttl = adapter.config.resourceCacheTtlMs ?? 60_000;
      if (ttl > 0) {
        this.resourceCache.set(adapterName, uri, content, ttl);
      }

      this.instrumentation.endSpanWithSuccess(span);

      return content;
    } catch (err) {
      this.instrumentation.endSpanWithError(
        span,
        err instanceof Error ? err : new Error(String(err)),
      );
      throw err;
    }
  }

  // ── Lifecycle ──

  /**
   * Gracefully shut down all adapters.
   * Disconnects each adapter, clears tools and resource cache.
   */
  async shutdown(): Promise<void> {
    const names = Array.from(this.adapters.keys());

    for (const name of names) {
      await this.removeAdapter(name);
    }

    this.resourceCache.clearAll();
  }
}
