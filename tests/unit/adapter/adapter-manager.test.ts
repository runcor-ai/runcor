// Unit tests for AdapterManager
// Covers adapter lifecycle management, tool routing, tool listing, and event emission.

import { describe, it, expect, vi } from 'vitest';
import { AdapterManager } from '../../../src/adapter/adapter-manager.js';
import { EngineInstrumentation } from '../../../src/telemetry/instrumentation.js';
import { EngineError } from '../../../src/errors.js';
import type {
  AdapterConfig,
  AdapterState,
  AdapterToolSchema,
  AdapterResourceSchema,
  ToolCallResult,
  ResourceContent,
} from '../../../src/types.js';

// ── Mock ManagedAdapter ──
// Matches the real ManagedAdapter's public interface so the mock passes
// through the factory injection point without type issues.

interface MockManagedAdapter {
  readonly config: AdapterConfig;
  readonly name: string;
  state: AdapterState;
  onStateChange:
    | ((adapter: MockManagedAdapter, from: AdapterState, to: AdapterState) => void)
    | undefined;
  onToolsDiscovered:
    | ((adapter: MockManagedAdapter, tools: string[]) => void)
    | undefined;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  readResource: ReturnType<typeof vi.fn>;
  getTools: () => AdapterToolSchema[];
  getResources: () => AdapterResourceSchema[];
  getLastHealthCheck: () => Date | null;
  getLastError: () => string | null;
  getConsecutiveFailures: () => number;
  // Internal state for test manipulation
  _tools: AdapterToolSchema[];
  _resources: AdapterResourceSchema[];
  _lastError: string | null;
}

function makeMockAdapter(config: AdapterConfig): MockManagedAdapter {
  const adapter: MockManagedAdapter = {
    config,
    name: config.name,
    state: 'disconnected' as AdapterState,
    onStateChange: undefined,
    onToolsDiscovered: undefined,
    _tools: [],
    _resources: [],
    _lastError: null,
    connect: vi.fn(async () => {
      adapter.state = 'connected';
    }),
    disconnect: vi.fn(async () => {
      adapter.state = 'disconnected';
    }),
    callTool: vi.fn(async (): Promise<ToolCallResult> => ({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    })),
    readResource: vi.fn(async (): Promise<ResourceContent> => ({
      uri: 'test://resource',
      text: 'resource content',
    })),
    getTools: () => adapter._tools,
    getResources: () => adapter._resources,
    getLastHealthCheck: () => null,
    getLastError: () => adapter._lastError,
    getConsecutiveFailures: () => 0,
  };
  return adapter;
}

// ── Helpers ──

function makeInstrumentation(): EngineInstrumentation {
  return new EngineInstrumentation({});
}

function makeStdioConfig(name: string): AdapterConfig {
  return {
    name,
    transport: 'stdio',
    command: '/usr/bin/echo',
    args: ['hello'],
  };
}

function makeSseConfig(name: string): AdapterConfig {
  return {
    name,
    transport: 'sse',
    url: 'http://localhost:3000/sse',
  };
}

function makeTool(name: string, description?: string): AdapterToolSchema {
  return {
    name,
    description: description ?? `${name} tool`,
    inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
  };
}

/**
 * Create an AdapterManager with a mock factory.
 * The factory records all created adapters in `createdAdapters` for test assertions.
 */
function createManager(
  createdAdapters: MockManagedAdapter[] = [],
): {
  manager: AdapterManager;
  emitEvent: ReturnType<typeof vi.fn>;
  createdAdapters: MockManagedAdapter[];
} {
  const emitEvent = vi.fn();

  const factory = (adapterConfig: AdapterConfig) => {
    const mock = makeMockAdapter(adapterConfig);
    createdAdapters.push(mock);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return mock as any;
  };

  const manager = new AdapterManager(
    undefined,
    makeInstrumentation(),
    emitEvent,
    factory,
  );

  return { manager, emitEvent, createdAdapters };
}

/**
 * Create an AdapterManager with a custom factory function.
 */
function createManagerWithFactory(
  factory: (config: AdapterConfig) => MockManagedAdapter,
): {
  manager: AdapterManager;
  emitEvent: ReturnType<typeof vi.fn>;
} {
  const emitEvent = vi.fn();

  const manager = new AdapterManager(
    undefined,
    makeInstrumentation(),
    emitEvent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory as any,
  );

  return { manager, emitEvent };
}

// ── Tests ──

describe('AdapterManager', () => {
  // ── T018: Management tests ──

  describe('addAdapter', () => {
    it('adds an adapter with valid stdio config', async () => {
      const adapters: MockManagedAdapter[] = [];
      const { manager } = createManager(adapters);

      await manager.addAdapter(makeStdioConfig('fs'));

      expect(adapters).toHaveLength(1);
      expect(adapters[0].connect).toHaveBeenCalledOnce();
      expect(manager.hasAdapters()).toBe(true);
    });

    it('adds an adapter with valid SSE config', async () => {
      const adapters: MockManagedAdapter[] = [];
      const { manager } = createManager(adapters);

      await manager.addAdapter(makeSseConfig('remote'));

      expect(adapters).toHaveLength(1);
      expect(adapters[0].connect).toHaveBeenCalledOnce();
    });

    it('throws DUPLICATE_ADAPTER when adding adapter with existing name', async () => {
      const { manager } = createManager();

      await manager.addAdapter(makeStdioConfig('fs'));

      await expect(manager.addAdapter(makeStdioConfig('fs'))).rejects.toThrow(EngineError);

      try {
        await manager.addAdapter(makeStdioConfig('fs'));
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('DUPLICATE_ADAPTER');
      }
    });

    it('throws on empty adapter name', async () => {
      const { manager } = createManager();
      const config = makeStdioConfig('');

      await expect(manager.addAdapter(config)).rejects.toThrow(EngineError);
    });

    it('throws on stdio config missing command', async () => {
      const { manager } = createManager();
      const config: AdapterConfig = { name: 'bad', transport: 'stdio' };

      await expect(manager.addAdapter(config)).rejects.toThrow(EngineError);
    });

    it('throws on SSE config missing url', async () => {
      const { manager } = createManager();
      const config: AdapterConfig = { name: 'bad', transport: 'sse' };

      await expect(manager.addAdapter(config)).rejects.toThrow(EngineError);
    });

    it('registers discovered tools in ToolRouter after connect', async () => {
      const mockAdapter = makeMockAdapter(makeStdioConfig('fs'));
      mockAdapter._tools = [makeTool('read'), makeTool('write')];
      mockAdapter.connect = vi.fn(async () => {
        mockAdapter.state = 'connected';
      });

      const { manager } = createManagerWithFactory(() => mockAdapter);

      await manager.addAdapter(makeStdioConfig('fs'));

      // Tools should be available via listTools
      const tools = manager.listTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.qualifiedName).sort()).toEqual([
        'fs.read',
        'fs.write',
      ]);
    });
  });

  describe('removeAdapter', () => {
    it('disconnects and removes the adapter', async () => {
      const adapters: MockManagedAdapter[] = [];
      const { manager } = createManager(adapters);

      await manager.addAdapter(makeStdioConfig('fs'));
      await manager.removeAdapter('fs');

      expect(adapters[0].disconnect).toHaveBeenCalledOnce();
      expect(manager.hasAdapters()).toBe(false);
      expect(manager.getAdapterInfo('fs')).toBeNull();
    });

    it('unregisters tools from ToolRouter on removal', async () => {
      const mockAdapter = makeMockAdapter(makeStdioConfig('myfs'));
      mockAdapter._tools = [makeTool('read')];
      mockAdapter.connect = vi.fn(async () => {
        mockAdapter.state = 'connected';
      });

      const { manager } = createManagerWithFactory(() => mockAdapter);

      await manager.addAdapter(makeStdioConfig('myfs'));
      expect(manager.listTools()).toHaveLength(1);

      await manager.removeAdapter('myfs');
      expect(manager.listTools()).toHaveLength(0);
    });

    it('is a no-op when removing a non-existent adapter', async () => {
      const { manager } = createManager();

      // Should not throw
      await expect(manager.removeAdapter('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('getAdapterInfo', () => {
    it('returns AdapterInfo for a registered adapter', async () => {
      const { manager } = createManager();

      await manager.addAdapter(makeStdioConfig('fs'));

      const info = manager.getAdapterInfo('fs');
      expect(info).not.toBeNull();
      expect(info!.name).toBe('fs');
      expect(info!.state).toBe('connected');
    });

    it('returns null for an unknown adapter', () => {
      const { manager } = createManager();

      expect(manager.getAdapterInfo('nonexistent')).toBeNull();
    });
  });

  describe('listAdapters', () => {
    it('returns info for all registered adapters', async () => {
      const { manager } = createManager();

      await manager.addAdapter(makeStdioConfig('fs'));
      await manager.addAdapter(makeSseConfig('remote'));

      const list = manager.listAdapters();
      expect(list).toHaveLength(2);

      const names = list.map((a) => a.name).sort();
      expect(names).toEqual(['fs', 'remote']);
    });

    it('returns empty array when no adapters registered', () => {
      const { manager } = createManager();

      expect(manager.listAdapters()).toEqual([]);
    });
  });

  describe('hasAdapters', () => {
    it('returns false when no adapters are registered', () => {
      const { manager } = createManager();

      expect(manager.hasAdapters()).toBe(false);
    });

    it('returns true when at least one adapter is registered', async () => {
      const { manager } = createManager();

      await manager.addAdapter(makeStdioConfig('fs'));

      expect(manager.hasAdapters()).toBe(true);
    });

    it('returns false after all adapters are removed', async () => {
      const { manager } = createManager();

      await manager.addAdapter(makeStdioConfig('fs'));
      await manager.removeAdapter('fs');

      expect(manager.hasAdapters()).toBe(false);
    });
  });

  // ── T019-T021: Tool calling and listing ──

  describe('callTool', () => {
    it('routes a tool call through ToolRouter to the correct adapter', async () => {
      const mockAdapter = makeMockAdapter(makeStdioConfig('fs'));
      mockAdapter._tools = [makeTool('read')];
      mockAdapter.connect = vi.fn(async () => {
        mockAdapter.state = 'connected';
      });

      const expectedResult: ToolCallResult = {
        content: [{ type: 'text', text: 'file contents' }],
        isError: false,
      };
      mockAdapter.callTool = vi.fn(async () => expectedResult);

      const { manager } = createManagerWithFactory(() => mockAdapter);

      await manager.addAdapter(makeStdioConfig('fs'));

      const result = await manager.callTool('fs.read', { path: '/tmp/file.txt' });

      expect(result).toEqual(expectedResult);
      expect(mockAdapter.callTool).toHaveBeenCalledWith('read', { path: '/tmp/file.txt' });
    });

    it('throws TOOL_NOT_FOUND for an unknown qualified tool name', async () => {
      const { manager } = createManager();

      await manager.addAdapter(makeStdioConfig('fs'));

      await expect(manager.callTool('fs.nonexistent')).rejects.toThrow(EngineError);

      try {
        await manager.callTool('fs.nonexistent');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('TOOL_NOT_FOUND');
      }
    });

    it('throws TOOL_NOT_FOUND when no adapter has the qualified tool', async () => {
      const { manager } = createManager();

      await expect(manager.callTool('unknown.tool')).rejects.toThrow(EngineError);

      try {
        await manager.callTool('unknown.tool');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('TOOL_NOT_FOUND');
      }
    });

    it('emits adapter:tool_call event on successful call', async () => {
      const mockAdapter = makeMockAdapter(makeStdioConfig('fs'));
      mockAdapter._tools = [makeTool('read')];
      mockAdapter.connect = vi.fn(async () => {
        mockAdapter.state = 'connected';
      });
      mockAdapter.callTool = vi.fn(async (): Promise<ToolCallResult> => ({
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }));

      const { manager, emitEvent } = createManagerWithFactory(() => mockAdapter);

      await manager.addAdapter(makeStdioConfig('fs'));
      await manager.callTool('fs.read');

      // Find the adapter:tool_call event
      const toolCallEvents = emitEvent.mock.calls.filter(
        ([type]: [string]) => type === 'adapter:tool_call',
      );
      expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);

      const payload = toolCallEvents[0][1] as Record<string, unknown>;
      expect(payload).toMatchObject({
        adapter: 'fs',
        tool: 'read',
        success: true,
      });
      expect(typeof payload.durationMs).toBe('number');
    });

    it('emits adapter:tool_call event with success=false on failed call', async () => {
      const mockAdapter = makeMockAdapter(makeStdioConfig('fs'));
      mockAdapter._tools = [makeTool('read')];
      mockAdapter.connect = vi.fn(async () => {
        mockAdapter.state = 'connected';
      });
      mockAdapter.callTool = vi.fn(async () => {
        throw new Error('MCP server crashed');
      });

      const { manager, emitEvent } = createManagerWithFactory(() => mockAdapter);

      await manager.addAdapter(makeStdioConfig('fs'));

      await expect(manager.callTool('fs.read')).rejects.toThrow('MCP server crashed');

      const toolCallEvents = emitEvent.mock.calls.filter(
        ([type]: [string]) => type === 'adapter:tool_call',
      );
      expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);

      const payload = toolCallEvents[0][1] as Record<string, unknown>;
      expect(payload).toMatchObject({
        adapter: 'fs',
        tool: 'read',
        success: false,
      });
    });

    it('correctly parses qualified names — splits on first dot', async () => {
      // Qualified name "my.adapter.tool" — ToolRouter stores the full qualified name,
      // so the adapter name is whatever the ToolRouter resolves.
      // Tool "adapter.tool" registered under adapter "my" produces qualified name "my.adapter.tool".
      // callTool splits on first dot: adapter="my", toolName="adapter.tool".
      const mockAdapter = makeMockAdapter(makeStdioConfig('my'));
      mockAdapter._tools = [makeTool('adapter.tool')];
      mockAdapter.connect = vi.fn(async () => {
        mockAdapter.state = 'connected';
      });

      const { manager } = createManagerWithFactory(() => mockAdapter);

      await manager.addAdapter(makeStdioConfig('my'));

      await manager.callTool('my.adapter.tool');
      expect(mockAdapter.callTool).toHaveBeenCalledWith('adapter.tool', undefined);
    });

    it('passes arguments through to the adapter callTool', async () => {
      const mockAdapter = makeMockAdapter(makeStdioConfig('db'));
      mockAdapter._tools = [makeTool('query')];
      mockAdapter.connect = vi.fn(async () => {
        mockAdapter.state = 'connected';
      });

      const { manager } = createManagerWithFactory(() => mockAdapter);

      await manager.addAdapter(makeStdioConfig('db'));

      const args = { sql: 'SELECT * FROM users', limit: 10 };
      await manager.callTool('db.query', args);

      expect(mockAdapter.callTool).toHaveBeenCalledWith('query', args);
    });
  });

  describe('listTools', () => {
    it('returns tools from all connected adapters', async () => {
      const adapters: MockManagedAdapter[] = [];
      let callCount = 0;

      const { manager } = createManagerWithFactory((config: AdapterConfig) => {
        const mock = makeMockAdapter(config);
        if (callCount === 0) {
          mock._tools = [makeTool('read'), makeTool('write')];
        } else {
          mock._tools = [makeTool('query')];
        }
        mock.connect = vi.fn(async () => {
          mock.state = 'connected';
        });
        adapters.push(mock);
        callCount++;
        return mock;
      });

      await manager.addAdapter(makeStdioConfig('fs'));
      await manager.addAdapter(makeSseConfig('db'));

      const tools = manager.listTools();
      expect(tools).toHaveLength(3);

      const qualifiedNames = tools.map((t) => t.qualifiedName).sort();
      expect(qualifiedNames).toEqual(['db.query', 'fs.read', 'fs.write']);
    });

    it('filters tools by adapter name', async () => {
      let callCount = 0;

      const { manager } = createManagerWithFactory((config: AdapterConfig) => {
        const mock = makeMockAdapter(config);
        if (callCount === 0) {
          mock._tools = [makeTool('read'), makeTool('write')];
        } else {
          mock._tools = [makeTool('query')];
        }
        mock.connect = vi.fn(async () => {
          mock.state = 'connected';
        });
        callCount++;
        return mock;
      });

      await manager.addAdapter(makeStdioConfig('fs'));
      await manager.addAdapter(makeSseConfig('db'));

      const fsTools = manager.listTools({ adapter: 'fs' });
      expect(fsTools).toHaveLength(2);
      expect(fsTools.every((t) => t.adapterName === 'fs')).toBe(true);

      const dbTools = manager.listTools({ adapter: 'db' });
      expect(dbTools).toHaveLength(1);
      expect(dbTools[0].qualifiedName).toBe('db.query');
    });

    it('excludes tools from disconnected adapters', async () => {
      const adapters: MockManagedAdapter[] = [];

      const { manager } = createManagerWithFactory((config: AdapterConfig) => {
        const mock = makeMockAdapter(config);
        mock._tools = [makeTool('read')];
        mock.connect = vi.fn(async () => {
          mock.state = 'connected';
        });
        adapters.push(mock);
        return mock;
      });

      await manager.addAdapter(makeStdioConfig('fs'));
      expect(manager.listTools()).toHaveLength(1);

      // Simulate adapter going into disconnected state
      adapters[0].state = 'disconnected';

      const tools = manager.listTools();
      expect(tools).toHaveLength(0);
    });

    it('excludes tools from adapters in error state', async () => {
      const adapters: MockManagedAdapter[] = [];

      const { manager } = createManagerWithFactory((config: AdapterConfig) => {
        const mock = makeMockAdapter(config);
        mock._tools = [makeTool('read')];
        mock.connect = vi.fn(async () => {
          mock.state = 'connected';
        });
        adapters.push(mock);
        return mock;
      });

      await manager.addAdapter(makeStdioConfig('fs'));
      expect(manager.listTools()).toHaveLength(1);

      // Simulate adapter going into error state
      adapters[0].state = 'error';

      const tools = manager.listTools();
      expect(tools).toHaveLength(0);
    });

    it('returns empty array when no adapters are registered', () => {
      const { manager } = createManager();

      expect(manager.listTools()).toEqual([]);
    });

    it('returns empty array when filter matches no adapter', async () => {
      const { manager } = createManager();

      await manager.addAdapter(makeStdioConfig('fs'));

      expect(manager.listTools({ adapter: 'nonexistent' })).toEqual([]);
    });
  });

  // ── T039: Resource operations with caching ──

  describe('resource operations', () => {
    it('routes resource read to correct adapter by name', async () => {
      let callCount = 0;
      const adapters: MockManagedAdapter[] = [];
      const { manager } = createManagerWithFactory((config: AdapterConfig) => {
        const mock = makeMockAdapter(config);
        mock.connect = vi.fn(async () => { mock.state = 'connected'; });
        if (callCount === 0) {
          mock.readResource = vi.fn(async (): Promise<ResourceContent> => ({
            uri: 'file:///alpha.txt',
            text: 'alpha content',
          }));
        } else {
          mock.readResource = vi.fn(async (): Promise<ResourceContent> => ({
            uri: 'file:///beta.txt',
            text: 'beta content',
          }));
        }
        adapters.push(mock);
        callCount++;
        return mock;
      });

      await manager.addAdapter(makeStdioConfig('alpha'));
      await manager.addAdapter(makeSseConfig('beta'));

      const result = await manager.readResource('alpha', 'file:///alpha.txt');
      expect(result.text).toBe('alpha content');
      expect(adapters[0].readResource).toHaveBeenCalledWith('file:///alpha.txt');
      expect(adapters[1].readResource).not.toHaveBeenCalled();
    });

    it('caches resource on second read (no second fetch)', async () => {
      const mockAdapter = makeMockAdapter(makeSseConfig('docs'));
      mockAdapter.connect = vi.fn(async () => { mockAdapter.state = 'connected'; });
      // Override config to set a cache TTL
      (mockAdapter as any).config = { ...mockAdapter.config, resourceCacheTtlMs: 60_000 };

      let fetchCount = 0;
      mockAdapter.readResource = vi.fn(async (): Promise<ResourceContent> => {
        fetchCount++;
        return { uri: 'file:///readme.md', text: `content-v${fetchCount}` };
      });

      const { manager } = createManagerWithFactory(() => mockAdapter);
      await manager.addAdapter(makeSseConfig('docs'));

      // First read — cache miss, fetches from adapter
      const result1 = await manager.readResource('docs', 'file:///readme.md');
      expect(result1.text).toBe('content-v1');
      expect(fetchCount).toBe(1);

      // Second read — cache hit, no second fetch
      const result2 = await manager.readResource('docs', 'file:///readme.md');
      expect(result2.text).toBe('content-v1'); // same cached content
      expect(fetchCount).toBe(1); // still only one fetch
    });

    it('cache miss triggers fresh fetch from adapter', async () => {
      const mockAdapter = makeMockAdapter(makeSseConfig('docs'));
      mockAdapter.connect = vi.fn(async () => { mockAdapter.state = 'connected'; });
      (mockAdapter as any).config = { ...mockAdapter.config, resourceCacheTtlMs: 60_000 };
      mockAdapter.readResource = vi.fn(async (): Promise<ResourceContent> => ({
        uri: 'file:///a.md',
        text: 'fresh',
      }));

      const { manager } = createManagerWithFactory(() => mockAdapter);
      await manager.addAdapter(makeSseConfig('docs'));

      // Read a resource not in cache
      const result = await manager.readResource('docs', 'file:///a.md');
      expect(result.text).toBe('fresh');
      expect(mockAdapter.readResource).toHaveBeenCalledWith('file:///a.md');
    });

    it('cache expiry triggers refetch from adapter', async () => {
      vi.useFakeTimers();
      try {
        const mockAdapter = makeMockAdapter(makeSseConfig('docs'));
        mockAdapter.connect = vi.fn(async () => { mockAdapter.state = 'connected'; });
        (mockAdapter as any).config = { ...mockAdapter.config, resourceCacheTtlMs: 5000 };

        let fetchCount = 0;
        mockAdapter.readResource = vi.fn(async (): Promise<ResourceContent> => {
          fetchCount++;
          return { uri: 'file:///data', text: `version-${fetchCount}` };
        });

        const { manager } = createManagerWithFactory(() => mockAdapter);
        await manager.addAdapter(makeSseConfig('docs'));

        // First read
        const r1 = await manager.readResource('docs', 'file:///data');
        expect(r1.text).toBe('version-1');
        expect(fetchCount).toBe(1);

        // Second read before TTL — cached
        const r2 = await manager.readResource('docs', 'file:///data');
        expect(r2.text).toBe('version-1');
        expect(fetchCount).toBe(1);

        // Advance time past TTL
        vi.advanceTimersByTime(5001);

        // Third read after TTL — refetch
        const r3 = await manager.readResource('docs', 'file:///data');
        expect(r3.text).toBe('version-2');
        expect(fetchCount).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('throws ADAPTER_NOT_FOUND for unknown adapter name', async () => {
      const { manager } = createManager();

      await expect(manager.readResource('unknown', 'file:///x')).rejects.toThrow(EngineError);

      try {
        await manager.readResource('nonexistent', 'file:///x');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('ADAPTER_NOT_FOUND');
      }
    });

    it('caches resources per-adapter (different adapters have separate caches)', async () => {
      let callCount = 0;
      const adapters: MockManagedAdapter[] = [];
      const { manager } = createManagerWithFactory((config: AdapterConfig) => {
        const mock = makeMockAdapter(config);
        mock.connect = vi.fn(async () => { mock.state = 'connected'; });
        (mock as any).config = { ...mock.config, resourceCacheTtlMs: 60_000 };

        const idx = callCount;
        mock.readResource = vi.fn(async (): Promise<ResourceContent> => ({
          uri: 'file:///shared.txt',
          text: `adapter-${idx}-content`,
        }));
        adapters.push(mock);
        callCount++;
        return mock;
      });

      await manager.addAdapter(makeStdioConfig('a'));
      await manager.addAdapter(makeSseConfig('b'));

      const r1 = await manager.readResource('a', 'file:///shared.txt');
      expect(r1.text).toBe('adapter-0-content');

      const r2 = await manager.readResource('b', 'file:///shared.txt');
      expect(r2.text).toBe('adapter-1-content');

      // Both adapters were fetched from (separate cache keys)
      expect(adapters[0].readResource).toHaveBeenCalledOnce();
      expect(adapters[1].readResource).toHaveBeenCalledOnce();
    });
  });

  describe('readResource', () => {
    it('delegates to the correct adapter', async () => {
      const mockAdapter = makeMockAdapter(makeSseConfig('docs'));
      mockAdapter.connect = vi.fn(async () => {
        mockAdapter.state = 'connected';
      });

      const expectedContent: ResourceContent = {
        uri: 'file:///readme.md',
        text: '# README',
        mimeType: 'text/markdown',
      };
      mockAdapter.readResource = vi.fn(async () => expectedContent);

      const { manager } = createManagerWithFactory(() => mockAdapter);

      await manager.addAdapter(makeSseConfig('docs'));

      const result = await manager.readResource('docs', 'file:///readme.md');
      expect(result).toEqual(expectedContent);
    });

    it('throws ADAPTER_NOT_FOUND for unknown adapter', async () => {
      const { manager } = createManager();

      await expect(manager.readResource('unknown', 'file:///x')).rejects.toThrow(EngineError);

      try {
        await manager.readResource('unknown', 'file:///x');
      } catch (err) {
        expect((err as EngineError).code).toBe('ADAPTER_NOT_FOUND');
      }
    });
  });

  // ── T034: Multi-adapter tool listing ──

  describe('multi-adapter tool listing', () => {
    it('lists all tools across multiple adapters', async () => {
      let callCount = 0;
      const { manager } = createManagerWithFactory((config: AdapterConfig) => {
        const mock = makeMockAdapter(config);
        if (callCount === 0) {
          mock._tools = [makeTool('read'), makeTool('write')];
        } else if (callCount === 1) {
          mock._tools = [makeTool('query'), makeTool('execute')];
        } else {
          mock._tools = [makeTool('send')];
        }
        mock.connect = vi.fn(async () => { mock.state = 'connected'; });
        callCount++;
        return mock;
      });

      await manager.addAdapter(makeStdioConfig('fs'));
      await manager.addAdapter(makeSseConfig('db'));
      await manager.addAdapter(makeSseConfig('email'));

      const tools = manager.listTools();
      expect(tools).toHaveLength(5);

      const qualifiedNames = tools.map((t) => t.qualifiedName).sort();
      expect(qualifiedNames).toEqual([
        'db.execute',
        'db.query',
        'email.send',
        'fs.read',
        'fs.write',
      ]);
    });

    it('filters tools by adapter name', async () => {
      let callCount = 0;
      const { manager } = createManagerWithFactory((config: AdapterConfig) => {
        const mock = makeMockAdapter(config);
        if (callCount === 0) {
          mock._tools = [makeTool('read'), makeTool('write')];
        } else {
          mock._tools = [makeTool('query')];
        }
        mock.connect = vi.fn(async () => { mock.state = 'connected'; });
        callCount++;
        return mock;
      });

      await manager.addAdapter(makeStdioConfig('fs'));
      await manager.addAdapter(makeSseConfig('db'));

      const fsTools = manager.listTools({ adapter: 'fs' });
      expect(fsTools).toHaveLength(2);
      expect(fsTools.every((t) => t.adapterName === 'fs')).toBe(true);

      const dbTools = manager.listTools({ adapter: 'db' });
      expect(dbTools).toHaveLength(1);
      expect(dbTools[0].qualifiedName).toBe('db.query');
    });

    it('excludes tools from adapters in error state', async () => {
      const adapters: MockManagedAdapter[] = [];
      let callCount = 0;
      const { manager } = createManagerWithFactory((config: AdapterConfig) => {
        const mock = makeMockAdapter(config);
        mock._tools = [makeTool('tool-' + callCount)];
        mock.connect = vi.fn(async () => { mock.state = 'connected'; });
        adapters.push(mock);
        callCount++;
        return mock;
      });

      await manager.addAdapter(makeStdioConfig('healthy'));
      await manager.addAdapter(makeSseConfig('broken'));

      expect(manager.listTools()).toHaveLength(2);

      // Simulate one adapter going into error state
      adapters[1].state = 'error';

      const tools = manager.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].adapterName).toBe('healthy');
    });

    it('excludes tools from disconnected adapters', async () => {
      const adapters: MockManagedAdapter[] = [];
      let callCount = 0;
      const { manager } = createManagerWithFactory((config: AdapterConfig) => {
        const mock = makeMockAdapter(config);
        mock._tools = [makeTool('tool-' + callCount)];
        mock.connect = vi.fn(async () => { mock.state = 'connected'; });
        adapters.push(mock);
        callCount++;
        return mock;
      });

      await manager.addAdapter(makeStdioConfig('a'));
      await manager.addAdapter(makeSseConfig('b'));

      expect(manager.listTools()).toHaveLength(2);

      // Simulate one adapter disconnecting
      adapters[0].state = 'disconnected';

      const tools = manager.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].adapterName).toBe('b');
    });

    it('handles adapter with zero tools gracefully', async () => {
      let callCount = 0;
      const { manager } = createManagerWithFactory((config: AdapterConfig) => {
        const mock = makeMockAdapter(config);
        if (callCount === 0) {
          mock._tools = [makeTool('read')];
        } else {
          mock._tools = []; // zero tools
        }
        mock.connect = vi.fn(async () => { mock.state = 'connected'; });
        callCount++;
        return mock;
      });

      await manager.addAdapter(makeStdioConfig('fs'));
      await manager.addAdapter(makeSseConfig('empty'));

      const tools = manager.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].qualifiedName).toBe('fs.read');

      // Filtering for the empty adapter returns nothing
      expect(manager.listTools({ adapter: 'empty' })).toEqual([]);
    });

    it('returns correct tool metadata across adapters', async () => {
      let callCount = 0;
      const { manager } = createManagerWithFactory((config: AdapterConfig) => {
        const mock = makeMockAdapter(config);
        if (callCount === 0) {
          mock._tools = [makeTool('read', 'Read files from disk')];
        } else {
          mock._tools = [makeTool('query', 'Execute SQL queries')];
        }
        mock.connect = vi.fn(async () => { mock.state = 'connected'; });
        callCount++;
        return mock;
      });

      await manager.addAdapter(makeStdioConfig('fs'));
      await manager.addAdapter(makeSseConfig('db'));

      const tools = manager.listTools();
      const fsTool = tools.find((t) => t.qualifiedName === 'fs.read')!;
      expect(fsTool.adapterName).toBe('fs');
      expect(fsTool.toolName).toBe('read');
      expect(fsTool.description).toBe('Read files from disk');

      const dbTool = tools.find((t) => t.qualifiedName === 'db.query')!;
      expect(dbTool.adapterName).toBe('db');
      expect(dbTool.toolName).toBe('query');
      expect(dbTool.description).toBe('Execute SQL queries');
    });
  });

  describe('shutdown', () => {
    it('disconnects all registered adapters', async () => {
      const adapters: MockManagedAdapter[] = [];

      const { manager } = createManagerWithFactory((config: AdapterConfig) => {
        const mock = makeMockAdapter(config);
        mock.connect = vi.fn(async () => {
          mock.state = 'connected';
        });
        adapters.push(mock);
        return mock;
      });

      await manager.addAdapter(makeStdioConfig('fs'));
      await manager.addAdapter(makeSseConfig('remote'));

      await manager.shutdown();

      expect(adapters[0].disconnect).toHaveBeenCalledOnce();
      expect(adapters[1].disconnect).toHaveBeenCalledOnce();
      expect(manager.hasAdapters()).toBe(false);
    });

    it('is safe to call on an empty manager', async () => {
      const { manager } = createManager();

      await expect(manager.shutdown()).resolves.toBeUndefined();
    });

    it('clears tools from ToolRouter after shutdown', async () => {
      const { manager } = createManagerWithFactory((config: AdapterConfig) => {
        const mock = makeMockAdapter(config);
        mock._tools = [makeTool('read')];
        mock.connect = vi.fn(async () => {
          mock.state = 'connected';
        });
        return mock;
      });

      await manager.addAdapter(makeStdioConfig('fs'));
      expect(manager.listTools()).toHaveLength(1);

      await manager.shutdown();
      expect(manager.listTools()).toHaveLength(0);
    });
  });
});
