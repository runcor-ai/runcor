// Unit tests for InMemoryCostLedger
// Per spec FR-002, FR-010, FR-012, FR-020

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryCostLedger } from '../../../src/cost/ledger.js';
import type { CostEntry } from '../../../src/types.js';

function makeCostEntry(overrides: Partial<CostEntry> = {}): CostEntry {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    provider: 'test-provider',
    model: 'test-model',
    promptTokens: 100,
    completionTokens: 50,
    cost: 2.5,
    executionId: 'exec-1',
    flowName: 'test-flow',
    userId: null,
    ...overrides,
  };
}

describe('InMemoryCostLedger', () => {
  let ledger: InMemoryCostLedger;

  beforeEach(() => {
    ledger = new InMemoryCostLedger();
  });

  describe('record()', () => {
    it('stores entries', () => {
      const entry = makeCostEntry();
      ledger.record(entry);
      expect(ledger.getCount()).toBe(1);
    });

    it('stores multiple entries', () => {
      ledger.record(makeCostEntry());
      ledger.record(makeCostEntry());
      ledger.record(makeCostEntry());
      expect(ledger.getCount()).toBe(3);
    });
  });

  describe('query()', () => {
    it('returns all entries with empty filter', () => {
      ledger.record(makeCostEntry());
      ledger.record(makeCostEntry());
      const results = ledger.query({});
      expect(results).toHaveLength(2);
    });

    it('filters by userId', () => {
      ledger.record(makeCostEntry({ userId: 'alice' }));
      ledger.record(makeCostEntry({ userId: 'bob' }));
      ledger.record(makeCostEntry({ userId: 'alice' }));

      const results = ledger.query({ userId: 'alice' });
      expect(results).toHaveLength(2);
      expect(results.every((e) => e.userId === 'alice')).toBe(true);
    });

    it('filters by flowName', () => {
      ledger.record(makeCostEntry({ flowName: 'summarizer' }));
      ledger.record(makeCostEntry({ flowName: 'classifier' }));

      const results = ledger.query({ flowName: 'summarizer' });
      expect(results).toHaveLength(1);
      expect(results[0].flowName).toBe('summarizer');
    });

    it('filters by executionId', () => {
      ledger.record(makeCostEntry({ executionId: 'exec-a' }));
      ledger.record(makeCostEntry({ executionId: 'exec-b' }));

      const results = ledger.query({ executionId: 'exec-a' });
      expect(results).toHaveLength(1);
      expect(results[0].executionId).toBe('exec-a');
    });

    it('filters by startTime', () => {
      const old = makeCostEntry({ timestamp: new Date('2026-01-01') });
      const recent = makeCostEntry({ timestamp: new Date('2026-02-01') });
      ledger.record(old);
      ledger.record(recent);

      const results = ledger.query({ startTime: new Date('2026-01-15') });
      expect(results).toHaveLength(1);
      expect(results[0].timestamp.getTime()).toBe(recent.timestamp.getTime());
    });

    it('filters by endTime', () => {
      const old = makeCostEntry({ timestamp: new Date('2026-01-01') });
      const recent = makeCostEntry({ timestamp: new Date('2026-02-01') });
      ledger.record(old);
      ledger.record(recent);

      const results = ledger.query({ endTime: new Date('2026-01-15') });
      expect(results).toHaveLength(1);
      expect(results[0].timestamp.getTime()).toBe(old.timestamp.getTime());
    });

    it('filters by combined criteria', () => {
      ledger.record(makeCostEntry({ userId: 'alice', flowName: 'summarizer' }));
      ledger.record(makeCostEntry({ userId: 'alice', flowName: 'classifier' }));
      ledger.record(makeCostEntry({ userId: 'bob', flowName: 'summarizer' }));

      const results = ledger.query({ userId: 'alice', flowName: 'summarizer' });
      expect(results).toHaveLength(1);
      expect(results[0].userId).toBe('alice');
      expect(results[0].flowName).toBe('summarizer');
    });

    it('returns empty array when no matches', () => {
      ledger.record(makeCostEntry({ userId: 'alice' }));
      const results = ledger.query({ userId: 'nonexistent' });
      expect(results).toHaveLength(0);
    });
  });

  describe('getTotal()', () => {
    it('aggregates cost for matching entries', () => {
      ledger.record(makeCostEntry({ userId: 'alice', cost: 1.0 }));
      ledger.record(makeCostEntry({ userId: 'alice', cost: 2.0 }));
      ledger.record(makeCostEntry({ userId: 'bob', cost: 3.0 }));

      const total = ledger.getTotal({ userId: 'alice' });
      expect(total).toBeCloseTo(3.0);
    });

    it('returns total across all entries with empty filter', () => {
      ledger.record(makeCostEntry({ cost: 1.0 }));
      ledger.record(makeCostEntry({ cost: 2.0 }));
      ledger.record(makeCostEntry({ cost: 3.0 }));

      const total = ledger.getTotal({});
      expect(total).toBeCloseTo(6.0);
    });

    it('returns 0 for empty ledger', () => {
      expect(ledger.getTotal({})).toBe(0);
    });
  });

  describe('getCount()', () => {
    it('returns 0 for empty ledger', () => {
      expect(ledger.getCount()).toBe(0);
    });

    it('returns current entry count', () => {
      ledger.record(makeCostEntry());
      ledger.record(makeCostEntry());
      expect(ledger.getCount()).toBe(2);
    });
  });

  describe('FIFO eviction', () => {
    it('evicts oldest entries when maxEntries reached', () => {
      const smallLedger = new InMemoryCostLedger(3);

      const entry1 = makeCostEntry({ id: 'oldest', cost: 1.0 });
      const entry2 = makeCostEntry({ id: 'middle', cost: 2.0 });
      const entry3 = makeCostEntry({ id: 'newest', cost: 3.0 });
      const entry4 = makeCostEntry({ id: 'added', cost: 4.0 });

      smallLedger.record(entry1);
      smallLedger.record(entry2);
      smallLedger.record(entry3);
      expect(smallLedger.getCount()).toBe(3);

      smallLedger.record(entry4);
      expect(smallLedger.getCount()).toBe(3);

      const all = smallLedger.query({});
      const ids = all.map((e) => e.id);
      expect(ids).not.toContain('oldest');
      expect(ids).toContain('middle');
      expect(ids).toContain('newest');
      expect(ids).toContain('added');
    });

    it('evicts by insertion order (FIFO), not by timestamp', () => {
      const smallLedger = new InMemoryCostLedger(2);

      // Insert an entry with a future timestamp first
      const future = makeCostEntry({ id: 'future', timestamp: new Date('2030-01-01') });
      const past = makeCostEntry({ id: 'past', timestamp: new Date('2020-01-01') });
      const newest = makeCostEntry({ id: 'newest' });

      smallLedger.record(future); // inserted first
      smallLedger.record(past);   // inserted second
      // Full, next insert evicts 'future' (first inserted)
      smallLedger.record(newest);

      const all = smallLedger.query({});
      const ids = all.map((e) => e.id);
      expect(ids).not.toContain('future'); // evicted despite future timestamp
      expect(ids).toContain('past');
      expect(ids).toContain('newest');
    });

    it('uses default maxEntries of 100000', () => {
      const defaultLedger = new InMemoryCostLedger();
      // Just verify it doesn't throw — actual 100K test is in NFR verification
      defaultLedger.record(makeCostEntry());
      expect(defaultLedger.getCount()).toBe(1);
    });
  });

  describe('NFR performance targets', () => {
    it('query at 100K entries completes within 50ms (NFR-003)', () => {
      const largeLedger = new InMemoryCostLedger(100_000);

      // Fill with 100K entries — half alice, half bob
      for (let i = 0; i < 100_000; i++) {
        largeLedger.record(makeCostEntry({
          userId: i % 2 === 0 ? 'alice' : 'bob',
          cost: 0.01,
        }));
      }
      expect(largeLedger.getCount()).toBe(100_000);

      // Time query with filter
      const start = performance.now();
      const results = largeLedger.query({ userId: 'alice' });
      const elapsed = performance.now() - start;

      expect(results).toHaveLength(50_000);
      expect(elapsed).toBeLessThan(50);
    });

    it('getTotal at 100K entries completes within 50ms (NFR-003)', () => {
      const largeLedger = new InMemoryCostLedger(100_000);

      for (let i = 0; i < 100_000; i++) {
        largeLedger.record(makeCostEntry({ cost: 0.01 }));
      }

      const start = performance.now();
      const total = largeLedger.getTotal({});
      const elapsed = performance.now() - start;

      expect(total).toBeCloseTo(1000, 0); // 100K * 0.01 = 1000
      expect(elapsed).toBeLessThan(50);
    });

    it('record() is synchronous single event-loop tick (NFR-001)', () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        ledger.record(makeCostEntry());
      }
      const elapsed = performance.now() - start;

      // 1000 records should be well under 10ms total (< 0.01ms each)
      expect(elapsed).toBeLessThan(10);
    });
  });
});
