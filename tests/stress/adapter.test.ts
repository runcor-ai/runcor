// Stress test: Adapter subsystem — ToolRouter and ResourceCache
import { describe, it, expect } from 'vitest';
import { ToolRouter } from '../../src/adapter/tool-router.js';
import { ResourceCache } from '../../src/adapter/resource-cache.js';
import type { AdapterToolSchema, ResourceContent } from '../../src/types.js';

describe('Stress: Adapter — ToolRouter', () => {
  it('should maintain O(1) routing performance with 100+ registered tools', () => {
    const router = new ToolRouter();
    const toolCount = 200;

    // Register 200 tools across 10 adapters
    for (let a = 0; a < 10; a++) {
      const tools: AdapterToolSchema[] = [];
      for (let t = 0; t < toolCount / 10; t++) {
        tools.push({
          name: `tool-${t}`,
          description: `Tool ${t} on adapter ${a}`,
          inputSchema: { type: 'object', properties: { arg: { type: 'string' } } },
        });
      }
      router.register(`adapter-${a}`, tools);
    }

    // Verify all 200 tools are registered
    const all = router.list();
    expect(all.length).toBe(toolCount);

    // Measure resolve performance (should be O(1) Map lookup)
    const iterations = 10000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const adapterIdx = i % 10;
      const toolIdx = i % 20;
      const result = router.resolve(`adapter-${adapterIdx}.tool-${toolIdx}`);
      expect(result).toBe(`adapter-${adapterIdx}`);
    }
    const elapsed = performance.now() - start;

    // 10K lookups should complete in < 2000ms (sub-200µs per lookup)
    expect(elapsed).toBeLessThan(2000);
  }, 30000);

  it('should handle 1000 rapid register/unregister cycles without stale entries', () => {
    const router = new ToolRouter();

    for (let cycle = 0; cycle < 1000; cycle++) {
      const adapterName = `cycling-adapter-${cycle % 10}`;

      // Unregister first if already exists
      router.unregister(adapterName);

      // Register new tools
      const tools: AdapterToolSchema[] = [
        {
          name: `tool-${cycle}`,
          description: `Cycle ${cycle}`,
          inputSchema: { type: 'object' },
        },
      ];
      router.register(adapterName, tools);
    }

    // After 1000 cycles, each of the 10 adapter slots should have the last tool registered
    for (let a = 0; a < 10; a++) {
      const adapterTools = router.list({ adapter: `cycling-adapter-${a}` });
      // Should have exactly 1 tool (the latest registration)
      expect(adapterTools.length).toBe(1);
    }

    // No stale entries from earlier cycles
    const all = router.list();
    expect(all.length).toBe(10); // One per adapter

    // Verify no stale resolve hits
    // The last cycle for adapter-0 would be cycle 990 (since 990 % 10 = 0)
    expect(router.resolve('cycling-adapter-0.tool-990')).toBe('cycling-adapter-0');
    // Earlier cycle tool should not resolve
    expect(router.resolve('cycling-adapter-0.tool-0')).toBeNull();
  }, 30000);

  it('should correctly filter tools by adapter with many adapters', () => {
    const router = new ToolRouter();
    const adapterCount = 50;
    const toolsPerAdapter = 10;

    for (let a = 0; a < adapterCount; a++) {
      const tools: AdapterToolSchema[] = [];
      for (let t = 0; t < toolsPerAdapter; t++) {
        tools.push({
          name: `t-${t}`,
          description: `Tool ${t}`,
          inputSchema: { type: 'object' },
        });
      }
      router.register(`a-${a}`, tools);
    }

    // Total tools
    expect(router.list().length).toBe(adapterCount * toolsPerAdapter);

    // Filtered by adapter
    for (let a = 0; a < adapterCount; a++) {
      const filtered = router.list({ adapter: `a-${a}` });
      expect(filtered.length).toBe(toolsPerAdapter);
      for (const tool of filtered) {
        expect(tool.adapterName).toBe(`a-${a}`);
      }
    }
  }, 30000);
});

describe('Stress: Adapter — ResourceCache', () => {
  it('should handle 1000 entries with correct TTL eviction', async () => {
    const cache = new ResourceCache();
    const count = 1000;

    // Set entries with short TTL
    for (let i = 0; i < count; i++) {
      const content: ResourceContent = {
        uri: `resource://${i}`,
        text: `content-${i}`,
      };
      cache.set('adapter-a', `resource://${i}`, content, 200); // 200ms TTL
    }

    // Immediately: all should be present
    for (let i = 0; i < count; i++) {
      expect(cache.has('adapter-a', `resource://${i}`)).toBe(true);
      const content = cache.get('adapter-a', `resource://${i}`);
      expect(content).not.toBeNull();
      expect(content!.text).toBe(`content-${i}`);
    }

    // Wait for TTL expiry
    await new Promise((r) => setTimeout(r, 300));

    // After TTL: all should be expired
    for (let i = 0; i < count; i++) {
      expect(cache.get('adapter-a', `resource://${i}`)).toBeNull();
      expect(cache.has('adapter-a', `resource://${i}`)).toBe(false);
    }
  }, 30000);

  it('should handle mixed TTL eviction (short-lived vs long-lived entries)', async () => {
    const cache = new ResourceCache();

    // Short-lived entries: 100ms TTL
    for (let i = 0; i < 100; i++) {
      cache.set('adapter-short', `res://${i}`, {
        uri: `res://${i}`,
        text: `short-${i}`,
      }, 100);
    }

    // Long-lived entries: 5000ms TTL
    for (let i = 0; i < 100; i++) {
      cache.set('adapter-long', `res://${i}`, {
        uri: `res://${i}`,
        text: `long-${i}`,
      }, 5000);
    }

    // Immediately: all should be present
    expect(cache.has('adapter-short', 'res://0')).toBe(true);
    expect(cache.has('adapter-long', 'res://0')).toBe(true);

    // Wait for short TTL to expire
    await new Promise((r) => setTimeout(r, 200));

    // Short-lived should be gone, long-lived should remain
    for (let i = 0; i < 100; i++) {
      expect(cache.get('adapter-short', `res://${i}`)).toBeNull();
      const longContent = cache.get('adapter-long', `res://${i}`);
      expect(longContent).not.toBeNull();
      expect(longContent!.text).toBe(`long-${i}`);
    }
  }, 30000);

  it('should handle clearAdapter without affecting other adapters', () => {
    const cache = new ResourceCache();

    // Populate multiple adapters
    for (let a = 0; a < 5; a++) {
      for (let r = 0; r < 50; r++) {
        cache.set(`adapter-${a}`, `res://${r}`, {
          uri: `res://${r}`,
          text: `a${a}-r${r}`,
        }, 60000);
      }
    }

    // Clear one adapter
    cache.clearAdapter('adapter-2');

    // Cleared adapter should have no entries
    for (let r = 0; r < 50; r++) {
      expect(cache.get('adapter-2', `res://${r}`)).toBeNull();
    }

    // Other adapters should be untouched
    for (const a of [0, 1, 3, 4]) {
      for (let r = 0; r < 50; r++) {
        const content = cache.get(`adapter-${a}`, `res://${r}`);
        expect(content).not.toBeNull();
        expect(content!.text).toBe(`a${a}-r${r}`);
      }
    }
  }, 30000);

  it('should handle rapid set/get cycles on same key (last-write-wins)', () => {
    const cache = new ResourceCache();
    const iterations = 10000;

    for (let i = 0; i < iterations; i++) {
      cache.set('adapter-race', 'same-key', {
        uri: 'same-key',
        text: `value-${i}`,
      }, 60000);
    }

    // Should have the last written value
    const result = cache.get('adapter-race', 'same-key');
    expect(result).not.toBeNull();
    expect(result!.text).toBe(`value-${iterations - 1}`);
  }, 30000);
});
