// InMemoryCostLedger — CostLedgerStore implementation

import type { CostEntry, CostLedgerStore, CostQueryFilter } from '../types.js';

/** Default maximum ledger entries before FIFO eviction */
const DEFAULT_MAX_ENTRIES = 100_000;

/**
 * In-memory cost ledger with bounded storage and FIFO eviction.
 * Budget accumulators are separate and unaffected by eviction.
 */
export class InMemoryCostLedger implements CostLedgerStore {
  private readonly entries: CostEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  /** Record a new cost entry, evicting oldest if at capacity (FIFO by insertion order) */
  record(entry: CostEntry): void {
    if (this.entries.length >= this.maxEntries) {
      this.entries.shift(); // Remove oldest (first inserted)
    }
    this.entries.push(entry);
  }

  /** Query entries by filter criteria */
  query(filter: CostQueryFilter): CostEntry[] {
    return this.entries.filter((entry) => this.matchesFilter(entry, filter));
  }

  /** Get aggregated cost total for matching entries */
  getTotal(filter: CostQueryFilter): number {
    let total = 0;
    for (const entry of this.entries) {
      if (this.matchesFilter(entry, filter)) {
        total += entry.cost;
      }
    }
    return total;
  }

  /** Get current entry count */
  getCount(): number {
    return this.entries.length;
  }

  private matchesFilter(entry: CostEntry, filter: CostQueryFilter): boolean {
    if (filter.userId !== undefined && entry.userId !== filter.userId) return false;
    if (filter.flowName !== undefined && entry.flowName !== filter.flowName) return false;
    if (filter.executionId !== undefined && entry.executionId !== filter.executionId) return false;
    if (filter.startTime !== undefined && entry.timestamp < filter.startTime) return false;
    if (filter.endTime !== undefined && entry.timestamp > filter.endTime) return false;
    return true;
  }
}
