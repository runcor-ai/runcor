// Integration tests for adapter lifecycle events
// Verifies that the engine emits the correct events during adapter
// connect, error, tools_discovered, and disconnect scenarios.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import type { AdapterConfig } from '../../src/types.js';
import type {
  MCPClient,
  MCPTransport,
  MCPClientFactory,
} from '../../src/adapter/managed-adapter.js';
import { ManagedAdapter } from '../../src/adapter/managed-adapter.js';

function createControllableFactory(options?: {
  tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  resources?: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
}) {
  const tools = options?.tools ?? [
    { name: 'default_tool', description: 'Default', inputSchema: { type: 'object' } },
  ];
  const resources = options?.resources ?? [];

  const listToolsMock = vi.fn(async () => ({ tools }));
  const listResourcesMock = vi.fn(async () => ({ resources }));
  const callToolMock = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: 'ok' }],
    isError: false,
  }));
  const readResourceMock = vi.fn(async () => ({
    contents: [{ uri: 'test://r', text: 'content' }],
  }));
  const closeMock = vi.fn(async () => {});

  const factory: MCPClientFactory = {
    createClient: vi.fn(async () => ({
      client: {
        listTools: listToolsMock,
        listResources: listResourcesMock,
        callTool: callToolMock,
        readResource: readResourceMock,
        close: closeMock,
      } satisfies MCPClient,
      transport: {
        close: vi.fn(async () => {}),
      } satisfies MCPTransport,
    })),
  };

  return { factory, listToolsMock, listResourcesMock, callToolMock, closeMock };
}

describe('T033: Adapter lifecycle events', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits adapter:connected when adapter is registered and connects', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const adapterManager = (engine as any).adapterManager;
    const { factory } = createControllableFactory();

    (adapterManager as any).createAdapter = (config: AdapterConfig) => {
      return new ManagedAdapter(config, { clientFactory: factory });
    };

    const events: Array<{ type: string; payload: unknown }> = [];
    engine.on('adapter:connected', (p) =>
      events.push({ type: 'adapter:connected', payload: p }),
    );

    await engine.addAdapter({
      name: 'event-test',
      transport: 'sse',
      url: 'http://localhost:3001/sse',
      healthCheckIntervalMs: 0,
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('adapter:connected');
    expect((events[0].payload as any).name).toBe('event-test');

    await engine.shutdown();
  });

  it('emits adapter:error when adapter transitions to error state', async () => {
    vi.useFakeTimers();

    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const adapterManager = (engine as any).adapterManager;
    const { factory, listToolsMock } = createControllableFactory();

    (adapterManager as any).createAdapter = (config: AdapterConfig) => {
      return new ManagedAdapter(config, { clientFactory: factory });
    };

    const events: Array<{ type: string; payload: unknown }> = [];
    engine.on('adapter:error', (p) =>
      events.push({ type: 'adapter:error', payload: p }),
    );

    await engine.addAdapter({
      name: 'error-event-test',
      transport: 'sse',
      url: 'http://localhost:3001/sse',
      healthCheckIntervalMs: 1000,
      retryAttempts: 0, // No reconnection so we stay in error
      failureThreshold: 20,
    });

    // Simulate error via health check failure
    listToolsMock.mockRejectedValueOnce(new Error('connection lost'));
    await vi.advanceTimersByTimeAsync(1001);

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe('adapter:error');
    expect((events[0].payload as any).name).toBe('error-event-test');
    expect((events[0].payload as any).error).toBe('Health check failed');

    await engine.shutdown();
  });

  it('emits adapter:tools_discovered on connect and reconnect', async () => {
    vi.useFakeTimers();

    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const adapterManager = (engine as any).adapterManager;
    const { factory, listToolsMock, listResourcesMock } =
      createControllableFactory({
        tools: [
          { name: 'tool_a', inputSchema: { type: 'object' } },
        ],
      });

    (adapterManager as any).createAdapter = (config: AdapterConfig) => {
      return new ManagedAdapter(config, { clientFactory: factory });
    };

    const toolEvents: Array<{ type: string; payload: unknown }> = [];
    engine.on('adapter:tools_discovered', (p) =>
      toolEvents.push({ type: 'adapter:tools_discovered', payload: p }),
    );

    await engine.addAdapter({
      name: 'tools-event-test',
      transport: 'sse',
      url: 'http://localhost:3001/sse',
      healthCheckIntervalMs: 1000,
      retryDelayMs: 200,
      retryAttempts: 3,
      failureThreshold: 20,
    });

    // First tools_discovered on initial connect
    expect(toolEvents).toHaveLength(1);
    expect((toolEvents[0].payload as any).tools).toEqual(['tool_a']);

    // Simulate error via health check
    listToolsMock.mockRejectedValueOnce(new Error('fail'));
    await vi.advanceTimersByTimeAsync(1001);

    // Set up reconnect with updated tools
    listToolsMock.mockImplementation(async () => ({
      tools: [
        { name: 'tool_a', inputSchema: { type: 'object' } },
        { name: 'tool_b', inputSchema: { type: 'object' } },
      ],
    }));
    listResourcesMock.mockResolvedValue({ resources: [] });

    // Advance past reconnection delay
    await vi.advanceTimersByTimeAsync(201);

    // Second tools_discovered on reconnect
    expect(toolEvents).toHaveLength(2);
    expect((toolEvents[1].payload as any).tools).toEqual(['tool_a', 'tool_b']);

    await engine.shutdown();
  });

  it('emits adapter:disconnected when adapter is removed', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const adapterManager = (engine as any).adapterManager;
    const { factory } = createControllableFactory();

    (adapterManager as any).createAdapter = (config: AdapterConfig) => {
      return new ManagedAdapter(config, { clientFactory: factory });
    };

    const events: Array<{ type: string; payload: unknown }> = [];
    engine.on('adapter:disconnected', (p) =>
      events.push({ type: 'adapter:disconnected', payload: p }),
    );

    await engine.addAdapter({
      name: 'disconnect-event-test',
      transport: 'sse',
      url: 'http://localhost:3001/sse',
      healthCheckIntervalMs: 0,
    });

    // Remove adapter
    await engine.removeAdapter('disconnect-event-test');

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('adapter:disconnected');
    expect((events[0].payload as any).name).toBe('disconnect-event-test');

    await engine.shutdown();
  });

  it('emits full lifecycle of events: connected -> error -> connected -> disconnected', async () => {
    vi.useFakeTimers();

    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const adapterManager = (engine as any).adapterManager;
    const { factory, listToolsMock, listResourcesMock } =
      createControllableFactory();

    (adapterManager as any).createAdapter = (config: AdapterConfig) => {
      return new ManagedAdapter(config, { clientFactory: factory });
    };

    const events: Array<{ type: string; payload: unknown }> = [];
    engine.on('adapter:connected', (p) =>
      events.push({ type: 'adapter:connected', payload: p }),
    );
    engine.on('adapter:error', (p) =>
      events.push({ type: 'adapter:error', payload: p }),
    );
    engine.on('adapter:disconnected', (p) =>
      events.push({ type: 'adapter:disconnected', payload: p }),
    );
    engine.on('adapter:tools_discovered', (p) =>
      events.push({ type: 'adapter:tools_discovered', payload: p }),
    );

    // 1. Connect
    await engine.addAdapter({
      name: 'lifecycle-test',
      transport: 'sse',
      url: 'http://localhost:3001/sse',
      healthCheckIntervalMs: 1000,
      retryDelayMs: 200,
      retryAttempts: 3,
      failureThreshold: 20,
    });

    const connectedIdx = events.findIndex(e => e.type === 'adapter:connected');
    expect(connectedIdx).toBeGreaterThanOrEqual(0);

    // 2. Simulate error
    listToolsMock.mockRejectedValueOnce(new Error('fail'));
    await vi.advanceTimersByTimeAsync(1001);

    const errorIdx = events.findIndex(e => e.type === 'adapter:error');
    expect(errorIdx).toBeGreaterThan(connectedIdx);

    // 3. Reconnect succeeds
    listToolsMock.mockResolvedValue({
      tools: [{ name: 'default_tool', description: 'Default', inputSchema: { type: 'object' } }],
    });
    listResourcesMock.mockResolvedValue({ resources: [] });
    await vi.advanceTimersByTimeAsync(201);

    const reconnectedEvents = events.filter(e => e.type === 'adapter:connected');
    expect(reconnectedEvents.length).toBe(2);

    // 4. Disconnect
    await engine.removeAdapter('lifecycle-test');

    const disconnectedIdx = events.findIndex(e => e.type === 'adapter:disconnected');
    expect(disconnectedIdx).toBeGreaterThan(errorIdx);

    // Verify overall event ordering
    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toContain('adapter:connected');
    expect(eventTypes).toContain('adapter:tools_discovered');
    expect(eventTypes).toContain('adapter:error');
    expect(eventTypes).toContain('adapter:disconnected');

    await engine.shutdown();
  });
});
