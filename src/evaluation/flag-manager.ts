// FlagManager — human review flag lifecycle management

import type {
  HumanReviewFlag,
  FlagStatus,
  FlagFilter,
} from '../types.js';
import { EngineError } from '../errors.js';

/** Valid flag status transitions */
const VALID_TRANSITIONS: ReadonlyMap<FlagStatus, ReadonlySet<FlagStatus>> = new Map([
  ['pending', new Set<FlagStatus>(['reviewed'])],
  ['reviewed', new Set<FlagStatus>(['resolved'])],
  ['resolved', new Set<FlagStatus>([])],
]);

/**
 * Manages human review flags for executions.
 * Flags follow a linear lifecycle: pending → reviewed → resolved.
 */
export class FlagManager {
  private readonly flags = new Map<string, HumanReviewFlag>();

  /** Create a flag for an execution. Throws ALREADY_FLAGGED if flag exists. */
  createFlag(
    executionId: string,
    flowName: string,
    reason: string,
    source: 'auto' | 'manual',
  ): HumanReviewFlag {
    if (this.flags.has(executionId)) {
      throw new EngineError(
        `Execution "${executionId}" is already flagged.`,
        'ALREADY_FLAGGED',
      );
    }

    const now = new Date();
    const flag: HumanReviewFlag = {
      executionId,
      flowName,
      status: 'pending',
      reason,
      source,
      createdAt: now,
      updatedAt: now,
    };

    this.flags.set(executionId, flag);
    return flag;
  }

  /** Update flag status. Validates transition is legal per spec. */
  updateFlag(executionId: string, status: FlagStatus): void {
    const flag = this.flags.get(executionId);
    if (!flag) {
      throw new EngineError(
        `No flag found for execution "${executionId}".`,
        'FLAG_NOT_FOUND',
      );
    }

    const validNext = VALID_TRANSITIONS.get(flag.status);
    if (!validNext || !validNext.has(status)) {
      throw new EngineError(
        `Invalid flag transition: ${flag.status} → ${status}`,
        'INVALID_FLAG_TRANSITION',
      );
    }

    flag.status = status;
    flag.updatedAt = new Date();
  }

  /** Get a flag by execution ID. Returns null if not found. */
  getFlag(executionId: string): HumanReviewFlag | null {
    return this.flags.get(executionId) ?? null;
  }

  /** List flags matching optional filter criteria. */
  listFlags(filter?: FlagFilter): HumanReviewFlag[] {
    const all = Array.from(this.flags.values());

    if (!filter) {
      return all;
    }

    return all.filter((flag) => {
      if (filter.flowName && flag.flowName !== filter.flowName) return false;
      if (filter.status && flag.status !== filter.status) return false;
      return true;
    });
  }
}
