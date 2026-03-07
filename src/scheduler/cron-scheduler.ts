// CronScheduler: Internal engine subsystem for cron-based flow scheduling
// Scheduled Flow Execution

import { Cron } from 'croner';
import { EngineError } from '../errors.js';

/** Timer handle returned by setTimeout */
type TimerHandle = ReturnType<typeof setTimeout>;

/** Maximum safe setTimeout delay (~24.8 days). Beyond this, use 12-hour re-arm. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Re-arm interval for far-future schedules (12 hours). */
const REARM_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Internal state for a scheduled flow */
export interface ScheduleEntry {
  flowName: string;
  cronExpression: string;
  timezone: string;
  nextFireTime: Date;
  activeExecutionId: string | null;
  timerHandle: TimerHandle;
  lastFiredAt: Date | null;
  lastSkippedAt: Date | null;
}

/**
 * Callback signature for triggering a flow.
 * Returns the execution ID on success.
 * (flowName, idempotencyKey, input) => executionId
 */
export type TriggerCallback = (
  flowName: string,
  idempotencyKey: string,
  input: { scheduledAt: Date },
) => Promise<string>;

/**
 * Optional callback for emitting scheduler events through the engine.
 */
export type EventCallback = (
  event: string,
  payload: Record<string, unknown>,
) => void;

/**
 * Optional callback for checking overlap (active executions).
 * Returns the active execution ID if overlap detected, null otherwise.
 */
export type OverlapCheckCallback = (flowName: string) => Promise<string | null>;

export class CronScheduler {
  private readonly schedules = new Map<string, ScheduleEntry>();
  private readonly triggerCallback: TriggerCallback;
  private readonly defaultTimezone: string;
  private shuttingDown = false;
  private eventCallback?: EventCallback;
  private overlapCheckCallback?: OverlapCheckCallback;

  constructor(triggerCallback: TriggerCallback, defaultTimezone?: string) {
    this.triggerCallback = triggerCallback;
    this.defaultTimezone = defaultTimezone ?? 'UTC';
  }

  /** Set the event emission callback (wired by Engine) */
  setEventCallback(callback: EventCallback): void {
    this.eventCallback = callback;
  }

  /** Set the overlap check callback (wired by Engine) */
  setOverlapCheckCallback(callback: OverlapCheckCallback): void {
    this.overlapCheckCallback = callback;
  }

  /** Register a schedule for a flow. Validates cron and arms timer. */
  addSchedule(flowName: string, cronExpression: string, timezone?: string): void {
    const resolvedTimezone = timezone ?? this.defaultTimezone;

    // Validate IANA timezone identifier
    if (timezone !== undefined) {
      this.validateTimezone(resolvedTimezone);
    }

    // Validate cron expression using croner
    let cron: Cron;
    try {
      cron = new Cron(cronExpression, { timezone: resolvedTimezone });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new EngineError(
        `Invalid cron expression '${cronExpression}': ${message}`,
        'INVALID_SCHEDULE',
      );
    }

    // Check for impossible expressions (nextRun returns null)
    const nextRun = cron.nextRun();
    if (nextRun === null) {
      throw new EngineError(
        `Invalid cron expression '${cronExpression}': expression can never match a future date`,
        'INVALID_SCHEDULE',
      );
    }

    // Clean up any existing schedule for this flow
    if (this.schedules.has(flowName)) {
      this.removeSchedule(flowName);
    }

    // Create the schedule entry and arm the timer
    const entry: ScheduleEntry = {
      flowName,
      cronExpression,
      timezone: resolvedTimezone,
      nextFireTime: nextRun,
      activeExecutionId: null,
      timerHandle: null as unknown as TimerHandle,
      lastFiredAt: null,
      lastSkippedAt: null,
    };

    this.schedules.set(flowName, entry);
    this.armTimer(entry);

    // Emit scheduler:registered event
    this.emitEvent('scheduler:registered', {
      flowName,
      cronExpression,
      timezone: resolvedTimezone,
      nextFireTime: nextRun,
    });
  }

  /** Remove a schedule and clear its timer. */
  removeSchedule(flowName: string): void {
    const entry = this.schedules.get(flowName);
    if (!entry) return;

    clearTimeout(entry.timerHandle);
    this.schedules.delete(flowName);

    // Emit scheduler:removed event
    this.emitEvent('scheduler:removed', { flowName });
  }

  /** Get a schedule entry (for testing/inspection). */
  getSchedule(flowName: string): ScheduleEntry | undefined {
    return this.schedules.get(flowName);
  }

  /** Clear the active execution ID by execution ID (called when execution completes). */
  clearActiveExecution(executionId: string): void {
    for (const entry of this.schedules.values()) {
      if (entry.activeExecutionId === executionId) {
        entry.activeExecutionId = null;
        return;
      }
    }
  }

  /** Shut down the scheduler — clear all timers, prevent future triggers. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    for (const [flowName, entry] of this.schedules) {
      clearTimeout(entry.timerHandle);
    }
    this.schedules.clear();
  }

  /** Arm (or re-arm) the setTimeout for the next fire time. */
  private armTimer(entry: ScheduleEntry): void {
    const now = Date.now();
    const delayMs = entry.nextFireTime.getTime() - now;

    if (delayMs > MAX_TIMEOUT_MS) {
      // Far-future guard — use 12-hour re-arm pattern
      entry.timerHandle = setTimeout(() => {
        this.recheckAndRearm(entry);
      }, REARM_INTERVAL_MS);
    } else {
      entry.timerHandle = setTimeout(() => {
        void this.onTick(entry.flowName);
      }, Math.max(0, delayMs));
    }
  }

  /** Re-check cron expression and re-arm for far-future schedules. */
  private recheckAndRearm(entry: ScheduleEntry): void {
    if (this.shuttingDown) return;

    const current = this.schedules.get(entry.flowName);
    if (!current) return;

    // Recalculate next fire time from cron expression
    const cron = new Cron(current.cronExpression, { timezone: current.timezone });
    const nextRun = cron.nextRun();
    if (nextRun) {
      current.nextFireTime = nextRun;
      this.armTimer(current);
    }
  }

  /** Handle a timer tick — validate, trigger, and re-arm. */
  private async onTick(flowName: string): Promise<void> {
    if (this.shuttingDown) {
      // Emit skip with shutting_down reason
      const entry = this.schedules.get(flowName);
      if (entry) {
        this.emitEvent('scheduler:skip', {
          flowName,
          scheduledTime: entry.nextFireTime,
          reason: 'shutting_down' as const,
        });
      }
      return;
    }

    const entry = this.schedules.get(flowName);
    if (!entry) return;

    const scheduledTime = entry.nextFireTime;

    // Check for overlap (only active when overlapCheckCallback is set)
    if (this.overlapCheckCallback) {
      const activeExecId = await this.overlapCheckCallback(flowName);
      if (activeExecId) {
        entry.lastSkippedAt = scheduledTime;
        entry.activeExecutionId = activeExecId;

        this.emitEvent('scheduler:skip', {
          flowName,
          scheduledTime,
          reason: 'overlap' as const,
          activeExecutionId: activeExecId,
        });

        // Re-arm even on skip
        this.calculateNextAndRearm(entry);
        return;
      }
    }

    // Generate idempotency key: scheduled:{flowName}:{ISO-8601 UTC}
    const idempotencyKey = `scheduled:${flowName}:${scheduledTime.toISOString()}`;

    // Trigger the flow — always re-arm regardless of success/failure
    try {
      const executionId = await this.triggerCallback(
        flowName,
        idempotencyKey,
        { scheduledAt: scheduledTime },
      );

      entry.lastFiredAt = scheduledTime;
      entry.activeExecutionId = executionId;

      this.emitEvent('scheduler:trigger', {
        flowName,
        scheduledTime,
        idempotencyKey,
        executionId,
      });
    } catch {
      // Trigger failed — still re-arm
    }

    // Re-arm for next fire time
    this.calculateNextAndRearm(entry);
  }

  /** Calculate the next fire time from the cron expression and re-arm. */
  private calculateNextAndRearm(entry: ScheduleEntry): void {
    if (this.shuttingDown) return;

    const current = this.schedules.get(entry.flowName);
    if (!current) return;

    const cron = new Cron(current.cronExpression, { timezone: current.timezone });
    // Calculate next fire time from the PREVIOUS scheduled time (not from now)
    // This prevents drift
    const nextRun = cron.nextRun(current.nextFireTime);
    if (nextRun) {
      current.nextFireTime = nextRun;
      this.armTimer(current);
    }
  }

  /** Validate that a string is a valid IANA timezone identifier. */
  private validateTimezone(tz: string): void {
    if (!tz) {
      throw new EngineError(
        `Invalid timezone '${tz}'. Use IANA format (e.g., 'America/New_York').`,
        'INVALID_TIMEZONE',
      );
    }
    // Reject abbreviations (EST, PST, etc.) — only accept IANA format
    // Valid IANA: contains '/' (e.g., America/New_York) or is 'UTC' or 'GMT'
    const isIANA = tz === 'UTC' || tz === 'GMT' || tz.includes('/');
    if (!isIANA) {
      throw new EngineError(
        `Invalid timezone '${tz}'. Use IANA format (e.g., 'America/New_York').`,
        'INVALID_TIMEZONE',
      );
    }
    try {
      // Use Intl.DateTimeFormat to validate IANA identifiers
      Intl.DateTimeFormat(undefined, { timeZone: tz });
    } catch {
      throw new EngineError(
        `Invalid timezone '${tz}'. Use IANA format (e.g., 'America/New_York').`,
        'INVALID_TIMEZONE',
      );
    }
  }

  /** Emit an event through the engine callback if set. */
  private emitEvent(event: string, payload: Record<string, unknown>): void {
    if (this.eventCallback) {
      try {
        this.eventCallback(event, payload);
      } catch {
        // Events are best-effort (matches engine pattern)
      }
    }
  }
}
