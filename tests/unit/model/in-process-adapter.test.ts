// Unit tests for in-process MCP adapter transport (V2-002, v0.3.0).
//
// Verifies:
//   - validateConfig accepts in-process transport with non-empty tools
//   - validateConfig rejects in-process transport without tools
//   - createInProcessClientFactory builds an MCPClient that dispatches to handlers
//   - listTools strips handler functions from the returned tool list
//   - callTool invokes the matching handler with the args
//   - callTool throws TOOL_NOT_FOUND for unregistered tool names
//   - listResources returns empty
//   - readResource throws NOT_IMPLEMENTED
//   - End-to-end: addAdapter + callAdapterTool round-trip via in-process transport

import { describe, it, expect, vi } from 'vitest';
import { AdapterManager } from '../../../src/adapter/adapter-manager.js';
import { ManagedAdapter } from '../../../src/adapter/managed-adapter.js';
import { createInProcessClientFactory } from '../../../src/adapter/in-process.js';
import type {
  AdapterConfig,
  AdapterToolDefinition,
  ToolCallResult,
} from '../../../src/types.js';
import { EngineError } from '../../../src/errors.js';

const ECHO_TOOL: AdapterToolDefinition = {
  name: 'echo',
  description: 'Echo back the input',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
  },
  handler: async (args) => ({
    content: [{ type: 'text', text: `Echo: ${args.message}` }],
  }),
};

const ADD_TOOL: AdapterToolDefinition = {
  name: 'add',
  description: 'Add two numbers',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  handler: async (args) => ({
    content: [{ type: 'text', text: `${(args.a as number) + (args.b as number)}` }],
  }),
};

describe('createInProcessClientFactory', () => {
  it('builds a client whose listTools returns tool definitions WITHOUT handlers', async () => {
    const factory = createInProcessClientFactory();
    const config: AdapterConfig = {
      name: 'test',
      transport: 'in-process',
      tools: [ECHO_TOOL, ADD_TOOL],
    };
    const { client } = await factory.createClient(config);
    const result = await client.listTools();
    expect(result.tools).toHaveLength(2);
    expect(result.tools[0]).toEqual({
      name: 'echo',
      description: ECHO_TOOL.description,
      inputSchema: ECHO_TOOL.inputSchema,
    });
    // Handler is NOT exposed in the listTools response
    expect((result.tools[0] as Record<string, unknown>).handler).toBeUndefined();
  });

  it('callTool dispatches to the matching handler', async () => {
    const factory = createInProcessClientFactory();
    const config: AdapterConfig = {
      name: 'test',
      transport: 'in-process',
      tools: [ECHO_TOOL, ADD_TOOL],
    };
    const { client } = await factory.createClient(config);

    const echoResult = await client.callTool({ name: 'echo', arguments: { message: 'hi' } });
    expect(echoResult.content[0]).toMatchObject({ text: 'Echo: hi' });

    const addResult = await client.callTool({ name: 'add', arguments: { a: 2, b: 3 } });
    expect(addResult.content[0]).toMatchObject({ text: '5' });
  });

  it('callTool throws TOOL_NOT_FOUND for unknown tool name', async () => {
    const factory = createInProcessClientFactory();
    const config: AdapterConfig = {
      name: 'test',
      transport: 'in-process',
      tools: [ECHO_TOOL],
    };
    const { client } = await factory.createClient(config);
    await expect(client.callTool({ name: 'nonexistent' })).rejects.toThrow(
      /tool "nonexistent" is not registered/,
    );
  });

  it('listResources returns empty array', async () => {
    const factory = createInProcessClientFactory();
    const config: AdapterConfig = {
      name: 'test',
      transport: 'in-process',
      tools: [ECHO_TOOL],
    };
    const { client } = await factory.createClient(config);
    const result = await client.listResources();
    expect(result.resources).toEqual([]);
  });

  it('readResource throws NOT_IMPLEMENTED', async () => {
    const factory = createInProcessClientFactory();
    const config: AdapterConfig = {
      name: 'test',
      transport: 'in-process',
      tools: [ECHO_TOOL],
    };
    const { client } = await factory.createClient(config);
    await expect(client.readResource({ uri: 'test://anything' })).rejects.toThrow(
      /do not support resource reads/,
    );
  });

  it('rejects non-in-process transport', async () => {
    const factory = createInProcessClientFactory();
    const config: AdapterConfig = {
      name: 'test',
      transport: 'stdio',
      command: 'node',
    };
    await expect(factory.createClient(config)).rejects.toThrow(
      /expected transport 'in-process'/,
    );
  });

  it('rejects in-process config with empty tools', async () => {
    const factory = createInProcessClientFactory();
    const config: AdapterConfig = {
      name: 'test',
      transport: 'in-process',
      tools: [],
    };
    await expect(factory.createClient(config)).rejects.toThrow(/has no tools configured/);
  });
});

describe('AdapterManager validation — in-process transport', () => {
  function makeManager(createAdapter?: (c: AdapterConfig) => ManagedAdapter): AdapterManager {
    const noopInstrumentation = {
      startAdapterConnectSpan: () => ({ span: undefined as unknown, context: undefined as unknown }),
      endSpanWithSuccess: vi.fn(),
      endSpanWithError: vi.fn(),
      log: vi.fn(),
      incrementAdapterConnections: vi.fn(),
      decrementAdapterConnections: vi.fn(),
      startAdapterToolCallSpan: () => ({ span: undefined, context: undefined }),
      startAdapterResourceReadSpan: () => ({ span: undefined }),
      recordAdapterToolCall: vi.fn(),
    } as unknown as ConstructorParameters<typeof AdapterManager>[1];
    return new AdapterManager(undefined, noopInstrumentation, () => undefined, createAdapter);
  }

  it('addAdapter accepts a valid in-process config', async () => {
    const inProcessFactory = createInProcessClientFactory();
    const mgr = makeManager((config) => new ManagedAdapter(config, { clientFactory: inProcessFactory }));

    await expect(
      mgr.addAdapter({ name: 'inp', transport: 'in-process', tools: [ECHO_TOOL] }),
    ).resolves.toBeUndefined();

    const tools = mgr.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.some((t) => t.toolName === 'echo')).toBe(true);

    await mgr.shutdown();
  });

  it('addAdapter rejects in-process config with no tools', async () => {
    const mgr = makeManager();
    await expect(
      mgr.addAdapter({ name: 'inp', transport: 'in-process' as const }),
    ).rejects.toThrow(/in-process transport requires a non-empty "tools" field/);
  });

  it('addAdapter rejects in-process config with empty tools array', async () => {
    const mgr = makeManager();
    await expect(
      mgr.addAdapter({ name: 'inp', transport: 'in-process', tools: [] }),
    ).rejects.toThrow(/in-process transport requires a non-empty "tools" field/);
  });

  it('end-to-end: addAdapter + callTool via in-process transport', async () => {
    const inProcessFactory = createInProcessClientFactory();
    const mgr = makeManager((config) => new ManagedAdapter(config, { clientFactory: inProcessFactory }));

    await mgr.addAdapter({ name: 'inp', transport: 'in-process', tools: [ECHO_TOOL, ADD_TOOL] });

    // ToolRouter qualifies tool names as "<adapter>.<tool>" by default; check the actual format.
    const tools = mgr.listTools();
    const echoToolInfo = tools.find((t) => t.toolName === 'echo');
    expect(echoToolInfo).toBeDefined();

    const result = await mgr.callTool(`inp.echo`, { message: 'world' });
    expect(result.content[0]).toMatchObject({ text: 'Echo: world' });

    await mgr.shutdown();
  });

  it('still rejects stdio without command and sse without url', async () => {
    const mgr = makeManager();
    await expect(
      mgr.addAdapter({ name: 's', transport: 'stdio' }),
    ).rejects.toThrow(/stdio transport requires a "command" field/);
    await expect(
      mgr.addAdapter({ name: 'e', transport: 'sse' }),
    ).rejects.toThrow(/sse transport requires a "url" field/);
  });

  it('default ManagedAdapter constructor (no factory injected) auto-uses in-process factory', async () => {
    // V2-002 fix-up: when the engine's default AdapterFactory creates a `new ManagedAdapter(config)`
    // without options, in-process transport SHOULD still work (auto-fallback to built-in factory).
    // This is the path V2 hits when calling engine.addAdapter({ transport: 'in-process' }) without
    // configuring a custom AdapterFactory at engine-construction time.
    const mgr = makeManager(); // default factory: new ManagedAdapter(c) — no options

    await expect(
      mgr.addAdapter({ name: 'auto-inp', transport: 'in-process', tools: [ECHO_TOOL] }),
    ).resolves.toBeUndefined();

    const result = await mgr.callTool('auto-inp.echo', { message: 'auto' });
    expect(result.content[0]).toMatchObject({ text: 'Echo: auto' });

    await mgr.shutdown();
  });

  it('default ManagedAdapter for non-in-process transport still throws on connect (no factory)', async () => {
    // Non-in-process transports still require explicit factory injection (auto-fallback only
    // applies to in-process). This preserves the original v0.3.0 contract for stdio/sse.
    const mgr = makeManager();
    await expect(
      mgr.addAdapter({ name: 's', transport: 'stdio', command: 'node' }),
    ).rejects.toThrow(/No MCP client factory configured for transport "stdio"/);
  });
});
