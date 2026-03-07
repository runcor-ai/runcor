// Unit tests for MCP Server Lifecycle
// Tests startServer/stopServer on Runcor class and config-driven auto-start

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createEngine } from '../../../src/engine.js';
import type { EngineConfig, ProviderRegistration } from '../../../src/types.js';

// Mock the MCP SDK to avoid real stdio I/O
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  function MockMcpServer(this: any) {
    this.tool = vi.fn().mockReturnValue({ remove: vi.fn() });
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

// Minimal provider for engine construction
const mockProvider = {
  id: 'test-provider',
  chat: vi.fn().mockResolvedValue({ text: 'ok', promptTokens: 1, completionTokens: 1 }),
};

function createConfig(serverConfig?: EngineConfig['server']): EngineConfig {
  const config: EngineConfig = {
    model: {
      providers: [{ provider: mockProvider, priority: 1 }],
    },
  };
  if (serverConfig !== undefined) {
    config.server = serverConfig;
  }
  return config;
}

describe('MCP Server Lifecycle (US4)', () => {
  let engine: Awaited<ReturnType<typeof createEngine>>;

  afterEach(async () => {
    try {
      await engine?.shutdown();
    } catch {
      // Ignore shutdown errors in cleanup
    }
  });

  describe('startServer / stopServer', () => {
    it('should start MCP server via startServer() [FR-022]', async () => {
      engine = await createEngine(createConfig());

      await engine.startServer({ enabled: true, name: 'test', version: '1.0' });
      await engine.stopServer();
    });

    it('should throw SERVER_ALREADY_RUNNING if startServer() called twice [FR-022]', async () => {
      engine = await createEngine(createConfig());

      await engine.startServer({ enabled: true, name: 'test', version: '1.0' });

      await expect(
        engine.startServer({ enabled: true, name: 'test2', version: '2.0' }),
      ).rejects.toThrow(/SERVER_ALREADY_RUNNING|already running/i);

      await engine.stopServer();
    });

    it('should throw ENGINE_NOT_READY if engine is shut down [FR-022]', async () => {
      engine = await createEngine(createConfig());
      await engine.shutdown();

      await expect(
        engine.startServer({ enabled: true, name: 'test', version: '1.0' }),
      ).rejects.toThrow(/ENGINE_NOT_READY|not ready/i);
    });

    it('should stop MCP server gracefully via stopServer() [FR-023]', async () => {
      engine = await createEngine(createConfig());

      await engine.startServer({ enabled: true, name: 'test', version: '1.0' });
      await engine.stopServer();

      // Should be able to start again after stopping
      await engine.startServer({ enabled: true, name: 'test', version: '1.0' });
      await engine.stopServer();
    });

    it('should be a no-op if stopServer() called when not running [FR-023]', async () => {
      engine = await createEngine(createConfig());

      // Should not throw
      await engine.stopServer();
    });

    it('should stop MCP server on engine shutdown [FR-016]', async () => {
      engine = await createEngine(createConfig());

      await engine.startServer({ enabled: true, name: 'test', version: '1.0' });
      await engine.shutdown();

      // Starting again should throw ENGINE_NOT_READY because engine is shut down
      await expect(
        engine.startServer({ enabled: true, name: 'test', version: '1.0' }),
      ).rejects.toThrow(/ENGINE_NOT_READY|not ready/i);
    });
  });

  describe('config-driven auto-start', () => {
    it('should auto-start MCP server when server.enabled is true [FR-015]', async () => {
      engine = await createEngine(createConfig({
        enabled: true,
        name: 'auto-start-engine',
        version: '1.0.0',
      }));

      // Starting again should fail because it's already running
      await expect(
        engine.startServer({ enabled: true }),
      ).rejects.toThrow(/SERVER_ALREADY_RUNNING|already running/i);
    });

    it('should not auto-start when server.enabled is false', async () => {
      engine = await createEngine(createConfig({
        enabled: false,
        name: 'no-start',
        version: '1.0.0',
      }));

      // Should be able to start manually (not already running)
      await engine.startServer({ enabled: true, name: 'manual', version: '1.0' });
      await engine.stopServer();
    });

    it('should not auto-start when no server config is present [FR-015]', async () => {
      engine = await createEngine(createConfig());

      // Should be able to start manually
      await engine.startServer({ enabled: true, name: 'manual', version: '1.0' });
      await engine.stopServer();
    });
  });
});
