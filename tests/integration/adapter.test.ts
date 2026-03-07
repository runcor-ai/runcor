// Integration tests for adapter registration and tool calling
// Per spec US1 and zero-adapter mode requirements

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import type { AdapterConfig, ToolCallResult } from '../../src/types.js';
import type { MCPClient, MCPTransport, MCPClientFactory } from '../../src/adapter/managed-adapter.js';
import { ManagedAdapter } from '../../src/adapter/managed-adapter.js';

/** Create a mock MCP client factory that returns a controllable mock */
function createMockClientFactory(options?: {
  tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  resources?: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
  callToolResult?: ToolCallResult;
  readResourceResult?: { contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }> };
}): MCPClientFactory {
  const tools = options?.tools ?? [];
  const resources = options?.resources ?? [];
  const callToolResult: ToolCallResult = options?.callToolResult ?? {
    content: [{ type: 'text', text: 'mock result' }],
    isError: false,
  };
  const readResourceResult = options?.readResourceResult ?? {
    contents: [{ uri: 'test://resource', text: 'resource content' }],
  };

  return {
    createClient: vi.fn(async () => ({
      client: {
        listTools: vi.fn(async () => ({ tools })),
        listResources: vi.fn(async () => ({ resources })),
        callTool: vi.fn(async () => callToolResult),
        readResource: vi.fn(async () => readResourceResult),
        close: vi.fn(async () => {}),
      } satisfies MCPClient,
      transport: {
        close: vi.fn(async () => {}),
      } satisfies MCPTransport,
    })),
  };
}

describe('T024: Adapter registration and tool calling', () => {
  it('should register a mock adapter, discover tools, call a tool, and verify result', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const factory = createMockClientFactory({
      tools: [
        { name: 'send_message', description: 'Send a message', inputSchema: { type: 'object' } },
        { name: 'list_channels', description: 'List channels', inputSchema: { type: 'object' } },
      ],
      callToolResult: {
        content: [{ type: 'text', text: 'Message sent!' }],
        isError: false,
      },
    });

    // Create a ManagedAdapter with the mock factory, then add via engine
    // We need to override the adapter creation in AdapterManager
    // Instead, let's use the engine's addAdapter with a pre-configured adapter
    // The simplest approach: create an adapter config and use a custom adapter factory
    // Since the engine doesn't expose the factory directly, let's test at the AdapterManager level
    // and verify the engine delegation separately

    // For integration testing, we'll work with the AdapterManager directly via the engine internals
    // Actually, let's test the full flow using the engine's public API
    // We need to provide adapters through config that use our mock factory

    // The cleanest approach: use the engine's internal adapterManager
    const adapterManager = (engine as any).adapterManager;

    // Replace the createAdapter factory to use our mock
    (adapterManager as any).createAdapter = (config: AdapterConfig) => {
      return new ManagedAdapter(config, { clientFactory: factory });
    };

    // Add adapter via engine public API
    await engine.addAdapter({
      name: 'slack',
      transport: 'sse',
      url: 'http://localhost:3001/sse',
      healthCheckIntervalMs: 0, // Disable health checks for test
    });

    // Verify adapter info
    const info = engine.getAdapterInfo('slack');
    expect(info).not.toBeNull();
    expect(info!.state).toBe('connected');
    expect(info!.tools).toHaveLength(2);
    expect(info!.tools[0].name).toBe('send_message');

    // Verify tools are discoverable
    const tools = engine.listAdapterTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].qualifiedName).toBe('slack.send_message');
    expect(tools[1].qualifiedName).toBe('slack.list_channels');

    // Call a tool
    const result = await engine.callAdapterTool('slack.send_message', {
      channel: '#general',
      text: 'Hello!',
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe('Message sent!');

    // Verify the MCP client was called with correct args
    const mockCreateClient = factory.createClient as ReturnType<typeof vi.fn>;
    const { client } = await mockCreateClient.mock.results[0].value;
    expect(client.callTool).toHaveBeenCalledWith({
      name: 'send_message',
      arguments: { channel: '#general', text: 'Hello!' },
    });

    await engine.shutdown();
  });

  it('should support multiple adapters with tool listing and filtering', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const adapterManager = (engine as any).adapterManager;

    const slackFactory = createMockClientFactory({
      tools: [{ name: 'send_message', inputSchema: { type: 'object' } }],
    });
    const gmailFactory = createMockClientFactory({
      tools: [{ name: 'send_email', inputSchema: { type: 'object' } }],
    });

    (adapterManager as any).createAdapter = (config: AdapterConfig) => {
      const factory = config.name === 'slack' ? slackFactory : gmailFactory;
      return new ManagedAdapter(config, { clientFactory: factory });
    };

    await engine.addAdapter({ name: 'slack', transport: 'sse', url: 'http://localhost:3001/sse', healthCheckIntervalMs: 0 });
    await engine.addAdapter({ name: 'gmail', transport: 'sse', url: 'http://localhost:3002/sse', healthCheckIntervalMs: 0 });

    // All tools
    const allTools = engine.listAdapterTools();
    expect(allTools).toHaveLength(2);

    // Filter by adapter
    const slackTools = engine.listAdapterTools({ adapter: 'slack' });
    expect(slackTools).toHaveLength(1);
    expect(slackTools[0].qualifiedName).toBe('slack.send_message');

    const gmailTools = engine.listAdapterTools({ adapter: 'gmail' });
    expect(gmailTools).toHaveLength(1);
    expect(gmailTools[0].qualifiedName).toBe('gmail.send_email');

    // List adapters
    const adapters = engine.listAdapters();
    expect(adapters).toHaveLength(2);

    await engine.shutdown();
  });

  it('should remove adapter and update tool listing', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const adapterManager = (engine as any).adapterManager;
    const factory = createMockClientFactory({
      tools: [{ name: 'send_message', inputSchema: { type: 'object' } }],
    });

    (adapterManager as any).createAdapter = (config: AdapterConfig) => {
      return new ManagedAdapter(config, { clientFactory: factory });
    };

    await engine.addAdapter({ name: 'slack', transport: 'sse', url: 'http://localhost:3001/sse', healthCheckIntervalMs: 0 });
    expect(engine.listAdapterTools()).toHaveLength(1);

    await engine.removeAdapter('slack');
    expect(engine.listAdapterTools()).toHaveLength(0);
    expect(engine.getAdapterInfo('slack')).toBeNull();
    expect(engine.listAdapters()).toHaveLength(0);

    await engine.shutdown();
  });

  it('should reject duplicate adapter names', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const adapterManager = (engine as any).adapterManager;
    const factory = createMockClientFactory();

    (adapterManager as any).createAdapter = (config: AdapterConfig) => {
      return new ManagedAdapter(config, { clientFactory: factory });
    };

    await engine.addAdapter({ name: 'slack', transport: 'sse', url: 'http://localhost:3001/sse', healthCheckIntervalMs: 0 });

    await expect(
      engine.addAdapter({ name: 'slack', transport: 'sse', url: 'http://localhost:3002/sse', healthCheckIntervalMs: 0 }),
    ).rejects.toThrow(/already registered/);

    await engine.shutdown();
  });

  it('should emit adapter events', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const adapterManager = (engine as any).adapterManager;
    const factory = createMockClientFactory({
      tools: [{ name: 'test_tool', inputSchema: { type: 'object' } }],
    });

    (adapterManager as any).createAdapter = (config: AdapterConfig) => {
      return new ManagedAdapter(config, { clientFactory: factory });
    };

    const events: Array<{ type: string; payload: unknown }> = [];
    engine.on('adapter:connected', (payload) => events.push({ type: 'adapter:connected', payload }));
    engine.on('adapter:tool_call', (payload) => events.push({ type: 'adapter:tool_call', payload }));

    await engine.addAdapter({ name: 'test', transport: 'sse', url: 'http://localhost:3001/sse', healthCheckIntervalMs: 0 });

    // Verify connected event was emitted
    const connectedEvent = events.find(e => e.type === 'adapter:connected');
    expect(connectedEvent).toBeDefined();
    expect((connectedEvent!.payload as any).name).toBe('test');

    // Call a tool to trigger tool_call event
    await engine.callAdapterTool('test.test_tool', {});
    const toolCallEvent = events.find(e => e.type === 'adapter:tool_call');
    expect(toolCallEvent).toBeDefined();
    expect((toolCallEvent!.payload as any).adapter).toBe('test');
    expect((toolCallEvent!.payload as any).success).toBe(true);

    await engine.shutdown();
  });
});

// ── T037: Multi-adapter tool discovery ──

describe('T037: Multi-adapter tool discovery', () => {
  it('should list tools from multiple adapters', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const adapterManager = (engine as any).adapterManager;

    const slackFactory = createMockClientFactory({
      tools: [
        { name: 'send_message', description: 'Send a Slack message', inputSchema: { type: 'object' } },
        { name: 'list_channels', description: 'List Slack channels', inputSchema: { type: 'object' } },
      ],
    });
    const githubFactory = createMockClientFactory({
      tools: [
        { name: 'create_issue', description: 'Create a GitHub issue', inputSchema: { type: 'object' } },
        { name: 'list_repos', description: 'List repositories', inputSchema: { type: 'object' } },
        { name: 'create_pr', description: 'Create a pull request', inputSchema: { type: 'object' } },
      ],
    });

    (adapterManager as any).createAdapter = (config: AdapterConfig) => {
      const factory = config.name === 'slack' ? slackFactory : githubFactory;
      return new ManagedAdapter(config, { clientFactory: factory });
    };

    await engine.addAdapter({ name: 'slack', transport: 'sse', url: 'http://localhost:3001/sse', healthCheckIntervalMs: 0 });
    await engine.addAdapter({ name: 'github', transport: 'sse', url: 'http://localhost:3002/sse', healthCheckIntervalMs: 0 });

    // List all tools — should have 5 total from both adapters
    const allTools = engine.listAdapterTools();
    expect(allTools).toHaveLength(5);

    const qualifiedNames = allTools.map((t: any) => t.qualifiedName).sort();
    expect(qualifiedNames).toEqual([
      'github.create_issue',
      'github.create_pr',
      'github.list_repos',
      'slack.list_channels',
      'slack.send_message',
    ]);

    await engine.shutdown();
  });

  it('should filter tools by adapter name', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const adapterManager = (engine as any).adapterManager;

    const slackFactory = createMockClientFactory({
      tools: [{ name: 'send_message', inputSchema: { type: 'object' } }],
    });
    const githubFactory = createMockClientFactory({
      tools: [
        { name: 'create_issue', inputSchema: { type: 'object' } },
        { name: 'list_repos', inputSchema: { type: 'object' } },
      ],
    });

    (adapterManager as any).createAdapter = (config: AdapterConfig) => {
      const factory = config.name === 'slack' ? slackFactory : githubFactory;
      return new ManagedAdapter(config, { clientFactory: factory });
    };

    await engine.addAdapter({ name: 'slack', transport: 'sse', url: 'http://localhost:3001/sse', healthCheckIntervalMs: 0 });
    await engine.addAdapter({ name: 'github', transport: 'sse', url: 'http://localhost:3002/sse', healthCheckIntervalMs: 0 });

    const slackTools = engine.listAdapterTools({ adapter: 'slack' });
    expect(slackTools).toHaveLength(1);
    expect(slackTools[0].qualifiedName).toBe('slack.send_message');

    const githubTools = engine.listAdapterTools({ adapter: 'github' });
    expect(githubTools).toHaveLength(2);
    expect(githubTools.every((t: any) => t.adapterName === 'github')).toBe(true);

    await engine.shutdown();
  });

  it('should exclude tools after an adapter is disconnected', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const adapterManager = (engine as any).adapterManager;

    const slackFactory = createMockClientFactory({
      tools: [{ name: 'send_message', inputSchema: { type: 'object' } }],
    });
    const githubFactory = createMockClientFactory({
      tools: [{ name: 'create_issue', inputSchema: { type: 'object' } }],
    });

    (adapterManager as any).createAdapter = (config: AdapterConfig) => {
      const factory = config.name === 'slack' ? slackFactory : githubFactory;
      return new ManagedAdapter(config, { clientFactory: factory });
    };

    await engine.addAdapter({ name: 'slack', transport: 'sse', url: 'http://localhost:3001/sse', healthCheckIntervalMs: 0 });
    await engine.addAdapter({ name: 'github', transport: 'sse', url: 'http://localhost:3002/sse', healthCheckIntervalMs: 0 });

    // Both adapters have tools
    expect(engine.listAdapterTools()).toHaveLength(2);

    // Remove one adapter
    await engine.removeAdapter('slack');

    // Only github tools remain
    const remaining = engine.listAdapterTools();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].qualifiedName).toBe('github.create_issue');

    // Slack tools are gone
    expect(engine.listAdapterTools({ adapter: 'slack' })).toEqual([]);

    await engine.shutdown();
  });

  it('should handle adapter with no tools alongside adapter with tools', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const adapterManager = (engine as any).adapterManager;

    const withToolsFactory = createMockClientFactory({
      tools: [{ name: 'do_something', inputSchema: { type: 'object' } }],
    });
    const noToolsFactory = createMockClientFactory({
      tools: [],
    });

    (adapterManager as any).createAdapter = (config: AdapterConfig) => {
      const factory = config.name === 'tools-adapter' ? withToolsFactory : noToolsFactory;
      return new ManagedAdapter(config, { clientFactory: factory });
    };

    await engine.addAdapter({ name: 'tools-adapter', transport: 'sse', url: 'http://localhost:3001/sse', healthCheckIntervalMs: 0 });
    await engine.addAdapter({ name: 'empty-adapter', transport: 'sse', url: 'http://localhost:3002/sse', healthCheckIntervalMs: 0 });

    const tools = engine.listAdapterTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].qualifiedName).toBe('tools-adapter.do_something');

    // Empty adapter shows up in adapter list but has no tools
    expect(engine.listAdapters()).toHaveLength(2);
    expect(engine.listAdapterTools({ adapter: 'empty-adapter' })).toEqual([]);

    await engine.shutdown();
  });
});

// ── T043: Resource reading with caching ──

describe('T043: Resource reading with caching', () => {
  it('should read a resource from an adapter', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const adapterManager = (engine as any).adapterManager;
    const factory = createMockClientFactory({
      tools: [],
      resources: [{ uri: 'file:///config.json', name: 'config', mimeType: 'application/json' }],
      readResourceResult: {
        contents: [{ uri: 'file:///config.json', text: '{"key":"value"}', mimeType: 'application/json' }],
      },
    });

    (adapterManager as any).createAdapter = (config: AdapterConfig) => {
      return new ManagedAdapter(config, { clientFactory: factory });
    };

    await engine.addAdapter({
      name: 'docs',
      transport: 'sse',
      url: 'http://localhost:3001/sse',
      healthCheckIntervalMs: 0,
      resourceCacheTtlMs: 60_000,
    });

    const result = await engine.readAdapterResource('docs', 'file:///config.json');
    expect(result.uri).toBe('file:///config.json');
    expect(result.text).toBe('{"key":"value"}');
    expect(result.mimeType).toBe('application/json');

    await engine.shutdown();
  });

  it('should cache resources and return cached value on second read', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const adapterManager = (engine as any).adapterManager;

    let readCount = 0;
    const factory: MCPClientFactory = {
      createClient: vi.fn(async () => {
        const readResourceFn = vi.fn(async () => {
          readCount++;
          return {
            contents: [{ uri: 'file:///data.txt', text: `content-v${readCount}`, mimeType: 'text/plain' }],
          };
        });
        return {
          client: {
            listTools: vi.fn(async () => ({ tools: [] })),
            listResources: vi.fn(async () => ({
              resources: [{ uri: 'file:///data.txt', name: 'data' }],
            })),
            callTool: vi.fn(async () => ({ content: [{ type: 'text' as const, text: '' }], isError: false })),
            readResource: readResourceFn,
            close: vi.fn(async () => {}),
          } satisfies MCPClient,
          transport: {
            close: vi.fn(async () => {}),
          } satisfies MCPTransport,
        };
      }),
    };

    (adapterManager as any).createAdapter = (config: AdapterConfig) => {
      return new ManagedAdapter(config, { clientFactory: factory });
    };

    await engine.addAdapter({
      name: 'cache-test',
      transport: 'sse',
      url: 'http://localhost:3001/sse',
      healthCheckIntervalMs: 0,
      resourceCacheTtlMs: 60_000,
    });

    // First read — fetches from adapter
    const r1 = await engine.readAdapterResource('cache-test', 'file:///data.txt');
    expect(r1.text).toBe('content-v1');
    expect(readCount).toBe(1);

    // Second read — should return cached value
    const r2 = await engine.readAdapterResource('cache-test', 'file:///data.txt');
    expect(r2.text).toBe('content-v1');
    expect(readCount).toBe(1); // no second fetch

    await engine.shutdown();
  });

  it('should refetch after cache TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const engine = await createEngine({
        model: { provider: new MockProvider() },
      });

      const adapterManager = (engine as any).adapterManager;

      let readCount = 0;
      const factory: MCPClientFactory = {
        createClient: vi.fn(async () => {
          const readResourceFn = vi.fn(async () => {
            readCount++;
            return {
              contents: [{ uri: 'file:///data.txt', text: `version-${readCount}` }],
            };
          });
          return {
            client: {
              listTools: vi.fn(async () => ({ tools: [] })),
              listResources: vi.fn(async () => ({ resources: [] })),
              callTool: vi.fn(async () => ({ content: [{ type: 'text' as const, text: '' }], isError: false })),
              readResource: readResourceFn,
              close: vi.fn(async () => {}),
            } satisfies MCPClient,
            transport: {
              close: vi.fn(async () => {}),
            } satisfies MCPTransport,
          };
        }),
      };

      (adapterManager as any).createAdapter = (config: AdapterConfig) => {
        return new ManagedAdapter(config, { clientFactory: factory });
      };

      await engine.addAdapter({
        name: 'ttl-test',
        transport: 'sse',
        url: 'http://localhost:3001/sse',
        healthCheckIntervalMs: 0,
        resourceCacheTtlMs: 5000, // 5 second TTL
      });

      // First read
      const r1 = await engine.readAdapterResource('ttl-test', 'file:///data.txt');
      expect(r1.text).toBe('version-1');
      expect(readCount).toBe(1);

      // Read again before TTL — cached
      const r2 = await engine.readAdapterResource('ttl-test', 'file:///data.txt');
      expect(r2.text).toBe('version-1');
      expect(readCount).toBe(1);

      // Advance time past TTL
      vi.advanceTimersByTime(5001);

      // Read after TTL — should refetch
      const r3 = await engine.readAdapterResource('ttl-test', 'file:///data.txt');
      expect(r3.text).toBe('version-2');
      expect(readCount).toBe(2);

      await engine.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should throw ADAPTER_NOT_FOUND for unknown adapter', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    await expect(
      engine.readAdapterResource('nonexistent', 'file:///x'),
    ).rejects.toThrow(/not found/);

    await engine.shutdown();
  });
});

// ── T032: Reconnection integration test ──

describe('T032: Adapter reconnection', () => {
  it('should reconnect after connection drop and rediscover tools', async () => {
    vi.useFakeTimers();
    try {
      const engine = await createEngine({
        model: { provider: new MockProvider() },
      });

      const adapterManager = (engine as any).adapterManager;

      // Create a factory with controllable mocks
      const listToolsMock = vi.fn(async () => ({
        tools: [{ name: 'send_message', description: 'Send a message', inputSchema: { type: 'object' } }],
      }));
      const listResourcesMock = vi.fn(async () => ({ resources: [] }));
      const closeMock = vi.fn(async () => {});

      const clientFactory: MCPClientFactory = {
        createClient: vi.fn(async () => ({
          client: {
            listTools: listToolsMock,
            listResources: listResourcesMock,
            callTool: vi.fn(async () => ({
              content: [{ type: 'text' as const, text: 'result' }],
              isError: false,
            })),
            readResource: vi.fn(async () => ({
              contents: [{ uri: 'test://r', text: 'content' }],
            })),
            close: closeMock,
          } satisfies MCPClient,
          transport: { close: vi.fn(async () => {}) } satisfies MCPTransport,
        })),
      };

      (adapterManager as any).createAdapter = (config: AdapterConfig) => {
        return new ManagedAdapter(config, { clientFactory });
      };

      // Track events
      const events: Array<{ type: string; payload: unknown }> = [];
      engine.on('adapter:connected', (p) => events.push({ type: 'adapter:connected', payload: p }));
      engine.on('adapter:error', (p) => events.push({ type: 'adapter:error', payload: p }));
      engine.on('adapter:tools_discovered', (p) => events.push({ type: 'adapter:tools_discovered', payload: p }));

      await engine.addAdapter({
        name: 'reconnect-test',
        transport: 'sse',
        url: 'http://localhost:3001/sse',
        healthCheckIntervalMs: 1000,
        retryDelayMs: 500,
        retryAttempts: 3,
        failureThreshold: 10, // High so circuit breaker doesn't interfere
      });

      expect(engine.getAdapterInfo('reconnect-test')!.state).toBe('connected');

      // Simulate connection drop via health check failure
      listToolsMock.mockRejectedValueOnce(new Error('connection lost'));
      await vi.advanceTimersByTimeAsync(1001);

      // Should be in error state
      const adapterInfo = engine.getAdapterInfo('reconnect-test');
      expect(adapterInfo!.state).toBe('error');

      // Verify error event was emitted
      const errorEvent = events.find(e => e.type === 'adapter:error');
      expect(errorEvent).toBeDefined();

      // Reset listTools to succeed for reconnection
      listToolsMock.mockImplementation(async () => ({
        tools: [
          { name: 'send_message', description: 'Send a message', inputSchema: { type: 'object' } },
          { name: 'new_tool', description: 'A new tool discovered on reconnect', inputSchema: { type: 'object' } },
        ],
      }));

      // Advance past reconnection delay (500ms)
      await vi.advanceTimersByTimeAsync(501);

      // Should be connected again
      const reconnectedInfo = engine.getAdapterInfo('reconnect-test');
      expect(reconnectedInfo!.state).toBe('connected');

      // Verify tools were rediscovered (including the new tool)
      const discoveryEvents = events.filter(e => e.type === 'adapter:tools_discovered');
      expect(discoveryEvents.length).toBeGreaterThanOrEqual(2); // Initial + reconnect

      // Verify the reconnected event
      const connectedEvents = events.filter(e => e.type === 'adapter:connected');
      expect(connectedEvents.length).toBeGreaterThanOrEqual(2); // Initial + reconnect

      await engine.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should stop reconnection attempts after max retries', async () => {
    vi.useFakeTimers();
    try {
      const engine = await createEngine({
        model: { provider: new MockProvider() },
      });

      const adapterManager = (engine as any).adapterManager;

      const listToolsMock = vi.fn(async () => ({
        tools: [{ name: 'tool1', inputSchema: { type: 'object' } }],
      }));
      const listResourcesMock = vi.fn(async () => ({ resources: [] }));

      const clientFactory: MCPClientFactory = {
        createClient: vi.fn(async () => ({
          client: {
            listTools: listToolsMock,
            listResources: listResourcesMock,
            callTool: vi.fn(async () => ({
              content: [{ type: 'text' as const, text: '' }],
              isError: false,
            })),
            readResource: vi.fn(async () => ({ contents: [{ uri: 'x', text: '' }] })),
            close: vi.fn(async () => {}),
          } satisfies MCPClient,
          transport: { close: vi.fn(async () => {}) } satisfies MCPTransport,
        })),
      };

      (adapterManager as any).createAdapter = (config: AdapterConfig) => {
        return new ManagedAdapter(config, { clientFactory });
      };

      await engine.addAdapter({
        name: 'max-retry-test',
        transport: 'sse',
        url: 'http://localhost:3001/sse',
        healthCheckIntervalMs: 1000,
        retryDelayMs: 100,
        retryAttempts: 2,
        failureThreshold: 20,
      });

      // Trigger error
      listToolsMock.mockRejectedValueOnce(new Error('fail'));
      await vi.advanceTimersByTimeAsync(1001);
      expect(engine.getAdapterInfo('max-retry-test')!.state).toBe('error');

      // Make reconnection attempts fail too
      (clientFactory.createClient as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('server unreachable'),
      );

      // Exhaust retries: attempt 0 (100ms) + attempt 1 (200ms)
      await vi.advanceTimersByTimeAsync(101); // attempt 0 fires and fails
      await vi.advanceTimersByTimeAsync(201); // attempt 1 fires and fails

      // After max retries, adapter stays in error state permanently
      await vi.advanceTimersByTimeAsync(10000);
      expect(engine.getAdapterInfo('max-retry-test')!.state).toBe('error');

      await engine.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('T025: Zero-adapter mode', () => {
  it('should create engine without adapters and behave identically to pre-adapter engine', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    // Verify no adapters
    expect(engine.listAdapters()).toEqual([]);
    expect(engine.listAdapterTools()).toEqual([]);
    expect(engine.getAdapterInfo('nonexistent')).toBeNull();

    // Verify engine still works normally — register and trigger a flow
    engine.register('test-flow', async (ctx) => {
      return { message: 'hello' };
    });

    const exec = await engine.trigger('test-flow', { idempotencyKey: 'zero-adapter-test' });
    expect(exec).toBeDefined();

    // Wait for execution to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    const result = await engine.getExecution(exec.id);
    expect(result?.state).toBe('complete');
    expect(result?.result).toEqual({ message: 'hello' });

    await engine.shutdown();
  });

  it('should handle removeAdapter on non-existent adapter gracefully', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    // Should not throw
    await engine.removeAdapter('nonexistent');

    await engine.shutdown();
  });

  it('should throw TOOL_NOT_FOUND when calling tool with no adapters', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    await expect(
      engine.callAdapterTool('nonexistent.tool'),
    ).rejects.toThrow(/not registered/);

    await engine.shutdown();
  });
});
