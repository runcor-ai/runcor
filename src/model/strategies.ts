// Built-in routing strategies

import type { ProviderRegistration, RoutingStrategy } from '../types.js';

/** Priority strategy: sort by priority ascending. Ties broken by registration order. */
export function createPriorityStrategy(): RoutingStrategy {
  return (providers) => {
    return [...providers].sort((a, b) => a.priority - b.priority);
  };
}

/** Round-robin strategy: cycle through providers. Factory with internal counter. */
export function createRoundRobinStrategy(): RoutingStrategy {
  let counter = 0;

  return (providers) => {
    const len = providers.length;
    const index = counter % len;
    counter++;

    // Rotate array so current index is first, rest follow in order
    const result: ProviderRegistration[] = [];
    for (let i = 0; i < len; i++) {
      result.push(providers[(index + i) % len]);
    }
    return result;
  };
}

/** Lowest-cost strategy: sort by total cost ascending. No-cost providers last. */
export function createLowestCostStrategy(): RoutingStrategy {
  return (providers) => {
    return [...providers].sort((a, b) => {
      const aCost = a.costPerToken;
      const bCost = b.costPerToken;

      // Providers without cost metadata go last
      if (!aCost && !bCost) return 0;
      if (!aCost) return 1;
      if (!bCost) return -1;

      const aTotal = aCost.input + aCost.output;
      const bTotal = bCost.input + bCost.output;
      return aTotal - bTotal;
    });
  };
}

/** Resolve a strategy name or function to a RoutingStrategy function */
export function resolveStrategy(
  strategy: RoutingStrategy | 'priority' | 'round-robin' | 'lowest-cost',
): RoutingStrategy {
  if (typeof strategy === 'function') {
    return strategy;
  }

  switch (strategy) {
    case 'priority':
      return createPriorityStrategy();
    case 'round-robin':
      return createRoundRobinStrategy();
    case 'lowest-cost':
      return createLowestCostStrategy();
  }
}
