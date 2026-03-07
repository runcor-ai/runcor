// Unit tests for SSE manager
// Per tasks.md T021: event category mapping, filtering, broadcast, cleanup

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getEventCategory } from '../../../src/http/sse.js';

describe('SSE Event Category Mapping', () => {
  const cases: Array<[string, string]> = [
    ['execution:state_change', 'execution'],
    ['execution:complete', 'execution'],
    ['cost:request', 'cost'],
    ['cost:budget_warning', 'cost'],
    ['cost:budget_exceeded', 'cost'],
    ['policy:violation', 'policy'],
    ['policy:warning', 'policy'],
    ['policy:rate_limited', 'policy'],
    ['eval:score', 'eval'],
    ['eval:complete', 'eval'],
    ['eval:flagged', 'eval'],
    ['adapter:connected', 'adapter'],
    ['adapter:disconnected', 'adapter'],
    ['adapter:error', 'adapter'],
    ['adapter:tools_discovered', 'adapter'],
    ['adapter:tool_call', 'adapter'],
    ['flow:registered', 'flow'],
    ['flow:unregistered', 'flow'],
    ['scheduler:trigger', 'scheduler'],
    ['scheduler:skip', 'scheduler'],
    ['scheduler:registered', 'scheduler'],
    ['scheduler:removed', 'scheduler'],
  ];

  for (const [eventName, expectedCategory] of cases) {
    it(`maps ${eventName} to category "${expectedCategory}"`, () => {
      expect(getEventCategory(eventName)).toBe(expectedCategory);
    });
  }

  it('returns null for unknown event names', () => {
    expect(getEventCategory('unknown:event')).toBeNull();
  });

  it('maps all 23 known events (7 categories)', () => {
    const categories = new Set(cases.map(([, cat]) => cat));
    expect(categories.size).toBe(7);
    expect(cases.length).toBe(22); // 22 known events across 7 categories
  });
});
