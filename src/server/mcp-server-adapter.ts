// MCPServerAdapter — bridges the Runcor engine and MCP protocol

import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { MCPServerConfig } from './types.js';
import type { Runcor } from '../engine.js';
import type { Flow, TriggerOptions } from '../types.js';

/** Identity fields extracted from MCP tool call arguments */
interface ExtractedIdentity {
  userId?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
}

/** Result of extractIdentity: separated identity context and flow input */
interface IdentityExtractionResult {
  identity: ExtractedIdentity;
  flowInput: unknown;
}

/**
 * Extract _userId, _tenantId, _metadata from tool call arguments.
 * Returns separated identity context and remaining flow input.
 * Throws on invalid identity field types.
 */
export function extractIdentity(args: unknown): IdentityExtractionResult {
  if (args === null || args === undefined || typeof args !== 'object') {
    return { identity: {}, flowInput: undefined };
  }

  const argsObj = args as Record<string, unknown>;
  const identity: ExtractedIdentity = {};
  const remaining: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(argsObj)) {
    if (key === '_userId') {
      if (value !== undefined && typeof value !== 'string') {
        throw new Error('_userId must be a string');
      }
      if (value !== undefined) identity.userId = value as string;
    } else if (key === '_tenantId') {
      if (value !== undefined && typeof value !== 'string') {
        throw new Error('_tenantId must be a string');
      }
      if (value !== undefined) identity.tenantId = value as string;
    } else if (key === '_metadata') {
      if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
        throw new Error('_metadata must be an object');
      }
      if (value !== undefined) identity.metadata = value as Record<string, unknown>;
    } else {
      remaining[key] = value;
    }
  }

  const hasRemaining = Object.keys(remaining).length > 0;
  return {
    identity,
    flowInput: hasRemaining ? remaining : undefined,
  };
}

/**
 * Serialize a flow result for MCP response
 */
function serializeResult(result: unknown): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  return JSON.stringify(result);
}

/**
 * MCPServerAdapter — exposes Runcor flows as MCP tools via stdio transport.
 * Thin translation layer: all execution, retries, policy, etc. happen in the engine.
 */
export class MCPServerAdapter {
  private readonly engine: Runcor;
  private readonly config: MCPServerConfig;
  private mcpServer: InstanceType<typeof McpServer> | null = null;
  private transport: InstanceType<typeof StdioServerTransport> | null = null;
  private running = false;

  // Track tool registrations for dynamic removal
  private readonly toolRegistrations = new Map<string, { remove: () => void }>();

  // Event listener references for cleanup
  private flowRegisteredHandler: ((event: { name: string }) => void) | null = null;
  private flowUnregisteredHandler: ((event: { name: string }) => void) | null = null;

  constructor(engine: Runcor, config: MCPServerConfig) {
    this.engine = engine;
    this.config = config;
  }

  /** Whether the MCP server is currently running */
  isRunning(): boolean {
    return this.running;
  }

  /** Start the MCP server */
  async start(): Promise<void> {
    const serverName = this.config.name ?? 'runcor';
    const serverVersion = this.config.version ?? '0.0.0';

    // Create MCP server with capabilities
    this.mcpServer = new McpServer(
      { name: serverName, version: serverVersion },
      { capabilities: { tools: {} } },
    );

    // Register all current flows as tools
    const flows = this.engine.listFlows();
    for (const flow of flows) {
      this.registerFlowAsTool(flow);
    }

    // Subscribe to dynamic flow events
    this.flowRegisteredHandler = (event: { name: string }) => {
      this.onFlowRegistered(event.name);
    };
    this.flowUnregisteredHandler = (event: { name: string }) => {
      this.onFlowUnregistered(event.name);
    };
    this.engine.on('flow:registered', this.flowRegisteredHandler as any);
    this.engine.on('flow:unregistered', this.flowUnregisteredHandler as any);

    // Create transport and connect
    this.transport = new StdioServerTransport();
    await this.mcpServer.connect(this.transport);

    this.running = true;

    // Log server start
    this.log('info', 'MCP server started', { name: serverName, version: serverVersion });
  }

  /** Stop the MCP server */
  async stop(): Promise<void> {
    if (!this.running) return;

    // Remove event listeners
    if (this.flowRegisteredHandler) {
      this.engine.off('flow:registered', this.flowRegisteredHandler as any);
      this.flowRegisteredHandler = null;
    }
    if (this.flowUnregisteredHandler) {
      this.engine.off('flow:unregistered', this.flowUnregisteredHandler as any);
      this.flowUnregisteredHandler = null;
    }

    // Close MCP server and transport
    if (this.mcpServer) {
      await this.mcpServer.close();
      this.mcpServer = null;
    }
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }

    this.toolRegistrations.clear();
    this.running = false;

    // Log server stop
    this.log('info', 'MCP server stopped', {});
  }

  /** Register a single flow as an MCP tool */
  private registerFlowAsTool(flow: Flow): void {
    if (!this.mcpServer) return;

    const toolName = flow.name;
    const description = flow.description ?? flow.name;
    const inputSchema = flow.inputSchema;

    const registration = this.mcpServer.tool(
      toolName,
      description,
      inputSchema,
      async (args: Record<string, unknown>) => {
        return this.handleToolCall(toolName, args);
      },
    );

    this.toolRegistrations.set(toolName, registration);
  }

  /** Handle an incoming MCP tool call */
  private async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const startTime = Date.now();

    // Log tool call received
    this.log('info', 'Tool call received', { tool: toolName });

    try {
      // Extract identity fields
      let identity: ExtractedIdentity;
      let flowInput: unknown;
      try {
        const extracted = extractIdentity(args);
        identity = extracted.identity;
        flowInput = extracted.flowInput;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.log('error', 'Tool call error', { tool: toolName, error: errorMessage, durationMs: Date.now() - startTime });
        return {
          content: [{ type: 'text', text: errorMessage }],
          isError: true,
        };
      }

      // Generate unique idempotency key
      const idempotencyKey = randomUUID();

      // Build trigger options
      const triggerOptions: TriggerOptions = {
        idempotencyKey,
        input: flowInput,
      };
      if (identity.userId) triggerOptions.userId = identity.userId;
      if (identity.tenantId) triggerOptions.tenantId = identity.tenantId;
      if (identity.metadata) triggerOptions.metadata = identity.metadata;

      // Call engine.trigger()
      let execution;
      try {
        execution = await this.engine.trigger(toolName, triggerOptions);
      } catch (err) {
        // Pre-execution error (policy violation, rate limit, etc.)
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.log('error', 'Tool call error', { tool: toolName, error: errorMessage, durationMs: Date.now() - startTime });
        return {
          content: [{ type: 'text', text: errorMessage }],
          isError: true,
        };
      }

      // Wait for execution to reach terminal or waiting state
      const finalExecution = await this.waitForExecution(execution.id);
      const durationMs = Date.now() - startTime;

      // Return result based on state
      if (finalExecution.state === 'waiting') {
        this.log('info', 'Tool call completed', { tool: toolName, durationMs, success: true });
        return {
          content: [{
            type: 'text',
            text: `Flow entered waiting state. Execution ID: ${finalExecution.id}. Resume via engine API.`,
          }],
        };
      }

      if (finalExecution.state === 'failed') {
        const errorMessage = finalExecution.error?.message ?? 'Execution failed';
        this.log('error', 'Tool call error', { tool: toolName, error: errorMessage, durationMs });
        return {
          content: [{ type: 'text', text: errorMessage }],
          isError: true,
        };
      }

      // Complete
      const text = serializeResult(finalExecution.result);
      this.log('info', 'Tool call completed', { tool: toolName, durationMs, success: true });
      return {
        content: [{ type: 'text', text }],
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.log('error', 'Tool call error', { tool: toolName, error: errorMessage, durationMs: Date.now() - startTime });
      return {
        content: [{ type: 'text', text: errorMessage }],
        isError: true,
      };
    }
  }

  /** Wait for an execution to reach terminal (complete/failed) or waiting state */
  private async waitForExecution(executionId: string): Promise<{
    id: string;
    state: string;
    result?: unknown;
    error?: { message: string };
  }> {
    const WAIT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minute safety timeout
    return new Promise((resolve, reject) => {
      const timeoutTimer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for execution ${executionId} to complete`));
      }, WAIT_TIMEOUT_MS);
      // Check if already in terminal/waiting state
      const checkImmediate = async () => {
        const exec = await this.engine.getExecution(executionId);
        if (exec && (exec.state === 'complete' || exec.state === 'failed' || exec.state === 'waiting')) {
          resolve(exec as any);
          return true;
        }
        return false;
      };

      const onStateChange = async (event: { executionId: string; to: string }) => {
        if (event.executionId !== executionId) return;
        if (event.to === 'complete' || event.to === 'failed' || event.to === 'waiting') {
          cleanup();
          const exec = await this.engine.getExecution(executionId);
          resolve(exec as any);
        }
      };

      const onComplete = async (event: { executionId: string }) => {
        if (event.executionId !== executionId) return;
        cleanup();
        const exec = await this.engine.getExecution(executionId);
        resolve(exec as any);
      };

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        this.engine.off('execution:state_change', onStateChange as any);
        this.engine.off('execution:complete', onComplete as any);
      };

      this.engine.on('execution:state_change', onStateChange as any);
      this.engine.on('execution:complete', onComplete as any);

      // Check immediately in case execution already completed
      checkImmediate().then((done) => {
        if (done) cleanup();
      });
    });
  }

  /** Handle dynamic flow registration */
  private onFlowRegistered(flowName: string): void {
    const flows = this.engine.listFlows();
    const flow = flows.find((f) => f.name === flowName);
    if (flow) {
      this.registerFlowAsTool(flow);
    }
    this.mcpServer?.sendToolListChanged();
    this.log('info', 'Tool registered dynamically', { tool: flowName });
  }

  /** Handle dynamic flow unregistration */
  private onFlowUnregistered(flowName: string): void {
    const registration = this.toolRegistrations.get(flowName);
    if (registration) {
      registration.remove();
      this.toolRegistrations.delete(flowName);
    }
    this.mcpServer?.sendToolListChanged();
    this.log('info', 'Tool unregistered dynamically', { tool: flowName });
  }

  /** Structured logging helper */
  private log(level: 'info' | 'warn' | 'error', message: string, attributes: Record<string, unknown>): void {
    try {
      this.engine.instrumentation?.log(level, message, attributes);
    } catch {
      // Logging is best-effort
    }
  }
}
