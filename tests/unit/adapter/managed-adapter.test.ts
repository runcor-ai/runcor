// Unit tests for ManagedAdapter
// Verifies state machine transitions, tool discovery, tool calls,
// circuit breaker integration, timeout handling, and disconnect.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ManagedAdapter,
  type MCPClient,
  type MCPTransport,
  type MCPClientFactory,
} from '../../../src/adapter/managed-adapter.js';
import { EngineError } from '../../../src/errors.js';
import type {
  AdapterConfig,
  AdapterState,
  AdapterToolSchema,
  AdapterResourceSchema,
  ToolCallResult,
} from '../../../src/types.js';

// ── Test Helpers ──

function makeConfig(overrides?: Partial<AdapterConfig>): AdapterConfig {
  return {
    name: 'test-adapter',
    transport: 'stdio',
    command: '/usr/bin/test-server',
    timeoutMs: 5000,
    healthCheckIntervalMs: 0, // disable health checks in tests by default
    failureThreshold: 3,
    cooldownMs: 30000,
    ...overrides,
  };
}

function makeTool(name: string, description?: string): AdapterToolSchema {
  return {
    name,
    description: description ?? `${name} tool`,
    inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
  };
}

function makeResource(
  uri: string,
  name: string,
): AdapterResourceSchema {
  return { uri, name, description: `${name} resource`, mimeType: 'text/plain' };
}

function makeToolCallResult(text: string): ToolCallResult {
  return {
    content: [{ type: 'text', text }],
    isError: false,
  };
}

interface MockClientSetup {
  client: MCPClient;
  transport: MCPTransport;
  factory: MCPClientFactory;
  listToolsMock: ReturnType<typeof vi.fn>;
  listResourcesMock: ReturnType<typeof vi.fn>;
  callToolMock: ReturnType<typeof vi.fn>;
  readResourceMock: ReturnType<typeof vi.fn>;
  clientCloseMock: ReturnType<typeof vi.fn>;
  transportCloseMock: ReturnType<typeof vi.fn>;
}

function createMockClient(
  tools: AdapterToolSchema[] = [makeTool('echo')],
  resources: AdapterResourceSchema[] = [],
): MockClientSetup {
  const listToolsMock = vi.fn().mockResolvedValue({ tools });
  const listResourcesMock = vi.fn().mockResolvedValue({ resources });
  const callToolMock = vi
    .fn()
    .mockResolvedValue(makeToolCallResult('ok'));
  const readResourceMock = vi.fn().mockResolvedValue({
    contents: [{ uri: 'test://resource', text: 'content', mimeType: 'text/plain' }],
  });
  const clientCloseMock = vi.fn().mockResolvedValue(undefined);
  const transportCloseMock = vi.fn().mockResolvedValue(undefined);

  const client: MCPClient = {
    listTools: listToolsMock,
    listResources: listResourcesMock,
    callTool: callToolMock,
    readResource: readResourceMock,
    close: clientCloseMock,
  };

  const transport: MCPTransport = {
    close: transportCloseMock,
  };

  const factory: MCPClientFactory = {
    createClient: vi.fn().mockResolvedValue({ client, transport }),
  };

  return {
    client,
    transport,
    factory,
    listToolsMock,
    listResourcesMock,
    callToolMock,
    readResourceMock,
    clientCloseMock,
    transportCloseMock,
  };
}

// ── Tests ──

describe('ManagedAdapter', () => {
  let config: AdapterConfig;
  let mock: MockClientSetup;
  let adapter: ManagedAdapter;

  beforeEach(() => {
    vi.useFakeTimers();
    config = makeConfig();
    mock = createMockClient();
    adapter = new ManagedAdapter(config, { clientFactory: mock.factory });
  });

  afterEach(() => {
    adapter.shutdown();
    vi.useRealTimers();
  });

  // ── T011: State transitions ──

  describe('state transitions', () => {
    it('starts in disconnected state', () => {
      expect(adapter.state).toBe('disconnected');
    });

    it('transitions disconnected -> connecting -> connected on successful connect', async () => {
      const transitions: Array<{ from: AdapterState; to: AdapterState }> = [];
      adapter.onStateChange = (_adapter, from, to) => {
        transitions.push({ from, to });
      };

      await adapter.connect();

      expect(transitions).toEqual([
        { from: 'disconnected', to: 'connecting' },
        { from: 'connecting', to: 'connected' },
      ]);
      expect(adapter.state).toBe('connected');
    });

    it('transitions disconnected -> connecting -> error on connection failure', async () => {
      const transitions: Array<{ from: AdapterState; to: AdapterState }> = [];
      adapter.onStateChange = (_adapter, from, to) => {
        transitions.push({ from, to });
      };

      // Make factory throw
      (mock.factory.createClient as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Connection refused'),
      );

      await expect(adapter.connect()).rejects.toThrow(EngineError);

      expect(transitions).toEqual([
        { from: 'disconnected', to: 'connecting' },
        { from: 'connecting', to: 'error' },
      ]);
      expect(adapter.state).toBe('error');
    });

    it('stores the error message on connection failure', async () => {
      (mock.factory.createClient as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('ECONNREFUSED'),
      );

      await expect(adapter.connect()).rejects.toThrow(EngineError);

      expect(adapter.getLastError()).toBe('ECONNREFUSED');
    });

    it('transitions connected -> disconnected on explicit disconnect', async () => {
      await adapter.connect();

      const transitions: Array<{ from: AdapterState; to: AdapterState }> = [];
      adapter.onStateChange = (_adapter, from, to) => {
        transitions.push({ from, to });
      };

      await adapter.disconnect();

      expect(transitions).toEqual([
        { from: 'connected', to: 'disconnected' },
      ]);
      expect(adapter.state).toBe('disconnected');
    });

    it('transitions error -> connecting -> connected on reconnection', async () => {
      // First: fail to connect
      (mock.factory.createClient as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Server down'),
      );
      await expect(adapter.connect()).rejects.toThrow();
      expect(adapter.state).toBe('error');

      // Reset mock to succeed
      (mock.factory.createClient as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        client: mock.client,
        transport: mock.transport,
      });

      const transitions: Array<{ from: AdapterState; to: AdapterState }> = [];
      adapter.onStateChange = (_adapter, from, to) => {
        transitions.push({ from, to });
      };

      await adapter.connect();

      expect(transitions).toEqual([
        { from: 'error', to: 'connecting' },
        { from: 'connecting', to: 'connected' },
      ]);
      expect(adapter.state).toBe('connected');
    });

    it('is a no-op when already connected', async () => {
      await adapter.connect();

      const transitions: Array<{ from: AdapterState; to: AdapterState }> = [];
      adapter.onStateChange = (_adapter, from, to) => {
        transitions.push({ from, to });
      };

      await adapter.connect(); // second call — should no-op

      expect(transitions).toHaveLength(0);
      expect(adapter.state).toBe('connected');
    });

    it('increments consecutive failures on connection failure', async () => {
      (mock.factory.createClient as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('fail 1'),
      );
      await expect(adapter.connect()).rejects.toThrow();
      expect(adapter.getConsecutiveFailures()).toBe(1);
    });

    it('resets consecutive failures on successful connect', async () => {
      // Fail first
      (mock.factory.createClient as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('fail'),
      );
      await expect(adapter.connect()).rejects.toThrow();
      expect(adapter.getConsecutiveFailures()).toBe(1);

      // Succeed
      (mock.factory.createClient as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        client: mock.client,
        transport: mock.transport,
      });
      await adapter.connect();
      expect(adapter.getConsecutiveFailures()).toBe(0);
    });
  });

  // ── T012: Tool discovery ──

  describe('tool discovery', () => {
    it('discovers tools on connect', async () => {
      const tools = [makeTool('search'), makeTool('create')];
      const resources = [makeResource('file:///doc.md', 'doc')];
      const mockSetup = createMockClient(tools, resources);
      const a = new ManagedAdapter(config, {
        clientFactory: mockSetup.factory,
      });

      await a.connect();

      expect(a.getTools()).toEqual(tools);
      expect(a.getResources()).toEqual(resources);

      a.shutdown();
    });

    it('fires onToolsDiscovered callback with tool names', async () => {
      const tools = [makeTool('alpha'), makeTool('beta')];
      const mockSetup = createMockClient(tools);
      const a = new ManagedAdapter(config, {
        clientFactory: mockSetup.factory,
      });

      const discovered: string[][] = [];
      a.onToolsDiscovered = (_adapter, names) => {
        discovered.push(names);
      };

      await a.connect();

      expect(discovered).toEqual([['alpha', 'beta']]);

      a.shutdown();
    });

    it('rediscovers tools on reconnect after error', async () => {
      const initialTools = [makeTool('v1')];
      const updatedTools = [makeTool('v1'), makeTool('v2-new')];

      // First connect: initial tools
      const mockSetup = createMockClient(initialTools);
      const a = new ManagedAdapter(config, {
        clientFactory: mockSetup.factory,
      });

      await a.connect();
      expect(a.getTools().map((t) => t.name)).toEqual(['v1']);

      // Disconnect
      await a.disconnect();

      // Reconnect with updated tools
      mockSetup.listToolsMock.mockResolvedValueOnce({ tools: updatedTools });
      (mockSetup.factory.createClient as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        client: mockSetup.client,
        transport: mockSetup.transport,
      });

      await a.connect();
      expect(a.getTools().map((t) => t.name)).toEqual(['v1', 'v2-new']);

      a.shutdown();
    });

    it('handles empty tool list', async () => {
      const mockSetup = createMockClient([], []);
      const a = new ManagedAdapter(config, {
        clientFactory: mockSetup.factory,
      });

      await a.connect();

      expect(a.getTools()).toEqual([]);
      expect(a.getResources()).toEqual([]);

      a.shutdown();
    });

    it('clears tools and resources on disconnect', async () => {
      const tools = [makeTool('search')];
      const resources = [makeResource('file:///x', 'x')];
      const mockSetup = createMockClient(tools, resources);
      const a = new ManagedAdapter(config, {
        clientFactory: mockSetup.factory,
      });

      await a.connect();
      expect(a.getTools()).toHaveLength(1);
      expect(a.getResources()).toHaveLength(1);

      await a.disconnect();
      expect(a.getTools()).toHaveLength(0);
      expect(a.getResources()).toHaveLength(0);

      a.shutdown();
    });

    it('returns defensive copies from getTools and getResources', async () => {
      const tools = [makeTool('read')];
      const mockSetup = createMockClient(tools);
      const a = new ManagedAdapter(config, {
        clientFactory: mockSetup.factory,
      });

      await a.connect();

      const copy1 = a.getTools();
      const copy2 = a.getTools();
      expect(copy1).toEqual(copy2);
      expect(copy1).not.toBe(copy2); // different array instances

      a.shutdown();
    });
  });

  // ── T013: Tool calls ──

  describe('callTool', () => {
    it('routes call to MCP client successfully', async () => {
      await adapter.connect();

      mock.callToolMock.mockResolvedValueOnce(makeToolCallResult('hello'));

      const result = await adapter.callTool('echo', { message: 'hello' });

      expect(result).toEqual(makeToolCallResult('hello'));
      expect(mock.callToolMock).toHaveBeenCalledWith({
        name: 'echo',
        arguments: { message: 'hello' },
      });
    });

    it('passes undefined args when none provided', async () => {
      await adapter.connect();

      await adapter.callTool('list');

      expect(mock.callToolMock).toHaveBeenCalledWith({
        name: 'list',
        arguments: undefined,
      });
    });

    it('throws ADAPTER_NOT_CONNECTED when not connected', async () => {
      await expect(adapter.callTool('echo')).rejects.toThrow(EngineError);

      try {
        await adapter.callTool('echo');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('ADAPTER_NOT_CONNECTED');
      }
    });

    it('throws ADAPTER_NOT_CONNECTED from error state', async () => {
      (mock.factory.createClient as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('fail'),
      );
      await expect(adapter.connect()).rejects.toThrow();

      try {
        await adapter.callTool('echo');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('ADAPTER_NOT_CONNECTED');
      }
    });

    it('handles error from MCP client', async () => {
      await adapter.connect();

      mock.callToolMock.mockRejectedValueOnce(new Error('Tool execution failed'));

      await expect(adapter.callTool('echo')).rejects.toThrow(EngineError);
    });

    it('handles timeout with configurable timeoutMs', async () => {
      const slowConfig = makeConfig({ timeoutMs: 100 });
      const slowAdapter = new ManagedAdapter(slowConfig, {
        clientFactory: mock.factory,
      });

      await slowAdapter.connect();

      // Make the tool call hang indefinitely
      mock.callToolMock.mockImplementationOnce(
        () => new Promise(() => {}), // never resolves
      );

      const callPromise = slowAdapter.callTool('echo');

      // Advance past the timeout
      vi.advanceTimersByTime(101);

      await expect(callPromise).rejects.toThrow(EngineError);

      try {
        // Re-create the scenario to inspect the error
        mock.callToolMock.mockImplementationOnce(
          () => new Promise(() => {}),
        );
        const callPromise2 = slowAdapter.callTool('echo');
        vi.advanceTimersByTime(101);
        await callPromise2;
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('ADAPTER_TIMEOUT');
        expect((err as EngineError).message).toContain('timed out');
      }

      slowAdapter.shutdown();
    });

    it('records circuit breaker success on successful call', async () => {
      await adapter.connect();

      // Make a successful call
      await adapter.callTool('echo');

      // Consecutive failures should be 0
      expect(adapter.getConsecutiveFailures()).toBe(0);
    });

    it('records circuit breaker failure on failed call', async () => {
      await adapter.connect();

      mock.callToolMock.mockRejectedValueOnce(new Error('fail'));

      await expect(adapter.callTool('echo')).rejects.toThrow();

      expect(adapter.getConsecutiveFailures()).toBe(1);
    });

    it('throws ADAPTER_CIRCUIT_OPEN when circuit breaker is tripped', async () => {
      const cbConfig = makeConfig({ failureThreshold: 2 });
      const cbAdapter = new ManagedAdapter(cbConfig, {
        clientFactory: mock.factory,
      });

      await cbAdapter.connect();

      // Trigger failures to trip the circuit breaker
      mock.callToolMock.mockRejectedValue(new Error('fail'));

      await expect(cbAdapter.callTool('echo')).rejects.toThrow();
      await expect(cbAdapter.callTool('echo')).rejects.toThrow();

      // Circuit breaker should now be open
      try {
        await cbAdapter.callTool('echo');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('ADAPTER_CIRCUIT_OPEN');
      }

      cbAdapter.shutdown();
    });

    it('resets consecutive failures on successful call after failures', async () => {
      await adapter.connect();

      mock.callToolMock.mockRejectedValueOnce(new Error('fail'));
      await expect(adapter.callTool('echo')).rejects.toThrow();
      expect(adapter.getConsecutiveFailures()).toBe(1);

      mock.callToolMock.mockResolvedValueOnce(makeToolCallResult('ok'));
      await adapter.callTool('echo');
      expect(adapter.getConsecutiveFailures()).toBe(0);
    });
  });

  // ── readResource ──

  describe('readResource', () => {
    it('reads a resource from the MCP client', async () => {
      await adapter.connect();

      mock.readResourceMock.mockResolvedValueOnce({
        contents: [
          { uri: 'file:///data.json', text: '{"key":"value"}', mimeType: 'application/json' },
        ],
      });

      const result = await adapter.readResource('file:///data.json');

      expect(result).toEqual({
        uri: 'file:///data.json',
        text: '{"key":"value"}',
        blob: undefined,
        mimeType: 'application/json',
      });
      expect(mock.readResourceMock).toHaveBeenCalledWith({
        uri: 'file:///data.json',
      });
    });

    it('throws ADAPTER_NOT_CONNECTED when not connected', async () => {
      try {
        await adapter.readResource('file:///x');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('ADAPTER_NOT_CONNECTED');
      }
    });

    it('throws RESOURCE_NOT_FOUND when MCP returns empty contents', async () => {
      await adapter.connect();

      mock.readResourceMock.mockResolvedValueOnce({ contents: [] });

      try {
        await adapter.readResource('file:///missing');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('RESOURCE_NOT_FOUND');
      }
    });

    it('handles timeout on readResource', async () => {
      const slowConfig = makeConfig({ timeoutMs: 50 });
      const slowAdapter = new ManagedAdapter(slowConfig, {
        clientFactory: mock.factory,
      });

      await slowAdapter.connect();

      mock.readResourceMock.mockImplementationOnce(
        () => new Promise(() => {}),
      );

      const readPromise = slowAdapter.readResource('file:///slow');
      vi.advanceTimersByTime(51);

      try {
        await readPromise;
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('ADAPTER_TIMEOUT');
      }

      slowAdapter.shutdown();
    });

    it('records circuit breaker failure on read error', async () => {
      await adapter.connect();

      mock.readResourceMock.mockRejectedValueOnce(new Error('read fail'));

      await expect(adapter.readResource('file:///x')).rejects.toThrow();
      expect(adapter.getConsecutiveFailures()).toBe(1);
    });

    it('records circuit breaker success on successful read', async () => {
      await adapter.connect();

      // Default mock returns valid content
      await adapter.readResource('file:///data');
      expect(adapter.getConsecutiveFailures()).toBe(0);
    });
  });

  // ── T038: Additional readResource tests ──

  describe('readResource content mapping', () => {
    it('maps text content correctly', async () => {
      await adapter.connect();

      mock.readResourceMock.mockResolvedValueOnce({
        contents: [
          { uri: 'file:///doc.txt', text: 'Hello World', mimeType: 'text/plain' },
        ],
      });

      const result = await adapter.readResource('file:///doc.txt');
      expect(result.uri).toBe('file:///doc.txt');
      expect(result.text).toBe('Hello World');
      expect(result.mimeType).toBe('text/plain');
      expect(result.blob).toBeUndefined();
    });

    it('maps blob content correctly', async () => {
      await adapter.connect();

      const base64Data = Buffer.from('binary data').toString('base64');
      mock.readResourceMock.mockResolvedValueOnce({
        contents: [
          { uri: 'file:///image.png', blob: base64Data, mimeType: 'image/png' },
        ],
      });

      const result = await adapter.readResource('file:///image.png');
      expect(result.uri).toBe('file:///image.png');
      expect(result.blob).toBe(base64Data);
      expect(result.mimeType).toBe('image/png');
      expect(result.text).toBeUndefined();
    });

    it('handles content with no mimeType', async () => {
      await adapter.connect();

      mock.readResourceMock.mockResolvedValueOnce({
        contents: [
          { uri: 'file:///data', text: 'raw data' },
        ],
      });

      const result = await adapter.readResource('file:///data');
      expect(result.uri).toBe('file:///data');
      expect(result.text).toBe('raw data');
      expect(result.mimeType).toBeUndefined();
    });

    it('returns only the first content item when multiple are present', async () => {
      await adapter.connect();

      mock.readResourceMock.mockResolvedValueOnce({
        contents: [
          { uri: 'file:///first', text: 'first content', mimeType: 'text/plain' },
          { uri: 'file:///second', text: 'second content', mimeType: 'text/plain' },
        ],
      });

      const result = await adapter.readResource('file:///first');
      expect(result.text).toBe('first content');
    });

    it('reads resource by exact URI', async () => {
      await adapter.connect();

      mock.readResourceMock.mockResolvedValueOnce({
        contents: [
          { uri: 'https://api.example.com/v1/data?format=json', text: '{"ok":true}', mimeType: 'application/json' },
        ],
      });

      const result = await adapter.readResource('https://api.example.com/v1/data?format=json');
      expect(mock.readResourceMock).toHaveBeenCalledWith({
        uri: 'https://api.example.com/v1/data?format=json',
      });
      expect(result.uri).toBe('https://api.example.com/v1/data?format=json');
      expect(result.text).toBe('{"ok":true}');
    });
  });

  // ── T017: Disconnect ──

  describe('disconnect', () => {
    it('closes MCP client and transport', async () => {
      await adapter.connect();
      await adapter.disconnect();

      expect(mock.clientCloseMock).toHaveBeenCalledOnce();
      expect(mock.transportCloseMock).toHaveBeenCalledOnce();
    });

    it('clears tools and resources', async () => {
      const tools = [makeTool('a'), makeTool('b')];
      const mockSetup = createMockClient(tools, [makeResource('r', 'r')]);
      const a = new ManagedAdapter(config, { clientFactory: mockSetup.factory });

      await a.connect();
      expect(a.getTools()).toHaveLength(2);
      expect(a.getResources()).toHaveLength(1);

      await a.disconnect();
      expect(a.getTools()).toHaveLength(0);
      expect(a.getResources()).toHaveLength(0);

      a.shutdown();
    });

    it('transitions to disconnected', async () => {
      await adapter.connect();
      await adapter.disconnect();

      expect(adapter.state).toBe('disconnected');
    });

    it('is safe to call when already disconnected', async () => {
      await adapter.disconnect(); // should not throw
      expect(adapter.state).toBe('disconnected');
    });

    it('swallows errors from client.close()', async () => {
      await adapter.connect();

      mock.clientCloseMock.mockRejectedValueOnce(new Error('close failed'));

      // Should not throw
      await adapter.disconnect();
      expect(adapter.state).toBe('disconnected');
    });

    it('swallows errors from transport.close()', async () => {
      await adapter.connect();

      mock.transportCloseMock.mockRejectedValueOnce(new Error('transport close failed'));

      // Should not throw
      await adapter.disconnect();
      expect(adapter.state).toBe('disconnected');
    });

    it('stops health check timer on disconnect', async () => {
      const hcConfig = makeConfig({ healthCheckIntervalMs: 5000 });
      const hcMock = createMockClient();
      const hcAdapter = new ManagedAdapter(hcConfig, {
        clientFactory: hcMock.factory,
      });

      await hcAdapter.connect();
      // Health check timer is now running

      await hcAdapter.disconnect();

      // Advance time well past health check interval — no health check should fire
      hcMock.listToolsMock.mockClear();
      vi.advanceTimersByTime(15_000);

      // listTools was called once during connect discovery, but not again after disconnect
      expect(hcMock.listToolsMock).not.toHaveBeenCalled();

      hcAdapter.shutdown();
    });
  });

  // ── Health check ──

  describe('health check', () => {
    it('transitions to error state on health check failure', async () => {
      const hcConfig = makeConfig({ healthCheckIntervalMs: 1000 });
      const hcMock = createMockClient();
      const hcAdapter = new ManagedAdapter(hcConfig, {
        clientFactory: hcMock.factory,
      });

      await hcAdapter.connect();
      expect(hcAdapter.state).toBe('connected');

      // Make health check fail
      hcMock.listToolsMock.mockRejectedValueOnce(new Error('health check fail'));

      // Advance to trigger one health check interval
      await vi.advanceTimersByTimeAsync(1001);

      expect(hcAdapter.state).toBe('error');
      expect(hcAdapter.getLastError()).toBe('Health check failed');

      hcAdapter.shutdown();
    });

    it('updates lastHealthCheck on successful health check', async () => {
      const hcConfig = makeConfig({ healthCheckIntervalMs: 1000 });
      const hcMock = createMockClient();
      const hcAdapter = new ManagedAdapter(hcConfig, {
        clientFactory: hcMock.factory,
      });

      await hcAdapter.connect();
      const firstCheck = hcAdapter.getLastHealthCheck();
      expect(firstCheck).not.toBeNull();

      // Advance time to trigger one health check
      await vi.advanceTimersByTimeAsync(1001);

      const secondCheck = hcAdapter.getLastHealthCheck();
      expect(secondCheck).not.toBeNull();
      expect(secondCheck!.getTime()).toBeGreaterThanOrEqual(firstCheck!.getTime());

      hcAdapter.shutdown();
    });
  });

  // ── Config / getters ──

  describe('config and getters', () => {
    it('exposes the adapter name from config', () => {
      expect(adapter.name).toBe('test-adapter');
    });

    it('exposes the config object', () => {
      expect(adapter.config).toBe(config);
    });

    it('getLastError returns null initially', () => {
      expect(adapter.getLastError()).toBeNull();
    });

    it('getLastHealthCheck returns null before first connect', () => {
      expect(adapter.getLastHealthCheck()).toBeNull();
    });

    it('getConsecutiveFailures returns 0 initially', () => {
      expect(adapter.getConsecutiveFailures()).toBe(0);
    });
  });

  // ── Shutdown ──

  describe('shutdown', () => {
    it('cleans up timers without throwing', async () => {
      await adapter.connect();

      // Should not throw
      adapter.shutdown();
    });

    it('is safe to call multiple times', () => {
      adapter.shutdown();
      adapter.shutdown(); // should not throw
    });

    it('is safe to call before connect', () => {
      const fresh = new ManagedAdapter(config, {
        clientFactory: mock.factory,
      });
      fresh.shutdown(); // should not throw
    });
  });

  // ── No client factory ──

  describe('missing client factory', () => {
    it('throws descriptive error when no factory is configured', async () => {
      const noFactoryAdapter = new ManagedAdapter(config);

      await expect(noFactoryAdapter.connect()).rejects.toThrow(EngineError);
      expect(noFactoryAdapter.state).toBe('error');
      expect(noFactoryAdapter.getLastError()).toContain('No MCP client factory');

      noFactoryAdapter.shutdown();
    });
  });

  // ── Connection failure during tool/resource listing ──

  describe('discovery failure during connect', () => {
    it('transitions to error if listTools fails during connect', async () => {
      mock.listToolsMock.mockRejectedValueOnce(new Error('listTools failed'));

      // Need a fresh factory call that returns the client with failing listTools
      (mock.factory.createClient as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        client: mock.client,
        transport: mock.transport,
      });

      const a = new ManagedAdapter(config, { clientFactory: mock.factory });

      await expect(a.connect()).rejects.toThrow(EngineError);
      expect(a.state).toBe('error');

      a.shutdown();
    });

    it('transitions to error if listResources fails during connect', async () => {
      mock.listResourcesMock.mockRejectedValueOnce(
        new Error('listResources failed'),
      );

      (mock.factory.createClient as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        client: mock.client,
        transport: mock.transport,
      });

      const a = new ManagedAdapter(config, { clientFactory: mock.factory });

      await expect(a.connect()).rejects.toThrow(EngineError);
      expect(a.state).toBe('error');

      a.shutdown();
    });
  });

  // ── T026: Reconnection ──

  describe('reconnection', () => {
    it('attempts reconnection after transitioning to error from connected', async () => {
      const hcConfig = makeConfig({
        healthCheckIntervalMs: 1000,
        retryDelayMs: 500,
        retryAttempts: 3,
      });
      const hcMock = createMockClient();
      const hcAdapter = new ManagedAdapter(hcConfig, {
        clientFactory: hcMock.factory,
      });

      await hcAdapter.connect();
      expect(hcAdapter.state).toBe('connected');

      // Make health check fail to trigger error state
      hcMock.listToolsMock.mockRejectedValueOnce(new Error('health check fail'));
      await vi.advanceTimersByTimeAsync(1001);
      expect(hcAdapter.state).toBe('error');

      // Reset mock so reconnection succeeds
      hcMock.listToolsMock.mockResolvedValue({ tools: [makeTool('echo')] });
      hcMock.listResourcesMock.mockResolvedValue({ resources: [] });
      (hcMock.factory.createClient as ReturnType<typeof vi.fn>).mockResolvedValue({
        client: hcMock.client,
        transport: hcMock.transport,
      });

      // Advance past the reconnection delay (500ms for attempt 0)
      await vi.advanceTimersByTimeAsync(501);
      expect(hcAdapter.state).toBe('connected');

      hcAdapter.shutdown();
    });

    it('uses exponential backoff for reconnection delays', async () => {
      const hcConfig = makeConfig({
        healthCheckIntervalMs: 1000,
        retryDelayMs: 1000,
        retryAttempts: 5,
        failureThreshold: 20, // High threshold so circuit breaker doesn't interfere
      });
      const hcMock = createMockClient();
      const hcAdapter = new ManagedAdapter(hcConfig, {
        clientFactory: hcMock.factory,
      });

      await hcAdapter.connect();

      // Trigger error via health check
      hcMock.listToolsMock.mockRejectedValueOnce(new Error('fail'));
      await vi.advanceTimersByTimeAsync(1001);
      expect(hcAdapter.state).toBe('error');
      expect(hcAdapter.getReconnectAttempt()).toBe(0);

      // Make reconnect attempts fail
      (hcMock.factory.createClient as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('still down'),
      );

      // Attempt 0: delay = 1000 * 2^0 = 1000ms. Fire it.
      await vi.advanceTimersByTimeAsync(1001);
      expect(hcAdapter.getReconnectAttempt()).toBe(1);

      // Attempt 1: delay = 1000 * 2^1 = 2000ms. Fire it.
      await vi.advanceTimersByTimeAsync(2001);
      expect(hcAdapter.getReconnectAttempt()).toBe(2);

      // Attempt 2: delay = 1000 * 2^2 = 4000ms. Fire it.
      await vi.advanceTimersByTimeAsync(4001);
      expect(hcAdapter.getReconnectAttempt()).toBe(3);

      // Verify the delays doubled each time: 1000, 2000, 4000
      // (If they didn't double, all 3 would have fired in the first 1001ms advance)

      hcAdapter.shutdown();
    });

    it('caps backoff delay at 60 seconds', async () => {
      const hcConfig = makeConfig({
        healthCheckIntervalMs: 1000,
        retryDelayMs: 10000, // 10s base delay
        retryAttempts: 10,
        failureThreshold: 20, // High threshold so circuit breaker doesn't interfere
      });
      const hcMock = createMockClient();
      const hcAdapter = new ManagedAdapter(hcConfig, {
        clientFactory: hcMock.factory,
      });

      await hcAdapter.connect();

      // Trigger error via health check
      hcMock.listToolsMock.mockRejectedValueOnce(new Error('fail'));
      await vi.advanceTimersByTimeAsync(1001);
      expect(hcAdapter.state).toBe('error');

      // Make reconnect fail
      (hcMock.factory.createClient as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('still down'),
      );

      // Attempt 0: delay = min(10000 * 1, 60000) = 10000ms
      await vi.advanceTimersByTimeAsync(10001);
      expect(hcAdapter.getReconnectAttempt()).toBe(1);

      // Attempt 1: delay = min(10000 * 2, 60000) = 20000ms
      await vi.advanceTimersByTimeAsync(20001);
      expect(hcAdapter.getReconnectAttempt()).toBe(2);

      // Attempt 2: delay = min(10000 * 4, 60000) = 40000ms
      await vi.advanceTimersByTimeAsync(40001);
      expect(hcAdapter.getReconnectAttempt()).toBe(3);

      // Attempt 3: delay = min(10000 * 8, 60000) = 60000ms (capped)
      await vi.advanceTimersByTimeAsync(60001);
      expect(hcAdapter.getReconnectAttempt()).toBe(4);

      hcAdapter.shutdown();
    });

    it('stops retrying after max attempts', async () => {
      const hcConfig = makeConfig({
        healthCheckIntervalMs: 1000,
        retryDelayMs: 100,
        retryAttempts: 2,
      });
      const hcMock = createMockClient();
      const hcAdapter = new ManagedAdapter(hcConfig, {
        clientFactory: hcMock.factory,
      });

      await hcAdapter.connect();

      // Trigger error via health check
      hcMock.listToolsMock.mockRejectedValueOnce(new Error('fail'));
      await vi.advanceTimersByTimeAsync(1001);
      expect(hcAdapter.state).toBe('error');

      // Make reconnect fail
      (hcMock.factory.createClient as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('still down'),
      );

      // Attempt 0: delay = 100ms
      await vi.advanceTimersByTimeAsync(101);
      expect(hcAdapter.getReconnectAttempt()).toBe(1);

      // Attempt 1: delay = 200ms
      await vi.advanceTimersByTimeAsync(201);
      expect(hcAdapter.getReconnectAttempt()).toBe(2);

      // No more attempts — should remain in error
      await vi.advanceTimersByTimeAsync(10000);
      expect(hcAdapter.state).toBe('error');
      expect(hcAdapter.getReconnectAttempt()).toBe(2);

      hcAdapter.shutdown();
    });

    it('defaults to 3 max retry attempts when retryAttempts is not configured', async () => {
      const hcConfig = makeConfig({
        healthCheckIntervalMs: 1000,
        retryDelayMs: 100,
        failureThreshold: 20, // High threshold so circuit breaker doesn't interfere
        // retryAttempts not set — should default to 3
      });
      const hcMock = createMockClient();
      const hcAdapter = new ManagedAdapter(hcConfig, {
        clientFactory: hcMock.factory,
      });

      await hcAdapter.connect();

      // Trigger error via health check
      hcMock.listToolsMock.mockRejectedValueOnce(new Error('fail'));
      await vi.advanceTimersByTimeAsync(1001);
      expect(hcAdapter.state).toBe('error');

      // Make reconnect fail
      (hcMock.factory.createClient as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('still down'),
      );

      // Exhaust all 3 attempts
      await vi.advanceTimersByTimeAsync(101); // attempt 0: 100ms
      expect(hcAdapter.getReconnectAttempt()).toBe(1);
      await vi.advanceTimersByTimeAsync(201); // attempt 1: 200ms
      expect(hcAdapter.getReconnectAttempt()).toBe(2);
      await vi.advanceTimersByTimeAsync(401); // attempt 2: 400ms
      expect(hcAdapter.getReconnectAttempt()).toBe(3);

      // No more attempts
      await vi.advanceTimersByTimeAsync(10000);
      expect(hcAdapter.getReconnectAttempt()).toBe(3);

      hcAdapter.shutdown();
    });

    it('transitions error -> connecting -> connected on successful reconnect', async () => {
      const hcConfig = makeConfig({
        healthCheckIntervalMs: 1000,
        retryDelayMs: 100,
        retryAttempts: 3,
      });
      const hcMock = createMockClient();
      const hcAdapter = new ManagedAdapter(hcConfig, {
        clientFactory: hcMock.factory,
      });

      await hcAdapter.connect();

      // Trigger error via health check
      hcMock.listToolsMock.mockRejectedValueOnce(new Error('fail'));
      await vi.advanceTimersByTimeAsync(1001);
      expect(hcAdapter.state).toBe('error');

      // Track transitions during reconnection
      const transitions: Array<{ from: AdapterState; to: AdapterState }> = [];
      hcAdapter.onStateChange = (_adapter, from, to) => {
        transitions.push({ from, to });
      };

      // Reset mocks to succeed
      hcMock.listToolsMock.mockResolvedValue({ tools: [makeTool('echo')] });
      hcMock.listResourcesMock.mockResolvedValue({ resources: [] });
      (hcMock.factory.createClient as ReturnType<typeof vi.fn>).mockResolvedValue({
        client: hcMock.client,
        transport: hcMock.transport,
      });

      await vi.advanceTimersByTimeAsync(101);

      expect(transitions).toEqual([
        { from: 'error', to: 'connecting' },
        { from: 'connecting', to: 'connected' },
      ]);
      expect(hcAdapter.state).toBe('connected');

      hcAdapter.shutdown();
    });

    it('rediscovers tools after successful reconnect', async () => {
      const initialTools = [makeTool('v1')];
      const reconnectTools = [makeTool('v1'), makeTool('v2-new')];
      const hcConfig = makeConfig({
        healthCheckIntervalMs: 1000,
        retryDelayMs: 100,
        retryAttempts: 3,
      });
      const hcMock = createMockClient(initialTools);
      const hcAdapter = new ManagedAdapter(hcConfig, {
        clientFactory: hcMock.factory,
      });

      const discovered: string[][] = [];
      hcAdapter.onToolsDiscovered = (_adapter, names) => {
        discovered.push(names);
      };

      await hcAdapter.connect();
      expect(discovered).toEqual([['v1']]);

      // Trigger error
      hcMock.listToolsMock.mockRejectedValueOnce(new Error('fail'));
      await vi.advanceTimersByTimeAsync(1001);
      expect(hcAdapter.state).toBe('error');

      // Set up reconnect with updated tools
      hcMock.listToolsMock.mockResolvedValue({ tools: reconnectTools });
      hcMock.listResourcesMock.mockResolvedValue({ resources: [] });
      (hcMock.factory.createClient as ReturnType<typeof vi.fn>).mockResolvedValue({
        client: hcMock.client,
        transport: hcMock.transport,
      });

      await vi.advanceTimersByTimeAsync(101);

      expect(hcAdapter.state).toBe('connected');
      expect(discovered).toEqual([['v1'], ['v1', 'v2-new']]);
      expect(hcAdapter.getTools().map((t) => t.name)).toEqual(['v1', 'v2-new']);

      hcAdapter.shutdown();
    });

    it('resets reconnect attempt counter after successful reconnect', async () => {
      const hcConfig = makeConfig({
        healthCheckIntervalMs: 1000,
        retryDelayMs: 100,
        retryAttempts: 5,
      });
      const hcMock = createMockClient();
      const hcAdapter = new ManagedAdapter(hcConfig, {
        clientFactory: hcMock.factory,
      });

      await hcAdapter.connect();

      // Trigger error
      hcMock.listToolsMock.mockRejectedValueOnce(new Error('fail'));
      await vi.advanceTimersByTimeAsync(1001);
      expect(hcAdapter.state).toBe('error');

      // Fail first reconnect attempt
      (hcMock.factory.createClient as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('still down'),
      );
      await vi.advanceTimersByTimeAsync(101);
      expect(hcAdapter.getReconnectAttempt()).toBe(1);

      // Succeed on second attempt
      hcMock.listToolsMock.mockResolvedValue({ tools: [makeTool('echo')] });
      hcMock.listResourcesMock.mockResolvedValue({ resources: [] });
      (hcMock.factory.createClient as ReturnType<typeof vi.fn>).mockResolvedValue({
        client: hcMock.client,
        transport: hcMock.transport,
      });
      await vi.advanceTimersByTimeAsync(201);

      expect(hcAdapter.state).toBe('connected');
      expect(hcAdapter.getReconnectAttempt()).toBe(0);

      hcAdapter.shutdown();
    });

    it('does not trigger reconnection when connect() fails initially', async () => {
      const reconConfig = makeConfig({
        retryDelayMs: 100,
        retryAttempts: 3,
      });

      (mock.factory.createClient as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Connection refused'),
      );

      const a = new ManagedAdapter(reconConfig, { clientFactory: mock.factory });
      await expect(a.connect()).rejects.toThrow(EngineError);
      expect(a.state).toBe('error');

      // Advance time — no reconnection should happen because transition
      // was from 'connecting' to 'error', not 'connected' to 'error'
      await vi.advanceTimersByTimeAsync(10000);
      expect(a.state).toBe('error');

      a.shutdown();
    });

    it('cancels reconnection on explicit disconnect', async () => {
      const hcConfig = makeConfig({
        healthCheckIntervalMs: 1000,
        retryDelayMs: 500,
        retryAttempts: 3,
      });
      const hcMock = createMockClient();
      const hcAdapter = new ManagedAdapter(hcConfig, {
        clientFactory: hcMock.factory,
      });

      await hcAdapter.connect();

      // Trigger error
      hcMock.listToolsMock.mockRejectedValueOnce(new Error('fail'));
      await vi.advanceTimersByTimeAsync(1001);
      expect(hcAdapter.state).toBe('error');

      // Disconnect before reconnection fires
      await hcAdapter.disconnect();
      expect(hcAdapter.state).toBe('disconnected');

      // Advance past reconnection delay — should not attempt reconnect
      (hcMock.factory.createClient as ReturnType<typeof vi.fn>).mockResolvedValue({
        client: hcMock.client,
        transport: hcMock.transport,
      });
      const factoryCallCount = (hcMock.factory.createClient as ReturnType<typeof vi.fn>).mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);

      // Factory should not have been called again
      expect((hcMock.factory.createClient as ReturnType<typeof vi.fn>).mock.calls.length).toBe(factoryCallCount);
      expect(hcAdapter.state).toBe('disconnected');

      hcAdapter.shutdown();
    });

    it('pauses reconnection when circuit breaker is open', async () => {
      const hcConfig = makeConfig({
        healthCheckIntervalMs: 1000,
        retryDelayMs: 100,
        retryAttempts: 5,
        failureThreshold: 2,
        cooldownMs: 5000,
      });
      const hcMock = createMockClient();
      const hcAdapter = new ManagedAdapter(hcConfig, {
        clientFactory: hcMock.factory,
      });

      await hcAdapter.connect();

      // Record failures to trip circuit breaker before the health check error
      hcMock.callToolMock.mockRejectedValueOnce(new Error('fail'));
      try { await hcAdapter.callTool('echo'); } catch { /* expected */ }
      hcMock.callToolMock.mockRejectedValueOnce(new Error('fail'));
      try { await hcAdapter.callTool('echo'); } catch { /* expected */ }

      // Circuit breaker should now be open/unhealthy
      // Trigger error state via health check
      hcMock.listToolsMock.mockRejectedValueOnce(new Error('fail'));
      await vi.advanceTimersByTimeAsync(1001);
      expect(hcAdapter.state).toBe('error');

      // Reconnection should be paused because circuit breaker is open
      (hcMock.factory.createClient as ReturnType<typeof vi.fn>).mockResolvedValue({
        client: hcMock.client,
        transport: hcMock.transport,
      });
      const factoryCallCount = (hcMock.factory.createClient as ReturnType<typeof vi.fn>).mock.calls.length;

      await vi.advanceTimersByTimeAsync(500);
      // Factory should not have been called for reconnection
      expect((hcMock.factory.createClient as ReturnType<typeof vi.fn>).mock.calls.length).toBe(factoryCallCount);

      hcAdapter.shutdown();
    });
  });

  // ── T027: Extended health check tests ──

  describe('health check (extended)', () => {
    it('runs health check at the configured interval', async () => {
      const hcConfig = makeConfig({ healthCheckIntervalMs: 2000 });
      const hcMock = createMockClient();
      const hcAdapter = new ManagedAdapter(hcConfig, {
        clientFactory: hcMock.factory,
      });

      await hcAdapter.connect();

      // listTools is called once during connect for tool discovery
      const initialCallCount = hcMock.listToolsMock.mock.calls.length;

      // Advance past one health check interval
      await vi.advanceTimersByTimeAsync(2001);
      expect(hcMock.listToolsMock.mock.calls.length).toBe(initialCallCount + 1);

      // Advance past another interval
      await vi.advanceTimersByTimeAsync(2001);
      expect(hcMock.listToolsMock.mock.calls.length).toBe(initialCallCount + 2);

      hcAdapter.shutdown();
    });

    it('health check failure triggers error state and reconnection', async () => {
      const hcConfig = makeConfig({
        healthCheckIntervalMs: 1000,
        retryDelayMs: 200,
        retryAttempts: 3,
      });
      const hcMock = createMockClient();
      const hcAdapter = new ManagedAdapter(hcConfig, {
        clientFactory: hcMock.factory,
      });

      await hcAdapter.connect();
      expect(hcAdapter.state).toBe('connected');

      // Health check fails
      hcMock.listToolsMock.mockRejectedValueOnce(new Error('ping failed'));
      await vi.advanceTimersByTimeAsync(1001);
      expect(hcAdapter.state).toBe('error');

      // Reconnection should be scheduled — let it succeed
      hcMock.listToolsMock.mockResolvedValue({ tools: [makeTool('echo')] });
      hcMock.listResourcesMock.mockResolvedValue({ resources: [] });
      (hcMock.factory.createClient as ReturnType<typeof vi.fn>).mockResolvedValue({
        client: hcMock.client,
        transport: hcMock.transport,
      });

      await vi.advanceTimersByTimeAsync(201);
      expect(hcAdapter.state).toBe('connected');

      hcAdapter.shutdown();
    });

    it('health check success updates lastHealthCheck timestamp', async () => {
      const hcConfig = makeConfig({ healthCheckIntervalMs: 1000 });
      const hcMock = createMockClient();
      const hcAdapter = new ManagedAdapter(hcConfig, {
        clientFactory: hcMock.factory,
      });

      await hcAdapter.connect();
      const connectTime = hcAdapter.getLastHealthCheck();
      expect(connectTime).not.toBeNull();

      // Advance to trigger health check
      vi.setSystemTime(new Date(Date.now() + 5000));
      await vi.advanceTimersByTimeAsync(1001);

      const afterCheck = hcAdapter.getLastHealthCheck();
      expect(afterCheck).not.toBeNull();
      expect(afterCheck!.getTime()).toBeGreaterThanOrEqual(connectTime!.getTime());

      hcAdapter.shutdown();
    });

    it('does not run health checks when interval is 0', async () => {
      const hcConfig = makeConfig({ healthCheckIntervalMs: 0 });
      const hcMock = createMockClient();
      const hcAdapter = new ManagedAdapter(hcConfig, {
        clientFactory: hcMock.factory,
      });

      await hcAdapter.connect();
      const initialCallCount = hcMock.listToolsMock.mock.calls.length;

      // Advance a long time
      await vi.advanceTimersByTimeAsync(60_000);

      // No additional listTools calls beyond the initial discovery
      expect(hcMock.listToolsMock.mock.calls.length).toBe(initialCallCount);

      hcAdapter.shutdown();
    });

    it('health check does not fire after disconnect', async () => {
      const hcConfig = makeConfig({ healthCheckIntervalMs: 500 });
      const hcMock = createMockClient();
      const hcAdapter = new ManagedAdapter(hcConfig, {
        clientFactory: hcMock.factory,
      });

      await hcAdapter.connect();
      await hcAdapter.disconnect();

      hcMock.listToolsMock.mockClear();
      await vi.advanceTimersByTimeAsync(2000);

      expect(hcMock.listToolsMock).not.toHaveBeenCalled();

      hcAdapter.shutdown();
    });
  });
});
