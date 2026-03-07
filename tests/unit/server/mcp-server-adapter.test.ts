// Unit tests for MCPServerAdapter
// Covers US1 (discovery), US2 (invocation), US3 (dynamic updates), and logging

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MCPServerAdapter, extractIdentity } from '../../../src/server/mcp-server-adapter.js';
import type { MCPServerConfig } from '../../../src/server/types.js';
import type { Flow, ExecutionState } from '../../../src/types.js';
import { EventEmitter } from 'node:events';

// ── Mock engine ──

function createMockEngine(flows: Flow[] = []) {
  const emitter = new EventEmitter();
  const engine = {
    listFlows: vi.fn().mockReturnValue(flows),
    trigger: vi.fn(),
    getExecution: vi.fn(),
    getStatus: vi.fn().mockReturnValue('ready' as const),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      emitter.on(event, handler);
      return engine;
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      emitter.off(event, handler);
      return engine;
    }),
    // Helper to emit events in tests
    _emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
    instrumentation: {
      log: vi.fn(),
    },
  };
  return engine;
}

function createFlow(name: string, description?: string, inputSchema?: Record<string, unknown>): Flow {
  return {
    name,
    handler: vi.fn(),
    config: {
      timeout: 30000,
      maxRetries: 3,
      baseRetryDelay: 1000,
      maxRetryDelay: 30000,
      waitTimeout: 0,
    },
    inputSchema: inputSchema ?? { type: 'object' },
    description,
  };
}

// ── Mock MCP SDK ──

// We mock the McpServer and StdioServerTransport to test adapter logic
// without real stdio I/O
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  const registeredTools = new Map<string, {
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
    remove: () => void;
  }>();

  // Must use regular function (not arrow) so `new McpServer(...)` works
  function MockMcpServer(this: any, serverInfo: { name: string; version: string }) {
    this._serverInfo = serverInfo;
    this._registeredTools = registeredTools;
    this.tool = vi.fn().mockImplementation((name: string, description: string, schema: Record<string, unknown>, handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>) => {
      const registration = {
        description,
        inputSchema: schema,
        handler,
        remove: vi.fn().mockImplementation(() => {
          registeredTools.delete(name);
        }),
      };
      registeredTools.set(name, registration);
      return registration;
    });
    this.connect = vi.fn().mockResolvedValue(undefined);
    this.close = vi.fn().mockResolvedValue(undefined);
    this.sendToolListChanged = vi.fn();
  }

  return {
    McpServer: vi.fn().mockImplementation(MockMcpServer),
  };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => {
  function MockStdioServerTransport(this: any) {
    this.close = vi.fn().mockResolvedValue(undefined);
  }
  return {
    StdioServerTransport: vi.fn().mockImplementation(MockStdioServerTransport),
  };
});

// ── US1: Tool Discovery Tests ──

describe('MCPServerAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('US1: Tool Discovery', () => {
    it('should register all flows as tools on start', async () => {
      const flows = [
        createFlow('summarize', 'Summarize text', { type: 'object', properties: { text: { type: 'string' } } }),
        createFlow('translate', 'Translate text'),
      ];
      const engine = createMockEngine(flows);
      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });

      await adapter.start();

      // McpServer.tool should be called for each flow
      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const mcpInstance = (McpServer as any).mock.results[0].value;
      expect(mcpInstance.tool).toHaveBeenCalledTimes(2);
      expect(mcpInstance.tool).toHaveBeenCalledWith(
        'summarize',
        'Summarize text',
        { type: 'object', properties: { text: { type: 'string' } } },
        expect.any(Function),
      );

      await adapter.stop();
    });

    it('should use flow name as tool name [FR-003]', async () => {
      const flows = [createFlow('my-flow')];
      const engine = createMockEngine(flows);
      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();

      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const mcpInstance = (McpServer as any).mock.results[0].value;
      expect(mcpInstance.tool).toHaveBeenCalledWith('my-flow', expect.anything(), expect.anything(), expect.any(Function));

      await adapter.stop();
    });

    it('should use flow name as fallback description [FR-005]', async () => {
      const flows = [createFlow('my-flow')]; // no description
      const engine = createMockEngine(flows);
      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();

      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const mcpInstance = (McpServer as any).mock.results[0].value;
      expect(mcpInstance.tool).toHaveBeenCalledWith('my-flow', 'my-flow', expect.anything(), expect.any(Function));

      await adapter.stop();
    });

    it('should use default { type: "object" } schema when flow has none [FR-004, FR-013]', async () => {
      const flows = [createFlow('my-flow')];
      const engine = createMockEngine(flows);
      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();

      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const mcpInstance = (McpServer as any).mock.results[0].value;
      expect(mcpInstance.tool).toHaveBeenCalledWith('my-flow', expect.anything(), { type: 'object' }, expect.any(Function));

      await adapter.stop();
    });

    it('should register no tools for empty flow registry', async () => {
      const engine = createMockEngine([]);
      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();

      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const mcpInstance = (McpServer as any).mock.results[0].value;
      expect(mcpInstance.tool).not.toHaveBeenCalled();

      await adapter.stop();
    });

    it('should create McpServer with correct name, version, capabilities [FR-019]', async () => {
      const engine = createMockEngine([]);
      const adapter = new MCPServerAdapter(engine as any, { name: 'my-engine', version: '2.0.0' });
      await adapter.start();

      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      expect(McpServer).toHaveBeenCalledWith(
        { name: 'my-engine', version: '2.0.0' },
        { capabilities: { tools: {} } },
      );

      await adapter.stop();
    });
  });

  // ── US2: Tool Call Handling Tests ──

  describe('US2: Tool Call Handling', () => {
    it('should trigger engine with correct flowName and UUID idempotency key [FR-006, FR-007]', async () => {
      const flows = [createFlow('summarize', 'Summarize')];
      const engine = createMockEngine(flows);
      engine.trigger.mockResolvedValue({
        id: 'exec-1',
        state: 'complete',
        result: 'summarized text',
      });

      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();

      // Get the tool handler and call it
      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const mcpInstance = (McpServer as any).mock.results[0].value;
      const toolHandler = mcpInstance.tool.mock.calls[0][3];

      // Set up the execution to complete immediately
      engine.getExecution.mockResolvedValue({ id: 'exec-1', state: 'complete', result: 'summarized text' });

      await toolHandler({ text: 'hello' }, {});

      expect(engine.trigger).toHaveBeenCalledWith('summarize', expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
        input: { text: 'hello' },
      }));

      await adapter.stop();
    });

    it('should return string result as-is in text content [FR-009]', async () => {
      const flows = [createFlow('test-flow', 'Test')];
      const engine = createMockEngine(flows);
      engine.trigger.mockResolvedValue({ id: 'exec-1', state: 'complete', result: 'hello world' });
      engine.getExecution.mockResolvedValue({ id: 'exec-1', state: 'complete', result: 'hello world' });

      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();

      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const mcpInstance = (McpServer as any).mock.results[0].value;
      const toolHandler = mcpInstance.tool.mock.calls[0][3];

      const result = await toolHandler({}, {});
      expect(result).toEqual({ content: [{ type: 'text', text: 'hello world' }] });

      await adapter.stop();
    });

    it('should JSON-stringify non-string results [FR-009]', async () => {
      const flows = [createFlow('test-flow', 'Test')];
      const engine = createMockEngine(flows);
      const objResult = { count: 42, items: ['a', 'b'] };
      engine.trigger.mockResolvedValue({ id: 'exec-1', state: 'complete', result: objResult });
      engine.getExecution.mockResolvedValue({ id: 'exec-1', state: 'complete', result: objResult });

      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();

      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const mcpInstance = (McpServer as any).mock.results[0].value;
      const toolHandler = mcpInstance.tool.mock.calls[0][3];

      const result = await toolHandler({}, {});
      expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(objResult) }] });

      await adapter.stop();
    });

    it('should return empty string for null/undefined results [FR-009]', async () => {
      const flows = [createFlow('test-flow', 'Test')];
      const engine = createMockEngine(flows);
      engine.trigger.mockResolvedValue({ id: 'exec-1', state: 'complete', result: null });
      engine.getExecution.mockResolvedValue({ id: 'exec-1', state: 'complete', result: null });

      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();

      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const mcpInstance = (McpServer as any).mock.results[0].value;
      const toolHandler = mcpInstance.tool.mock.calls[0][3];

      const result = await toolHandler({}, {});
      expect(result).toEqual({ content: [{ type: 'text', text: '' }] });

      await adapter.stop();
    });

    it('should return error response for failed execution [FR-010]', async () => {
      const flows = [createFlow('test-flow', 'Test')];
      const engine = createMockEngine(flows);
      engine.trigger.mockResolvedValue({
        id: 'exec-1',
        state: 'failed',
        error: { message: 'Something went wrong' },
      });
      engine.getExecution.mockResolvedValue({
        id: 'exec-1',
        state: 'failed',
        error: { message: 'Something went wrong' },
      });

      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();

      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const mcpInstance = (McpServer as any).mock.results[0].value;
      const toolHandler = mcpInstance.tool.mock.calls[0][3];

      const result = await toolHandler({}, {});
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Something went wrong' }],
        isError: true,
      });

      await adapter.stop();
    });

    it('should return error response when trigger() throws [FR-024]', async () => {
      const flows = [createFlow('test-flow', 'Test')];
      const engine = createMockEngine(flows);
      engine.trigger.mockRejectedValue(new Error('Policy violation: access denied'));

      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();

      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const mcpInstance = (McpServer as any).mock.results[0].value;
      const toolHandler = mcpInstance.tool.mock.calls[0][3];

      const result = await toolHandler({}, {});
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Policy violation: access denied' }],
        isError: true,
      });

      await adapter.stop();
    });

    it('should return waiting state response with execution ID [FR-012]', async () => {
      const flows = [createFlow('test-flow', 'Test')];
      const engine = createMockEngine(flows);
      engine.trigger.mockResolvedValue({ id: 'exec-wait-123', state: 'waiting' });
      engine.getExecution.mockResolvedValue({ id: 'exec-wait-123', state: 'waiting' });

      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();

      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const mcpInstance = (McpServer as any).mock.results[0].value;
      const toolHandler = mcpInstance.tool.mock.calls[0][3];

      const result = await toolHandler({}, {});
      expect(result).toEqual({
        content: [{
          type: 'text',
          text: 'Flow entered waiting state. Execution ID: exec-wait-123. Resume via engine API.',
        }],
      });

      await adapter.stop();
    });

    it('should pass identity fields through to trigger options [FR-011]', async () => {
      const flows = [createFlow('test-flow', 'Test')];
      const engine = createMockEngine(flows);
      engine.trigger.mockResolvedValue({ id: 'exec-1', state: 'complete', result: 'ok' });
      engine.getExecution.mockResolvedValue({ id: 'exec-1', state: 'complete', result: 'ok' });

      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();

      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const mcpInstance = (McpServer as any).mock.results[0].value;
      const toolHandler = mcpInstance.tool.mock.calls[0][3];

      await toolHandler({
        text: 'hello',
        _userId: 'user-123',
        _tenantId: 'tenant-456',
        _metadata: { source: 'test' },
      }, {});

      expect(engine.trigger).toHaveBeenCalledWith('test-flow', expect.objectContaining({
        input: { text: 'hello' },
        userId: 'user-123',
        tenantId: 'tenant-456',
        metadata: { source: 'test' },
      }));

      await adapter.stop();
    });
  });

  // ── US3: Dynamic Tool List Updates ──

  describe('US3: Dynamic Tool List Updates', () => {
    it('should register new tool on flow:registered event and notify [FR-014]', async () => {
      const engine = createMockEngine([]);
      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();

      // Simulate a new flow registration
      const newFlow = createFlow('new-flow', 'A new flow');
      engine.listFlows.mockReturnValue([newFlow]);

      // Emit flow:registered event
      engine._emit('flow:registered', { name: 'new-flow' });

      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const mcpInstance = (McpServer as any).mock.results[0].value;

      // Should have registered the new tool
      expect(mcpInstance.tool).toHaveBeenCalledWith(
        'new-flow', 'A new flow', { type: 'object' }, expect.any(Function),
      );
      // Should have sent notification
      expect(mcpInstance.sendToolListChanged).toHaveBeenCalled();

      await adapter.stop();
    });

    it('should remove tool on flow:unregistered event and notify [FR-014]', async () => {
      const flows = [createFlow('my-flow', 'A flow')];
      const engine = createMockEngine(flows);
      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();

      // Emit flow:unregistered event
      engine._emit('flow:unregistered', { name: 'my-flow' });

      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const mcpInstance = (McpServer as any).mock.results[0].value;

      // Should have sent notification
      expect(mcpInstance.sendToolListChanged).toHaveBeenCalled();

      await adapter.stop();
    });

    it('should remove event listeners on stop', async () => {
      const engine = createMockEngine([]);
      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();
      await adapter.stop();

      expect(engine.off).toHaveBeenCalledWith('flow:registered', expect.any(Function));
      expect(engine.off).toHaveBeenCalledWith('flow:unregistered', expect.any(Function));
    });
  });

  // ── Stop behavior ──

  describe('Lifecycle', () => {
    it('should be a no-op if stop is called when not running', async () => {
      const engine = createMockEngine([]);
      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });

      // Should not throw
      await adapter.stop();
    });

    it('should track running state', async () => {
      const engine = createMockEngine([]);
      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });

      expect(adapter.isRunning()).toBe(false);
      await adapter.start();
      expect(adapter.isRunning()).toBe(true);
      await adapter.stop();
      expect(adapter.isRunning()).toBe(false);
    });
  });

  // ── Structured Logging [FR-025] ──

  describe('Structured Logging', () => {
    it('should log server start with name and version [FR-025]', async () => {
      const engine = createMockEngine([]);
      const adapter = new MCPServerAdapter(engine as any, { name: 'my-engine', version: '2.0' });
      await adapter.start();

      expect(engine.instrumentation.log).toHaveBeenCalledWith(
        'info',
        'MCP server started',
        expect.objectContaining({ name: 'my-engine', version: '2.0' }),
      );

      await adapter.stop();
    });

    it('should log server stop [FR-025]', async () => {
      const engine = createMockEngine([]);
      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();

      engine.instrumentation.log.mockClear();
      await adapter.stop();

      expect(engine.instrumentation.log).toHaveBeenCalledWith(
        'info',
        'MCP server stopped',
        expect.any(Object),
      );
    });

    it('should log tool call received with tool name [FR-025]', async () => {
      const flows = [createFlow('my-tool', 'A tool')];
      const engine = createMockEngine(flows);
      engine.trigger.mockResolvedValue({ id: 'exec-1', state: 'complete', result: 'ok' });
      engine.getExecution.mockResolvedValue({ id: 'exec-1', state: 'complete', result: 'ok' });

      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();

      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const mcpInstance = (McpServer as any).mock.results[0].value;
      const toolHandler = mcpInstance.tool.mock.calls[0][3];

      engine.instrumentation.log.mockClear();
      await toolHandler({}, {});

      expect(engine.instrumentation.log).toHaveBeenCalledWith(
        'info',
        'Tool call received',
        expect.objectContaining({ tool: 'my-tool' }),
      );

      await adapter.stop();
    });

    it('should log tool call completed with tool name, duration, and success [FR-025]', async () => {
      const flows = [createFlow('my-tool', 'A tool')];
      const engine = createMockEngine(flows);
      engine.trigger.mockResolvedValue({ id: 'exec-1', state: 'complete', result: 'ok' });
      engine.getExecution.mockResolvedValue({ id: 'exec-1', state: 'complete', result: 'ok' });

      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();

      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const mcpInstance = (McpServer as any).mock.results[0].value;
      const toolHandler = mcpInstance.tool.mock.calls[0][3];

      engine.instrumentation.log.mockClear();
      await toolHandler({}, {});

      expect(engine.instrumentation.log).toHaveBeenCalledWith(
        'info',
        'Tool call completed',
        expect.objectContaining({ tool: 'my-tool', success: true, durationMs: expect.any(Number) }),
      );

      await adapter.stop();
    });

    it('should log tool call error with tool name and error message [FR-025]', async () => {
      const flows = [createFlow('my-tool', 'A tool')];
      const engine = createMockEngine(flows);
      engine.trigger.mockRejectedValue(new Error('Something failed'));

      const adapter = new MCPServerAdapter(engine as any, { name: 'test', version: '1.0' });
      await adapter.start();

      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const mcpInstance = (McpServer as any).mock.results[0].value;
      const toolHandler = mcpInstance.tool.mock.calls[0][3];

      engine.instrumentation.log.mockClear();
      await toolHandler({}, {});

      expect(engine.instrumentation.log).toHaveBeenCalledWith(
        'error',
        'Tool call error',
        expect.objectContaining({ tool: 'my-tool', error: 'Something failed' }),
      );

      await adapter.stop();
    });
  });
});
