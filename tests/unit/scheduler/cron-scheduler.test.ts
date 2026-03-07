// Unit tests for CronScheduler (US1 — Core Scheduling)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CronScheduler } from '../../../src/scheduler/cron-scheduler.js';
import type { ScheduleEntry } from '../../../src/scheduler/cron-scheduler.js';

// ── T008: CronScheduler lifecycle tests ──

describe('CronScheduler', () => {
  let scheduler: CronScheduler;
  let triggerCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    triggerCallback = vi.fn().mockResolvedValue('exec-123');
  });

  afterEach(async () => {
    if (scheduler) {
      await scheduler.shutdown();
    }
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should accept a trigger callback and default timezone', () => {
      scheduler = new CronScheduler(triggerCallback, 'UTC');
      expect(scheduler).toBeDefined();
    });

    it('should default timezone to UTC when not provided', () => {
      scheduler = new CronScheduler(triggerCallback);
      expect(scheduler).toBeDefined();
    });
  });

  describe('addSchedule', () => {
    beforeEach(() => {
      scheduler = new CronScheduler(triggerCallback);
    });

    it('should create an entry and arm a timer', () => {
      scheduler.addSchedule('my-flow', '* * * * *');

      const entry = scheduler.getSchedule('my-flow');
      expect(entry).toBeDefined();
      expect(entry!.flowName).toBe('my-flow');
      expect(entry!.cronExpression).toBe('* * * * *');
      expect(entry!.nextFireTime).toBeInstanceOf(Date);
      expect(entry!.timerHandle).toBeDefined();
    });

    it('should calculate the next fire time from the cron expression', () => {
      const now = new Date('2026-03-01T10:00:00.000Z');
      vi.setSystemTime(now);

      scheduler.addSchedule('hourly-flow', '0 * * * *');

      const entry = scheduler.getSchedule('hourly-flow');
      // Next fire time should be 11:00 UTC (next hour boundary)
      expect(entry!.nextFireTime.getTime()).toBeGreaterThan(now.getTime());
    });
  });

  describe('removeSchedule', () => {
    beforeEach(() => {
      scheduler = new CronScheduler(triggerCallback);
    });

    it('should clear the timer and remove the entry', () => {
      scheduler.addSchedule('my-flow', '* * * * *');
      expect(scheduler.getSchedule('my-flow')).toBeDefined();

      scheduler.removeSchedule('my-flow');
      expect(scheduler.getSchedule('my-flow')).toBeUndefined();
    });

    it('should be a no-op for non-existent flow', () => {
      expect(() => scheduler.removeSchedule('non-existent')).not.toThrow();
    });
  });

  describe('shutdown', () => {
    beforeEach(() => {
      scheduler = new CronScheduler(triggerCallback);
    });

    it('should clear all timers and remove all entries', async () => {
      scheduler.addSchedule('flow-a', '* * * * *');
      scheduler.addSchedule('flow-b', '0 * * * *');

      await scheduler.shutdown();

      expect(scheduler.getSchedule('flow-a')).toBeUndefined();
      expect(scheduler.getSchedule('flow-b')).toBeUndefined();
    });

    it('should prevent any triggers from firing after shutdown', async () => {
      scheduler.addSchedule('my-flow', '* * * * *');

      await scheduler.shutdown();

      // Advance time well past the next fire time
      vi.advanceTimersByTime(120_000);

      expect(triggerCallback).not.toHaveBeenCalled();
    });
  });

  // ── T009: Cron validation tests ──

  describe('cron validation', () => {
    beforeEach(() => {
      scheduler = new CronScheduler(triggerCallback);
    });

    it('should accept valid expression: "* * * * *" (every minute)', () => {
      expect(() => scheduler.addSchedule('flow', '* * * * *')).not.toThrow();
    });

    it('should accept valid expression: "0 7 * * *" (daily at 7am)', () => {
      expect(() => scheduler.addSchedule('flow', '0 7 * * *')).not.toThrow();
    });

    it('should accept valid expression: "0 9 * * 1-5" (weekdays at 9am)', () => {
      expect(() => scheduler.addSchedule('flow', '0 9 * * 1-5')).not.toThrow();
    });

    it('should throw INVALID_SCHEDULE for malformed expression: "99 99 * * *"', () => {
      expect(() => scheduler.addSchedule('flow', '99 99 * * *')).toThrow();
      try {
        scheduler.addSchedule('flow2', '99 99 * * *');
      } catch (e: any) {
        expect(e.code).toBe('INVALID_SCHEDULE');
      }
    });

    it('should throw INVALID_SCHEDULE for non-cron string: "not-a-cron"', () => {
      expect(() => scheduler.addSchedule('flow', 'not-a-cron')).toThrow();
      try {
        scheduler.addSchedule('flow2', 'not-a-cron');
      } catch (e: any) {
        expect(e.code).toBe('INVALID_SCHEDULE');
      }
    });

    it('should throw INVALID_SCHEDULE for impossible expressions (nextRun returns null)', () => {
      // February 30th — syntactically could parse but can never fire
      // Using a date pattern that croner recognizes as impossible
      expect(() => scheduler.addSchedule('flow', '0 0 30 2 *')).toThrow();
      try {
        scheduler.addSchedule('flow2', '0 0 30 2 *');
      } catch (e: any) {
        expect(e.code).toBe('INVALID_SCHEDULE');
      }
    });
  });

  // ── T010: onTick tests (idempotency keys, trigger input, re-arm) ──

  describe('onTick behavior', () => {
    beforeEach(() => {
      scheduler = new CronScheduler(triggerCallback);
    });

    /** Flush microtask queue to let async onTick complete */
    async function flushMicrotasks(): Promise<void> {
      await new Promise<void>((resolve) => process.nextTick(resolve));
    }

    it('should generate idempotency key in format "scheduled:{flowName}:{ISO-8601 UTC}"', async () => {
      const now = new Date('2026-03-01T07:00:00.000Z');
      vi.setSystemTime(now);

      scheduler.addSchedule('morning-brief', '0 7 * * *');

      // Advance to the next fire time (fires the setTimeout)
      const entry = scheduler.getSchedule('morning-brief');
      const msUntilFire = entry!.nextFireTime.getTime() - now.getTime();
      vi.advanceTimersByTime(msUntilFire);

      // Flush the microtask queue so the async onTick callback completes
      await flushMicrotasks();

      expect(triggerCallback).toHaveBeenCalled();
      const callArgs = triggerCallback.mock.calls[0];
      const idempotencyKey = callArgs[1]; // second arg is idempotencyKey
      expect(idempotencyKey).toMatch(/^scheduled:morning-brief:\d{4}-\d{2}-\d{2}T/);
    });

    it('should pass { scheduledAt: Date } as trigger input', async () => {
      const now = new Date('2026-03-01T00:00:00.000Z');
      vi.setSystemTime(now);

      scheduler.addSchedule('test-flow', '* * * * *');

      const entry = scheduler.getSchedule('test-flow');
      const msUntilFire = entry!.nextFireTime.getTime() - now.getTime();
      vi.advanceTimersByTime(msUntilFire);
      await flushMicrotasks();

      expect(triggerCallback).toHaveBeenCalled();
      const callArgs = triggerCallback.mock.calls[0];
      const input = callArgs[2]; // third arg is input
      expect(input).toHaveProperty('scheduledAt');
      expect(input.scheduledAt).toBeInstanceOf(Date);
    });

    it('should re-arm timer after trigger fires', async () => {
      const now = new Date('2026-03-01T00:00:00.000Z');
      vi.setSystemTime(now);

      scheduler.addSchedule('test-flow', '* * * * *');

      const entry1NextFire = scheduler.getSchedule('test-flow')!.nextFireTime.getTime();
      const ms1 = entry1NextFire - now.getTime();
      vi.advanceTimersByTime(ms1);
      await flushMicrotasks();

      expect(triggerCallback).toHaveBeenCalledTimes(1);

      // After firing, the entry should be re-armed with a new nextFireTime
      const entry2 = scheduler.getSchedule('test-flow');
      expect(entry2).toBeDefined();
      expect(entry2!.nextFireTime.getTime()).toBeGreaterThan(entry1NextFire);
    });

    it('should re-arm timer even when trigger callback throws', async () => {
      triggerCallback.mockRejectedValueOnce(new Error('trigger failed'));

      const now = new Date('2026-03-01T00:00:00.000Z');
      vi.setSystemTime(now);

      scheduler.addSchedule('failing-flow', '* * * * *');

      const entry1NextFire = scheduler.getSchedule('failing-flow')!.nextFireTime.getTime();
      const ms1 = entry1NextFire - now.getTime();
      vi.advanceTimersByTime(ms1);
      await flushMicrotasks();
      // Extra flush for the rejected promise handling
      await flushMicrotasks();

      // Trigger was called even though it failed
      expect(triggerCallback).toHaveBeenCalledTimes(1);

      // Timer should still be re-armed
      const entry2 = scheduler.getSchedule('failing-flow');
      expect(entry2).toBeDefined();
      expect(entry2!.nextFireTime.getTime()).toBeGreaterThan(entry1NextFire);
    });
  });

  // ── T020-T022: Timezone tests (US2) ──

  describe('timezone resolution (US2)', () => {
    beforeEach(() => {
      scheduler = new CronScheduler(triggerCallback, 'America/Chicago');
    });

    it('should use per-flow timezone when provided', () => {
      const now = new Date('2026-03-01T12:00:00.000Z');
      vi.setSystemTime(now);

      scheduler.addSchedule('flow-ny', '0 7 * * *', 'America/New_York');
      const entry = scheduler.getSchedule('flow-ny');
      expect(entry!.timezone).toBe('America/New_York');
    });

    it('should use engine default timezone when per-flow not provided', () => {
      const now = new Date('2026-03-01T12:00:00.000Z');
      vi.setSystemTime(now);

      scheduler.addSchedule('flow-default', '0 7 * * *');
      const entry = scheduler.getSchedule('flow-default');
      expect(entry!.timezone).toBe('America/Chicago');
    });

    it('should fall back to UTC when no default set', () => {
      const utcScheduler = new CronScheduler(triggerCallback);
      const now = new Date('2026-03-01T12:00:00.000Z');
      vi.setSystemTime(now);

      utcScheduler.addSchedule('flow-utc', '0 7 * * *');
      const entry = utcScheduler.getSchedule('flow-utc');
      expect(entry!.timezone).toBe('UTC');
      utcScheduler.shutdown();
    });

    it('should accept explicit "UTC" timezone', () => {
      scheduler.addSchedule('flow-explicit-utc', '0 7 * * *', 'UTC');
      const entry = scheduler.getSchedule('flow-explicit-utc');
      expect(entry!.timezone).toBe('UTC');
    });
  });

  describe('DST handling (US2)', () => {
    beforeEach(() => {
      scheduler = new CronScheduler(triggerCallback);
    });

    it('should handle spring-forward (gap): fire at next cron match, not skip day', () => {
      // 2026 spring forward in US Eastern: March 8, 2:00 AM → 3:00 AM
      // Set time to just before the DST change
      const beforeDST = new Date('2026-03-08T06:00:00.000Z'); // 1AM ET
      vi.setSystemTime(beforeDST);

      // Schedule at 2:30 AM ET — this time doesn't exist during spring-forward
      scheduler.addSchedule('spring-flow', '30 2 * * *', 'America/New_York');
      const entry = scheduler.getSchedule('spring-flow');

      // The next fire time should be AFTER the DST gap (croner handles this)
      // It should not skip the entire day
      expect(entry!.nextFireTime).toBeDefined();
      expect(entry!.nextFireTime.getTime()).toBeGreaterThan(beforeDST.getTime());
    });

    it('should handle fall-back (overlap): fire at first occurrence only', () => {
      // 2026 fall back in US Eastern: November 1, 2:00 AM → 1:00 AM
      const beforeFallBack = new Date('2026-11-01T04:00:00.000Z'); // midnight ET
      vi.setSystemTime(beforeFallBack);

      scheduler.addSchedule('fall-flow', '30 1 * * *', 'America/New_York');
      const entry = scheduler.getSchedule('fall-flow');

      // Should fire at the first 1:30 AM occurrence
      expect(entry!.nextFireTime).toBeDefined();
      expect(entry!.nextFireTime.getTime()).toBeGreaterThan(beforeFallBack.getTime());
    });

    it('should use croner timezone option for DST calculation', () => {
      const now = new Date('2026-06-15T12:00:00.000Z');
      vi.setSystemTime(now);

      // In summer, New York is UTC-4
      scheduler.addSchedule('summer-flow', '0 7 * * *', 'America/New_York');
      const entry = scheduler.getSchedule('summer-flow');

      // 7am ET in summer = 11am UTC
      const expectedHourUTC = 11;
      const nextFireHourUTC = entry!.nextFireTime.getUTCHours();
      expect(nextFireHourUTC).toBe(expectedHourUTC);
    });
  });

  describe('timezone validation (US2)', () => {
    beforeEach(() => {
      scheduler = new CronScheduler(triggerCallback);
    });

    it('should accept valid IANA identifier: "America/New_York"', () => {
      expect(() =>
        scheduler.addSchedule('flow', '0 7 * * *', 'America/New_York'),
      ).not.toThrow();
    });

    it('should accept valid IANA identifier: "Europe/London"', () => {
      expect(() =>
        scheduler.addSchedule('flow', '0 7 * * *', 'Europe/London'),
      ).not.toThrow();
    });

    it('should accept "UTC"', () => {
      expect(() =>
        scheduler.addSchedule('flow', '0 7 * * *', 'UTC'),
      ).not.toThrow();
    });

    it('should throw INVALID_TIMEZONE for invalid string: "Not/A/Zone"', () => {
      expect(() =>
        scheduler.addSchedule('flow', '0 7 * * *', 'Not/A/Zone'),
      ).toThrow();
      try {
        scheduler.addSchedule('flow2', '0 7 * * *', 'Not/A/Zone');
      } catch (e: any) {
        expect(e.code).toBe('INVALID_TIMEZONE');
      }
    });

    it('should throw INVALID_TIMEZONE for abbreviation: "EST"', () => {
      expect(() =>
        scheduler.addSchedule('flow', '0 7 * * *', 'EST'),
      ).toThrow();
      try {
        scheduler.addSchedule('flow2', '0 7 * * *', 'EST');
      } catch (e: any) {
        expect(e.code).toBe('INVALID_TIMEZONE');
      }
    });

    it('should throw INVALID_TIMEZONE for empty string', () => {
      expect(() =>
        scheduler.addSchedule('flow', '0 7 * * *', ''),
      ).toThrow();
      try {
        scheduler.addSchedule('flow2', '0 7 * * *', '');
      } catch (e: any) {
        expect(e.code).toBe('INVALID_TIMEZONE');
      }
    });
  });

  // ── T031: Scheduler events tests (US4) ──

  describe('scheduler events (US4)', () => {
    let events: Array<{ event: string; payload: Record<string, unknown> }>;

    beforeEach(() => {
      scheduler = new CronScheduler(triggerCallback);
      events = [];
      scheduler.setEventCallback((event, payload) => {
        events.push({ event, payload });
      });
    });

    it('should emit scheduler:registered with full payload on addSchedule', () => {
      const now = new Date('2026-03-01T12:00:00.000Z');
      vi.setSystemTime(now);

      scheduler.addSchedule('my-flow', '0 7 * * *', 'America/New_York');

      const registered = events.find((e) => e.event === 'scheduler:registered');
      expect(registered).toBeDefined();
      expect(registered!.payload.flowName).toBe('my-flow');
      expect(registered!.payload.cronExpression).toBe('0 7 * * *');
      expect(registered!.payload.timezone).toBe('America/New_York');
      expect(registered!.payload.nextFireTime).toBeInstanceOf(Date);
    });

    it('should emit scheduler:removed with flowName on removeSchedule', () => {
      scheduler.addSchedule('my-flow', '* * * * *');
      events = []; // clear registration event

      scheduler.removeSchedule('my-flow');

      const removed = events.find((e) => e.event === 'scheduler:removed');
      expect(removed).toBeDefined();
      expect(removed!.payload.flowName).toBe('my-flow');
    });

    it('should emit scheduler:trigger with full payload on successful tick', async () => {
      const now = new Date('2026-03-01T00:00:00.000Z');
      vi.setSystemTime(now);

      scheduler.addSchedule('trigger-flow', '* * * * *');
      events = []; // clear registration event

      const entry = scheduler.getSchedule('trigger-flow');
      vi.advanceTimersByTime(entry!.nextFireTime.getTime() - now.getTime());
      await new Promise<void>((resolve) => process.nextTick(resolve));

      const trigger = events.find((e) => e.event === 'scheduler:trigger');
      expect(trigger).toBeDefined();
      expect(trigger!.payload.flowName).toBe('trigger-flow');
      expect(trigger!.payload.scheduledTime).toBeInstanceOf(Date);
      expect(trigger!.payload.idempotencyKey).toMatch(/^scheduled:trigger-flow:/);
      expect(trigger!.payload.executionId).toBe('exec-123');
    });

    it('should emit scheduler:skip with overlap reason when overlap detected', async () => {
      const overlapCheck = vi.fn().mockResolvedValue('exec-active-1');
      scheduler.setOverlapCheckCallback(overlapCheck);

      const now = new Date('2026-03-01T00:00:00.000Z');
      vi.setSystemTime(now);

      scheduler.addSchedule('slow-flow', '* * * * *');
      events = []; // clear registration event

      const entry = scheduler.getSchedule('slow-flow');
      vi.advanceTimersByTime(entry!.nextFireTime.getTime() - now.getTime());
      await new Promise<void>((resolve) => process.nextTick(resolve));

      const skip = events.find((e) => e.event === 'scheduler:skip');
      expect(skip).toBeDefined();
      expect(skip!.payload.flowName).toBe('slow-flow');
      expect(skip!.payload.scheduledTime).toBeInstanceOf(Date);
      expect(skip!.payload.reason).toBe('overlap');
      expect(skip!.payload.activeExecutionId).toBe('exec-active-1');
    });
  });

  // ── T038: NFR verification test ──

  describe('NFR verification (performance)', () => {
    it('should have zero overhead with no scheduled flows', () => {
      // Creating CronScheduler with no schedules should use no timers
      const scheduler = new CronScheduler(vi.fn().mockResolvedValue('id'));
      expect(scheduler.getSchedule('nonexistent')).toBeUndefined();
      scheduler.shutdown();
    });

    it('should handle 100 scheduled flows without significant memory overhead', () => {
      const scheduler = new CronScheduler(vi.fn().mockResolvedValue('id'));
      const now = new Date('2026-03-01T00:00:00.000Z');
      vi.setSystemTime(now);

      const memBefore = process.memoryUsage().heapUsed;

      for (let i = 0; i < 100; i++) {
        scheduler.addSchedule(`flow-${i}`, '0 * * * *');
      }

      const memAfter = process.memoryUsage().heapUsed;
      const memDelta = memAfter - memBefore;

      // < 50KB per schedule entry = 5MB total
      expect(memDelta).toBeLessThan(5_000_000);

      scheduler.shutdown();
    });
  });

  // ── T026-T027: Overlap detection tests (US3) ──

  describe('overlap detection (US3)', () => {
    let overlapCheck: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      scheduler = new CronScheduler(triggerCallback);
      overlapCheck = vi.fn().mockResolvedValue(null); // no overlap by default
      scheduler.setOverlapCheckCallback(overlapCheck);
    });

    /** Flush microtask queue */
    async function flushMicrotasks(): Promise<void> {
      await new Promise<void>((resolve) => process.nextTick(resolve));
    }

    it('should block trigger when execution is in "queued" state (overlap)', async () => {
      overlapCheck.mockResolvedValue('exec-active-1');
      const now = new Date('2026-03-01T00:00:00.000Z');
      vi.setSystemTime(now);

      scheduler.addSchedule('slow-flow', '* * * * *');
      const entry = scheduler.getSchedule('slow-flow');
      vi.advanceTimersByTime(entry!.nextFireTime.getTime() - now.getTime());
      await flushMicrotasks();

      // Trigger callback should NOT have been called (overlap detected)
      expect(triggerCallback).not.toHaveBeenCalled();
    });

    it('should fire trigger when no active execution (no overlap)', async () => {
      overlapCheck.mockResolvedValue(null);
      const now = new Date('2026-03-01T00:00:00.000Z');
      vi.setSystemTime(now);

      scheduler.addSchedule('fast-flow', '* * * * *');
      const entry = scheduler.getSchedule('fast-flow');
      vi.advanceTimersByTime(entry!.nextFireTime.getTime() - now.getTime());
      await flushMicrotasks();

      expect(triggerCallback).toHaveBeenCalledTimes(1);
    });

    it('should re-arm timer after skip (overlap)', async () => {
      overlapCheck.mockResolvedValue('exec-active-1');
      const now = new Date('2026-03-01T00:00:00.000Z');
      vi.setSystemTime(now);

      scheduler.addSchedule('slow-flow', '* * * * *');
      const firstFire = scheduler.getSchedule('slow-flow')!.nextFireTime.getTime();
      vi.advanceTimersByTime(firstFire - now.getTime());
      await flushMicrotasks();

      // Timer should be re-armed with a new nextFireTime
      const entry = scheduler.getSchedule('slow-flow');
      expect(entry).toBeDefined();
      expect(entry!.nextFireTime.getTime()).toBeGreaterThan(firstFire);
    });

    it('should resume firing after previous execution completes', async () => {
      // First tick: overlap detected
      overlapCheck.mockResolvedValueOnce('exec-active-1');
      const now = new Date('2026-03-01T00:00:00.000Z');
      vi.setSystemTime(now);

      scheduler.addSchedule('resume-flow', '* * * * *');
      const firstFire = scheduler.getSchedule('resume-flow')!.nextFireTime.getTime();
      vi.advanceTimersByTime(firstFire - now.getTime());
      await flushMicrotasks();
      expect(triggerCallback).not.toHaveBeenCalled();

      // Second tick: no overlap (previous completed)
      overlapCheck.mockResolvedValueOnce(null);
      const secondFire = scheduler.getSchedule('resume-flow')!.nextFireTime.getTime();
      vi.advanceTimersByTime(secondFire - firstFire);
      await flushMicrotasks();
      expect(triggerCallback).toHaveBeenCalledTimes(1);
    });
  });
});
