// ManagedAdapter — wraps a single MCP adapter connection.
// Manages state machine, tool/resource discovery, circuit breaker, and call routing.

import type {
  AdapterConfig,
  AdapterState,
  AdapterToolSchema,
  AdapterResourceSchema,
  ToolCallResult,
  ResourceContent,
} from '../types.js';
import { CircuitBreaker } from '../model/circuit-breaker.js';
import { EngineError } from '../errors.js';

/**
 * Minimal MCP client interface used by ManagedAdapter.
 * In production this would be the real MCP SDK Client; for testing
 * it is provided via MCPClientFactory dependency injection.
 */
export interface MCPClient {
  listTools(): Promise<{ tools: AdapterToolSchema[] }>;
  listResources(): Promise<{ resources: AdapterResourceSchema[] }>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<ToolCallResult>;
  readResource(params: { uri: string }): Promise<{
    contents: Array<{
      uri: string;
      text?: string;
      blob?: string;
      mimeType?: string;
    }>;
  }>;
  close(): Promise<void>;
}

/** Minimal MCP transport interface */
export interface MCPTransport {
  close(): Promise<void>;
}

/**
 * Factory that creates an MCP client + transport from an AdapterConfig.
 * Defaults are not provided here — callers must supply a factory for now
 * (production factory will wrap the real MCP SDK).
 */
export interface MCPClientFactory {
  createClient(config: AdapterConfig): Promise<{
    client: MCPClient;
    transport: MCPTransport;
  }>;
}

/** Options for ManagedAdapter constructor beyond the required config. */
export interface ManagedAdapterOptions {
  /** Override the default MCP client factory (required for testing). */
  clientFactory?: MCPClientFactory;
}

/**
 * ManagedAdapter wraps one MCP adapter connection.
 *
 * Lifecycle: disconnected -> connecting -> connected | error
 *   connected -> disconnected (explicit disconnect)
 *   connected -> error (call failure / health check)
 *   error -> connecting -> connected (reconnection)
 */
export class ManagedAdapter {
  readonly config: AdapterConfig;

  private _state: AdapterState = 'disconnected';
  private readonly circuitBreaker: CircuitBreaker;
  private tools: AdapterToolSchema[] = [];
  private resources: AdapterResourceSchema[] = [];
  private lastHealthCheck: Date | null = null;
  private lastError: string | null = null;
  private client: MCPClient | null = null;
  private transport: MCPTransport | null = null;
  private healthCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private readonly clientFactory: MCPClientFactory | null;

  /** Callback for state changes */
  onStateChange?:
    | ((adapter: ManagedAdapter, from: AdapterState, to: AdapterState) => void)
    | undefined;

  /** Callback for tool discovery */
  onToolsDiscovered?:
    | ((adapter: ManagedAdapter, tools: string[]) => void)
    | undefined;

  constructor(config: AdapterConfig, options?: ManagedAdapterOptions) {
    this.config = config;
    this.clientFactory = options?.clientFactory ?? null;
    this.circuitBreaker = new CircuitBreaker(config.name, {
      failureThreshold: config.failureThreshold ?? 3,
      cooldownMs: config.cooldownMs ?? 30000,
    });
  }

  // ── Getters ──

  get state(): AdapterState {
    return this._state;
  }

  get name(): string {
    return this.config.name;
  }

  getTools(): AdapterToolSchema[] {
    return [...this.tools];
  }

  getResources(): AdapterResourceSchema[] {
    return [...this.resources];
  }

  getLastHealthCheck(): Date | null {
    return this.lastHealthCheck;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getConsecutiveFailures(): number {
    // Expose circuit breaker state indirectly through availability.
    // The circuit breaker doesn't expose failureCount directly, but
    // we track our own failure counter for the adapter info.
    return this._consecutiveFailures;
  }

  private _consecutiveFailures = 0;

  // ── State machine ──

  private transition(to: AdapterState): void {
    const from = this._state;
    if (from === to) return;
    this._state = to;
    this.onStateChange?.(this, from, to);

    // Trigger automatic reconnection when transitioning to 'error' from 'connected'
    if (to === 'error' && from === 'connected') {
      this.stopHealthCheckTimer();
      this.startReconnection();
    }
  }

  // ── Connect ──

  async connect(): Promise<void> {
    if (this._state === 'connected') return;
    if (this._state === 'connecting') return;

    this.transition('connecting');
    this.reconnectAttempt = 0;

    try {
      await this.performConnect();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown connection error';
      this.lastError = message;
      this._consecutiveFailures++;
      this.transition('error');
      throw new EngineError(
        `Adapter "${this.config.name}" failed to connect: ${message}`,
        'ADAPTER_NOT_CONNECTED',
      );
    }
  }

  private async performConnect(): Promise<void> {
    if (!this.clientFactory) {
      throw new Error(
        'No MCP client factory configured. Provide a clientFactory in ManagedAdapterOptions.',
      );
    }

    const { client, transport } = await this.clientFactory.createClient(
      this.config,
    );
    this.client = client;
    this.transport = transport;

    // Discover tools and resources
    const [toolsResult, resourcesResult] = await Promise.all([
      client.listTools(),
      client.listResources(),
    ]);

    this.tools = toolsResult.tools;
    this.resources = resourcesResult.resources;

    // Reset failure tracking on successful connect
    this._consecutiveFailures = 0;
    this.lastError = null;
    this.lastHealthCheck = new Date();

    this.transition('connected');

    // Fire tool discovery callback
    if (this.tools.length > 0 || this.onToolsDiscovered) {
      this.onToolsDiscovered?.(
        this,
        this.tools.map((t) => t.name),
      );
    }

    // Start health check timer if configured
    this.startHealthCheckTimer();
  }

  // ── Disconnect ──

  async disconnect(): Promise<void> {
    this.stopHealthCheckTimer();
    this.stopReconnectTimer();

    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Swallow close errors during disconnect
      }
      this.client = null;
    }

    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // Swallow close errors during disconnect
      }
      this.transport = null;
    }

    this.tools = [];
    this.resources = [];
    this.transition('disconnected');
  }

  // ── Tool calls ──

  async callTool(
    toolName: string,
    args?: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    if (this._state !== 'connected') {
      throw new EngineError(
        `Adapter "${this.config.name}" is not connected (state: ${this._state})`,
        'ADAPTER_NOT_CONNECTED',
      );
    }

    if (!this.circuitBreaker.isAvailable()) {
      throw new EngineError(
        `Adapter "${this.config.name}" circuit breaker is open`,
        'ADAPTER_CIRCUIT_OPEN',
      );
    }

    const timeoutMs = this.config.timeoutMs ?? 30000;

    try {
      const result = await this.withTimeout(
        this.client!.callTool({ name: toolName, arguments: args }),
        timeoutMs,
      );

      this.circuitBreaker.recordSuccess();
      this._consecutiveFailures = 0;
      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure();
      this._consecutiveFailures++;

      if (err instanceof EngineError && err.code === 'ADAPTER_TIMEOUT') {
        throw err;
      }

      const message =
        err instanceof Error ? err.message : 'Unknown tool call error';
      this.lastError = message;
      throw new EngineError(
        `Adapter "${this.config.name}" tool call "${toolName}" failed: ${message}`,
        'ADAPTER_NOT_CONNECTED',
      );
    }
  }

  // ── Resource reads ──

  async readResource(uri: string): Promise<ResourceContent> {
    if (this._state !== 'connected') {
      throw new EngineError(
        `Adapter "${this.config.name}" is not connected (state: ${this._state})`,
        'ADAPTER_NOT_CONNECTED',
      );
    }

    if (!this.circuitBreaker.isAvailable()) {
      throw new EngineError(
        `Adapter "${this.config.name}" circuit breaker is open`,
        'ADAPTER_CIRCUIT_OPEN',
      );
    }

    const timeoutMs = this.config.timeoutMs ?? 30000;

    try {
      const result = await this.withTimeout(
        this.client!.readResource({ uri }),
        timeoutMs,
      );

      this.circuitBreaker.recordSuccess();
      this._consecutiveFailures = 0;

      if (!result.contents || result.contents.length === 0) {
        throw new EngineError(
          `Resource "${uri}" returned no content from adapter "${this.config.name}"`,
          'RESOURCE_NOT_FOUND',
        );
      }

      const content = result.contents[0];
      return {
        uri: content.uri,
        text: content.text,
        blob: content.blob,
        mimeType: content.mimeType,
      };
    } catch (err) {
      if (err instanceof EngineError) {
        if (err.code !== 'ADAPTER_TIMEOUT') {
          this.circuitBreaker.recordFailure();
          this._consecutiveFailures++;
        }
        throw err;
      }

      this.circuitBreaker.recordFailure();
      this._consecutiveFailures++;

      const message =
        err instanceof Error ? err.message : 'Unknown resource read error';
      this.lastError = message;
      throw new EngineError(
        `Adapter "${this.config.name}" resource read "${uri}" failed: ${message}`,
        'ADAPTER_NOT_CONNECTED',
      );
    }
  }

  // ── Timeout utility ──

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new EngineError(
            `Adapter "${this.config.name}" operation timed out after ${ms}ms`,
            'ADAPTER_TIMEOUT',
          ),
        );
      }, ms);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  // ── Health check ──

  private startHealthCheckTimer(): void {
    const interval = this.config.healthCheckIntervalMs ?? 30000;
    if (interval <= 0) return;

    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck().catch(() => {
        // Health check failures are handled inside performHealthCheck
      });
    }, interval);
  }

  private async performHealthCheck(): Promise<void> {
    if (this._state !== 'connected' || !this.client) return;

    try {
      await this.client.listTools();
      this.lastHealthCheck = new Date();
    } catch {
      this.lastError = 'Health check failed';
      this._consecutiveFailures++;
      this.circuitBreaker.recordFailure();
      this.transition('error');
    }
  }

  private stopHealthCheckTimer(): void {
    if (this.healthCheckTimer !== null) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private stopReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Reconnection ──

  /**
   * Start automatic reconnection with exponential backoff.
   * Called when transitioning to 'error' state from 'connected'.
   *
   * Backoff formula: min(retryDelayMs * 2^attempt, 60000)
   * Max attempts: config.retryAttempts (default 3)
   */
  private startReconnection(): void {
    const maxAttempts = this.config.retryAttempts ?? 3;
    if (this.reconnectAttempt >= maxAttempts) {
      return; // Exhausted retries
    }

    // If circuit breaker is open (unhealthy), don't attempt reconnection yet.
    // The circuit breaker's cooldown will transition to half_open, at which
    // point we can try reconnecting.
    if (!this.circuitBreaker.isAvailable()) {
      return;
    }

    const baseDelay = this.config.retryDelayMs ?? 1000;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempt), 60000);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptReconnect().catch(() => {
        // Errors handled inside attemptReconnect
      });
    }, delay);
  }

  /**
   * Attempt a single reconnection. On success, transition to connected
   * and rediscover tools. On failure, increment attempt counter and
   * schedule the next reconnection.
   */
  private async attemptReconnect(): Promise<void> {
    if (this._state !== 'error') return;

    this.transition('connecting');

    try {
      await this.performConnect();
      // Success: reset reconnect attempt counter
      this.reconnectAttempt = 0;
      this.circuitBreaker.recordSuccess();
    } catch {
      // Failed: increment attempt, return to error state, schedule next try
      this.reconnectAttempt++;
      this._consecutiveFailures++;
      this.lastError = 'Reconnection failed';
      // Transition back to error — but don't re-trigger startReconnection
      // from the transition (only from === 'connected' triggers it)
      this._state = 'error';
      this.onStateChange?.(this, 'connecting', 'error');

      this.circuitBreaker.recordFailure();

      // Schedule next reconnection attempt
      this.startReconnection();
    }
  }

  /**
   * Get the current reconnect attempt count (for testing).
   */
  getReconnectAttempt(): number {
    return this.reconnectAttempt;
  }

  // ── Shutdown ──

  shutdown(): void {
    this.stopHealthCheckTimer();
    this.stopReconnectTimer();
    this.circuitBreaker.shutdown();
  }
}
