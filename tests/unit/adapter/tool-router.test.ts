// Unit tests for ToolRouter
// Verifies qualified-name routing, adapter filtering, and collision detection.

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRouter } from '../../../src/adapter/tool-router.js';
import { EngineError } from '../../../src/errors.js';
import type { AdapterToolSchema } from '../../../src/types.js';

function makeTool(name: string, description?: string): AdapterToolSchema {
  return {
    name,
    description: description ?? `${name} tool`,
    inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
  };
}

describe('ToolRouter', () => {
  let router: ToolRouter;

  beforeEach(() => {
    router = new ToolRouter();
  });

  describe('register', () => {
    it('registers tools under an adapter name and creates qualified names', () => {
      const tools = [makeTool('read'), makeTool('write')];
      router.register('filesystem', tools);

      expect(router.resolve('filesystem.read')).toBe('filesystem');
      expect(router.resolve('filesystem.write')).toBe('filesystem');
    });

    it('registers tools from multiple adapters independently', () => {
      router.register('fs', [makeTool('read')]);
      router.register('db', [makeTool('query')]);

      expect(router.resolve('fs.read')).toBe('fs');
      expect(router.resolve('db.query')).toBe('db');
    });

    it('allows re-registering the same tool from the same adapter (idempotent)', () => {
      const tools = [makeTool('read')];
      router.register('fs', tools);
      // Should not throw — same adapter re-registering same tool
      router.register('fs', tools);

      expect(router.resolve('fs.read')).toBe('fs');
    });
  });

  describe('unregister', () => {
    it('removes all tools for an adapter', () => {
      router.register('fs', [makeTool('read'), makeTool('write')]);
      router.register('db', [makeTool('query')]);

      router.unregister('fs');

      expect(router.resolve('fs.read')).toBeNull();
      expect(router.resolve('fs.write')).toBeNull();
      // db tools remain
      expect(router.resolve('db.query')).toBe('db');
    });

    it('is a no-op when adapter has no registered tools', () => {
      // Should not throw
      router.unregister('nonexistent');
      expect(router.list()).toHaveLength(0);
    });
  });

  describe('resolve', () => {
    it('maps "adapter.tool" to adapter name', () => {
      router.register('github', [makeTool('create_issue')]);
      expect(router.resolve('github.create_issue')).toBe('github');
    });

    it('returns null for unknown tool', () => {
      expect(router.resolve('unknown.tool')).toBeNull();
    });

    it('returns null for a tool after its adapter is unregistered', () => {
      router.register('fs', [makeTool('read')]);
      router.unregister('fs');
      expect(router.resolve('fs.read')).toBeNull();
    });
  });

  describe('list', () => {
    it('returns all registered AdapterToolInfo', () => {
      router.register('fs', [makeTool('read', 'Read files')]);
      router.register('db', [makeTool('query', 'Run SQL')]);

      const all = router.list();
      expect(all).toHaveLength(2);

      const names = all.map((t) => t.qualifiedName).sort();
      expect(names).toEqual(['db.query', 'fs.read']);

      const fsRead = all.find((t) => t.qualifiedName === 'fs.read')!;
      expect(fsRead.adapterName).toBe('fs');
      expect(fsRead.toolName).toBe('read');
      expect(fsRead.description).toBe('Read files');
      expect(fsRead.inputSchema).toEqual({
        type: 'object',
        properties: { input: { type: 'string' } },
      });
    });

    it('filters by adapter name', () => {
      router.register('fs', [makeTool('read'), makeTool('write')]);
      router.register('db', [makeTool('query')]);

      const fsTools = router.list({ adapter: 'fs' });
      expect(fsTools).toHaveLength(2);
      expect(fsTools.every((t) => t.adapterName === 'fs')).toBe(true);

      const dbTools = router.list({ adapter: 'db' });
      expect(dbTools).toHaveLength(1);
      expect(dbTools[0].qualifiedName).toBe('db.query');
    });

    it('returns empty array when filter matches no adapter', () => {
      router.register('fs', [makeTool('read')]);
      expect(router.list({ adapter: 'nonexistent' })).toEqual([]);
    });
  });

  describe('collision handling', () => {
    it('throws EngineError with DUPLICATE_TOOL when a qualified name collides across adapters', () => {
      // Adapter "a.b" registering tool "c" creates qualified name "a.b.c"
      // Adapter "a" registering tool "b.c" also creates qualified name "a.b.c"
      // This is a genuine qualified-name collision from different adapters.
      router.register('a.b', [makeTool('c')]);

      expect(() => {
        router.register('a', [makeTool('b.c')]);
      }).toThrow(EngineError);

      // Verify the error details
      try {
        // Reset and redo to get fresh error
        const router2 = new ToolRouter();
        router2.register('a.b', [makeTool('c')]);
        router2.register('a', [makeTool('b.c')]);
        // Should not reach here
        expect.unreachable('Expected EngineError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('DUPLICATE_TOOL');
        expect((err as EngineError).message).toContain('a.b.c');
      }
    });

    it('does not throw when the same adapter re-registers the same tool name', () => {
      router.register('adapter-a', [makeTool('do_thing')]);
      // Same adapter — should be idempotent
      expect(() => {
        router.register('adapter-a', [makeTool('do_thing')]);
      }).not.toThrow();
    });
  });

  // ── Reserved tool name validation ──

  describe('reserved tool name validation', () => {
    it('throws EngineError with RESERVED_TOOL_NAME for __structured_output', () => {
      const tools = [makeTool('__structured_output')];

      expect(() => {
        router.register('myAdapter', tools);
      }).toThrow(EngineError);

      try {
        const r2 = new ToolRouter();
        r2.register('myAdapter', tools);
        expect.unreachable('Expected EngineError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('RESERVED_TOOL_NAME');
        expect((err as EngineError).message).toContain('__structured_output');
        expect((err as EngineError).message).toContain('myAdapter');
      }
    });

    it('does not reject normal tool names', () => {
      expect(() => {
        router.register('myAdapter', [makeTool('normal_tool'), makeTool('another')]);
      }).not.toThrow();
    });

    it('rejects __structured_output even when mixed with valid tools', () => {
      const tools = [makeTool('valid_tool'), makeTool('__structured_output')];

      expect(() => {
        router.register('myAdapter', tools);
      }).toThrow(EngineError);
    });
  });

  // ── T035-T036: Tool index updates for multi-adapter support ──

  describe('tool index updates', () => {
    it('registers tools from an adapter on connect (add on connect)', () => {
      router.register('fs', [makeTool('read'), makeTool('write')]);

      const tools = router.list();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.qualifiedName).sort()).toEqual(['fs.read', 'fs.write']);
    });

    it('removes all tools on disconnect (unregister)', () => {
      router.register('fs', [makeTool('read'), makeTool('write')]);
      router.register('db', [makeTool('query')]);

      // Simulate disconnect of 'fs'
      router.unregister('fs');

      const tools = router.list();
      expect(tools).toHaveLength(1);
      expect(tools[0].qualifiedName).toBe('db.query');

      // fs tools should not resolve
      expect(router.resolve('fs.read')).toBeNull();
      expect(router.resolve('fs.write')).toBeNull();
    });

    it('updates tools on reconnect with changed tool list (unregister + register)', () => {
      // Initial connect: fs has read, write
      router.register('fs', [makeTool('read'), makeTool('write')]);
      expect(router.list({ adapter: 'fs' })).toHaveLength(2);

      // Simulate disconnect
      router.unregister('fs');
      expect(router.list({ adapter: 'fs' })).toHaveLength(0);

      // Reconnect with different tools: read still exists, write removed, list added
      router.register('fs', [makeTool('read'), makeTool('list')]);

      const fsTools = router.list({ adapter: 'fs' });
      expect(fsTools).toHaveLength(2);
      expect(fsTools.map((t) => t.toolName).sort()).toEqual(['list', 'read']);

      // Old tool 'write' should not resolve
      expect(router.resolve('fs.write')).toBeNull();
      // New tool 'list' should resolve
      expect(router.resolve('fs.list')).toBe('fs');
    });

    it('does not affect other adapters during unregister/re-register cycle', () => {
      router.register('fs', [makeTool('read')]);
      router.register('db', [makeTool('query')]);

      // Unregister fs, re-register with new tools
      router.unregister('fs');
      router.register('fs', [makeTool('stat')]);

      // db should be unaffected
      expect(router.resolve('db.query')).toBe('db');
      // fs.read should be gone, fs.stat should exist
      expect(router.resolve('fs.read')).toBeNull();
      expect(router.resolve('fs.stat')).toBe('fs');
    });

    it('handles complete tool replacement (all tools change)', () => {
      router.register('api', [makeTool('v1_get'), makeTool('v1_post')]);

      // Simulate reconnect with entirely new API version
      router.unregister('api');
      router.register('api', [makeTool('v2_get'), makeTool('v2_post'), makeTool('v2_patch')]);

      const tools = router.list({ adapter: 'api' });
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.toolName).sort()).toEqual(['v2_get', 'v2_patch', 'v2_post']);

      // Old tools gone
      expect(router.resolve('api.v1_get')).toBeNull();
      expect(router.resolve('api.v1_post')).toBeNull();
    });

    it('supports multiple adapters registering and unregistering independently', () => {
      router.register('a', [makeTool('t1')]);
      router.register('b', [makeTool('t2')]);
      router.register('c', [makeTool('t3')]);

      expect(router.list()).toHaveLength(3);

      router.unregister('b');
      expect(router.list()).toHaveLength(2);
      expect(router.resolve('b.t2')).toBeNull();

      // Re-register b with different tools
      router.register('b', [makeTool('t4'), makeTool('t5')]);
      expect(router.list()).toHaveLength(4);
      expect(router.resolve('b.t4')).toBe('b');
      expect(router.resolve('b.t5')).toBe('b');
    });
  });

  describe('empty state', () => {
    it('list returns empty array', () => {
      expect(router.list()).toEqual([]);
    });

    it('resolve returns null', () => {
      expect(router.resolve('any.tool')).toBeNull();
    });
  });

  describe('performance', () => {
    it('should resolve 1000 tool lookups in under 100ms', () => {
      const perfRouter = new ToolRouter();

      // Register 100 tools across 10 adapters (10 tools each)
      for (let a = 0; a < 10; a++) {
        const tools: AdapterToolSchema[] = [];
        for (let t = 0; t < 10; t++) {
          tools.push({ name: `tool_${a}_${t}`, description: `Tool ${t}` });
        }
        perfRouter.register(`adapter_${a}`, tools);
      }

      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        const a = i % 10;
        const t = i % 10;
        perfRouter.resolve(`adapter_${a}.tool_${a}_${t}`);
      }
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(100);
    });
  });
});
