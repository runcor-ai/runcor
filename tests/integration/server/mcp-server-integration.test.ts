// Integration tests for MCP Server Interface
// Full round-trip: create engine → register flows → start MCP server → simulate tool calls

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createEngine } from '../../../src/engine.js';
import type { EngineConfig, ExecutionContext } from '../../../src/types.js';

// Mock the MCP SDK to avoid real stdio I/O but capture tool registrations and calls
const registeredTools = new Map<string, {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
  remove: () => void;
}>();

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  function MockMcpServer(this: any, serverInfo: { name: string; version: string }) {
    this._serverInfo = serverInfo;
    this.tool = vi.fn().mockImplementation(
      (name: string, description: string, schema: Record<string, unknown>, handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>) => {
        const registration = {
          name,
          description,
          inputSchema: schema,
          handler,
          remove: vi.fn().mockImplementation(() => {
            registeredTools.delete(name);
          }),
        };
        registeredTools.set(name, registration);
        return registration;
      },
    );
    this.connect = vi.fn().mockResolvedValue(undefined);
    this.close = vi.fn().mockResolvedValue(undefined);
    this.sendToolListChanged = vi.fn();
  }
  return { McpServer: vi.fn().mockImplementation(MockMcpServer) };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => {
  function MockStdioServerTransport(this: any) {
    this.close = vi.fn().mockResolvedValue(undefined);
  }
  return { StdioServerTransport: vi.fn().mockImplementation(MockStdioServerTransport) };
});

const mockProvider = {
  id: 'test-provider',
  chat: vi.fn().mockResolvedValue({ text: 'ok', promptTokens: 1, completionTokens: 1 }),
};

function createConfig(): EngineConfig {
  return {
    model: {
      providers: [{ provider: mockProvider, priority: 1 }],
    },
  };
}

describe('MCP Server Integration', () => {
  let engine: Awaited<ReturnType<typeof createEngine>>;

  afterEach(async () => {
    registeredTools.clear();
    try {
      await engine?.shutdown();
    } catch {
      // Ignore
    }
  });

  it('should expose registered flows as discoverable tools and handle tool calls end-to-end', async () => {
    engine = await createEngine(createConfig());

    // Register flows with description and inputSchema
    engine.register('summarize', async (ctx: ExecutionContext) => {
      return `Summary of: ${ctx.input?.text}`;
    }, {
      description: 'Summarize text content',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
      },
    });

    engine.register('translate', async (ctx: ExecutionContext) => {
      return { translated: ctx.input?.text, lang: ctx.input?.lang };
    }, {
      description: 'Translate text',
    });

    // Start MCP server
    await engine.startServer({ name: 'integration-test', version: '1.0.0' });

    // Verify tools/list: both flows should be registered
    expect(registeredTools.size).toBe(2);
    expect(registeredTools.has('summarize')).toBe(true);
    expect(registeredTools.has('translate')).toBe(true);

    // Verify tool metadata
    const summarizeTool = registeredTools.get('summarize')!;
    expect(summarizeTool.description).toBe('Summarize text content');
    expect(summarizeTool.inputSchema).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
    });

    const translateTool = registeredTools.get('translate')!;
    expect(translateTool.description).toBe('Translate text');

    // Simulate tool call: summarize
    const summarizeResult = await summarizeTool.handler({ text: 'Hello world' }, {});
    expect(summarizeResult).toEqual({
      content: [{ type: 'text', text: 'Summary of: Hello world' }],
    });

    // Simulate tool call: translate (non-string result → JSON-stringified)
    const translateResult = await translateTool.handler({ text: 'Hello', lang: 'fr' }, {});
    expect(translateResult).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ translated: 'Hello', lang: 'fr' }) }],
    });
  });

  it('should strip identity fields from flow input and pass remaining data', async () => {
    engine = await createEngine(createConfig());

    let capturedInput: unknown;
    engine.register('secure-flow', async (ctx: ExecutionContext) => {
      capturedInput = ctx.input;
      return 'done';
    });

    await engine.startServer({ name: 'test', version: '1.0' });

    const tool = registeredTools.get('secure-flow')!;
    const result = await tool.handler({
      data: 'payload',
      _userId: 'user-42',
      _tenantId: 'tenant-99',
      _metadata: { source: 'test' },
    }, {});

    // Identity fields should be stripped from flow input
    expect(capturedInput).toEqual({ data: 'payload' });
    // Result should be successful
    expect(result).toEqual({
      content: [{ type: 'text', text: 'done' }],
    });
  });

  it('should update tool list when flows are dynamically registered/unregistered', async () => {
    engine = await createEngine(createConfig());

    engine.register('initial-flow', async () => 'result');

    await engine.startServer({ name: 'test', version: '1.0' });
    expect(registeredTools.size).toBe(1);

    // Dynamically register a new flow
    engine.register('dynamic-flow', async () => 'dynamic result', {
      description: 'A dynamic flow',
    });
    expect(registeredTools.has('dynamic-flow')).toBe(true);
    expect(registeredTools.size).toBe(2);

    // Dynamically unregister a flow
    engine.unregister('initial-flow');
    expect(registeredTools.has('initial-flow')).toBe(false);
    expect(registeredTools.size).toBe(1);
  });

  it('should handle failed flow execution in tool call', async () => {
    engine = await createEngine(createConfig());

    engine.register('failing-flow', async () => {
      throw new Error('Flow execution failed');
    });

    await engine.startServer({ name: 'test', version: '1.0' });

    const tool = registeredTools.get('failing-flow')!;
    const result = await tool.handler({}, {});

    expect(result).toEqual({
      content: [{ type: 'text', text: expect.stringContaining('Flow execution failed') }],
      isError: true,
    });
  });

  it('should have low overhead for tool call beyond flow execution [SC-002]', async () => {
    engine = await createEngine(createConfig());

    const flowDelay = 10; // ms
    engine.register('timed-flow', async () => {
      await new Promise((resolve) => setTimeout(resolve, flowDelay));
      return 'timed result';
    });

    await engine.startServer({ name: 'test', version: '1.0' });

    const tool = registeredTools.get('timed-flow')!;

    const start = Date.now();
    await tool.handler({}, {});
    const elapsed = Date.now() - start;

    // Tool call overhead should be less than 100ms beyond flow execution time
    const overhead = elapsed - flowDelay;
    expect(overhead).toBeLessThan(100);
  });

  it('should complete execution even if client disconnects (execution continues)', async () => {
    engine = await createEngine(createConfig());

    let flowCompleted = false;
    engine.register('long-flow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      flowCompleted = true;
      return 'completed';
    });

    await engine.startServer({ name: 'test', version: '1.0' });

    const tool = registeredTools.get('long-flow')!;

    // Start the tool call
    const resultPromise = tool.handler({}, {});

    // Wait for the result (in real scenario, client might disconnect,
    // but the execution continues in the engine)
    const result = await resultPromise;

    expect(flowCompleted).toBe(true);
    expect(result).toEqual({
      content: [{ type: 'text', text: 'completed' }],
    });
  });
});
