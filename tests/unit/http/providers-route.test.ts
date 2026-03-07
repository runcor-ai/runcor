// Unit tests for GET /v1/providers and engine.getProviderHealth()

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../../src/engine.js';
import { MockProvider } from '../../../src/model/mock.js';

function makeEngine(providers: Array<{ provider: MockProvider; priority: number }>) {
  return createEngine({
    model: { providers },
  });
}

describe('getProviderHealth()', () => {
  let engine: Runcor;

  afterEach(async () => {
    if (engine) await engine.shutdown();
  });

  it('returns empty array when no providers registered', async () => {
    // MockProvider is always registered — test with single provider
    engine = await makeEngine([{ provider: new MockProvider(), priority: 1 }]);
    const health = engine.getProviderHealth();
    expect(health).toHaveLength(1);
    expect(health[0].healthState).toBe('healthy');
  });

  it('returns health for multiple providers', async () => {
    const p1 = new MockProvider('r1');
    (p1 as any)._name = 'provider-a';
    Object.defineProperty(p1, 'name', { get: () => 'provider-a' });
    const p2 = new MockProvider('r2');
    Object.defineProperty(p2, 'name', { get: () => 'provider-b' });
    engine = await makeEngine([
      { provider: p1, priority: 1 },
      { provider: p2, priority: 2 },
    ]);
    const health = engine.getProviderHealth();
    expect(health).toHaveLength(2);
    expect(health[0].name).toBe('provider-a');
    expect(health[0].priority).toBe(1);
    expect(health[1].name).toBe('provider-b');
    expect(health[1].priority).toBe(2);
  });

  it('all providers start as healthy', async () => {
    const pa = new MockProvider();
    Object.defineProperty(pa, 'name', { get: () => 'prov-1' });
    const pb = new MockProvider();
    Object.defineProperty(pb, 'name', { get: () => 'prov-2' });
    engine = await makeEngine([
      { provider: pa, priority: 1 },
      { provider: pb, priority: 2 },
    ]);
    const health = engine.getProviderHealth();
    for (const p of health) {
      expect(p.healthState).toBe('healthy');
    }
  });
});

describe('getCapabilities()', () => {
  let engine: Runcor;

  afterEach(async () => {
    if (engine) await engine.shutdown();
  });

  it('returns all false for minimal engine', async () => {
    engine = await makeEngine([{ provider: new MockProvider(), priority: 1 }]);
    const caps = engine.getCapabilities();
    expect(caps.cost).toBe(false);
    expect(caps.evaluation).toBe(false);
    expect(caps.discernment).toBe(false);
  });

  it('returns cost=true when cost tracking enabled', async () => {
    engine = await createEngine({
      model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
      cost: {},
    });
    const caps = engine.getCapabilities();
    expect(caps.cost).toBe(true);
  });

  it('returns discernment=true when discernment enabled', async () => {
    engine = await createEngine({
      model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
      discernment: {
        enabled: true,
        autonomy: 'observe',
        schedule: 'daily',
      },
    });
    const caps = engine.getCapabilities();
    expect(caps.discernment).toBe(true);
  });
});
