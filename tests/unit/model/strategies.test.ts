// Unit tests for routing strategies
// Per data-model.md Built-in Strategies and spec FR-004

import { describe, it, expect } from 'vitest';
import {
  createPriorityStrategy,
  createRoundRobinStrategy,
  createLowestCostStrategy,
  resolveStrategy,
} from '../../../src/model/strategies.js';
import type { ProviderRegistration } from '../../../src/types.js';
import type { ModelRequest } from '../../../src/model/provider.js';

function makeProvider(
  name: string,
  priority: number,
  costPerToken: { input: number; output: number } | null = null,
): ProviderRegistration {
  return {
    name,
    provider: {
      name,
      complete: async () => ({
        text: 'test',
        model: 'test',
        provider: name,
        usage: { promptTokens: 0, completionTokens: 0 },
      }),
    },
    priority,
    costPerToken,
    models: null,
  };
}

const baseRequest: ModelRequest = { prompt: 'test' };

describe('Priority Strategy', () => {
  const strategy = createPriorityStrategy();

  it('should sort providers by priority ascending (lowest number first)', () => {
    const providers = [
      makeProvider('low', 3),
      makeProvider('high', 1),
      makeProvider('mid', 2),
    ];
    const result = strategy(providers, baseRequest);
    expect(result.map((p) => p.name)).toEqual(['high', 'mid', 'low']);
  });

  it('should break ties by registration order (array position)', () => {
    const providers = [
      makeProvider('first', 1),
      makeProvider('second', 1),
      makeProvider('third', 1),
    ];
    const result = strategy(providers, baseRequest);
    expect(result.map((p) => p.name)).toEqual(['first', 'second', 'third']);
  });

  it('should not mutate the input array', () => {
    const providers = [makeProvider('b', 2), makeProvider('a', 1)];
    const original = [...providers];
    strategy(providers, baseRequest);
    expect(providers).toEqual(original);
  });

  it('should return non-empty array when given non-empty input', () => {
    const providers = [makeProvider('solo', 1)];
    const result = strategy(providers, baseRequest);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('Round-Robin Strategy', () => {
  it('should cycle through providers in order', () => {
    const strategy = createRoundRobinStrategy();
    const providers = [
      makeProvider('a', 1),
      makeProvider('b', 1),
      makeProvider('c', 1),
    ];

    const first = strategy(providers, baseRequest);
    expect(first[0].name).toBe('a');

    const second = strategy(providers, baseRequest);
    expect(second[0].name).toBe('b');

    const third = strategy(providers, baseRequest);
    expect(third[0].name).toBe('c');
  });

  it('should wrap around after cycling through all providers', () => {
    const strategy = createRoundRobinStrategy();
    const providers = [makeProvider('a', 1), makeProvider('b', 1)];

    strategy(providers, baseRequest); // a
    strategy(providers, baseRequest); // b
    const result = strategy(providers, baseRequest); // wraps → a
    expect(result[0].name).toBe('a');
  });

  it('should not mutate the input array', () => {
    const strategy = createRoundRobinStrategy();
    const providers = [makeProvider('a', 1), makeProvider('b', 1)];
    const original = [...providers];
    strategy(providers, baseRequest);
    expect(providers).toEqual(original);
  });

  it('should return non-empty array when given non-empty input', () => {
    const strategy = createRoundRobinStrategy();
    const providers = [makeProvider('solo', 1)];
    const result = strategy(providers, baseRequest);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('Lowest-Cost Strategy', () => {
  const strategy = createLowestCostStrategy();

  it('should sort providers by total cost ascending', () => {
    const providers = [
      makeProvider('expensive', 1, { input: 0.1, output: 0.3 }),
      makeProvider('cheap', 1, { input: 0.01, output: 0.02 }),
      makeProvider('mid', 1, { input: 0.05, output: 0.1 }),
    ];
    const result = strategy(providers, baseRequest);
    expect(result.map((p) => p.name)).toEqual(['cheap', 'mid', 'expensive']);
  });

  it('should sort providers without cost metadata last', () => {
    const providers = [
      makeProvider('no-cost', 1, null),
      makeProvider('cheap', 1, { input: 0.01, output: 0.02 }),
      makeProvider('also-no-cost', 1, null),
    ];
    const result = strategy(providers, baseRequest);
    expect(result[0].name).toBe('cheap');
    expect(result.slice(1).map((p) => p.name)).toContain('no-cost');
    expect(result.slice(1).map((p) => p.name)).toContain('also-no-cost');
  });

  it('should not mutate the input array', () => {
    const providers = [
      makeProvider('b', 1, { input: 0.1, output: 0.1 }),
      makeProvider('a', 1, { input: 0.01, output: 0.01 }),
    ];
    const original = [...providers];
    strategy(providers, baseRequest);
    expect(providers).toEqual(original);
  });

  it('should return non-empty array when given non-empty input', () => {
    const providers = [makeProvider('solo', 1, { input: 1, output: 1 })];
    const result = strategy(providers, baseRequest);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('resolveStrategy', () => {
  it('should resolve "priority" string to priority strategy', () => {
    const strategy = resolveStrategy('priority');
    const providers = [makeProvider('b', 2), makeProvider('a', 1)];
    const result = strategy(providers, baseRequest);
    expect(result[0].name).toBe('a');
  });

  it('should resolve "round-robin" string to round-robin strategy', () => {
    const strategy = resolveStrategy('round-robin');
    expect(typeof strategy).toBe('function');
  });

  it('should resolve "lowest-cost" string to lowest-cost strategy', () => {
    const strategy = resolveStrategy('lowest-cost');
    expect(typeof strategy).toBe('function');
  });

  it('should return a custom function as-is', () => {
    const custom = (providers: ProviderRegistration[]) => [...providers].reverse();
    const strategy = resolveStrategy(custom);
    expect(strategy).toBe(custom);
  });
});
