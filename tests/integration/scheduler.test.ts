// Integration test for scheduled trigger lifecycle (US1)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEngine } from '../../src/engine.js';
import type { ModelProvider } from '../../src/model/provider.js';

function createMockProvider(): ModelProvider {
  return {
    name: 'mock',
    complete: vi.fn().mockResolvedValue({
      text: 'scheduled result',
      model: 'mock',
      provider: 'mock',
      usage: { promptTokens: 10, completionTokens: 10 },
    }),
  };
}

/** Flush microtask queue multiple times to let async pipelines settle */
async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => process.nextTick(resolve));
  }
}

describe('Scheduler Integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should auto-trigger a flow registered with a schedule', async () => {
    const now = new Date('2026-03-01T06:59:00.000Z');
    vi.setSystemTime(now);

    const engine = await createEngine({
      model: { provider: createMockProvider() },
    });

    let triggered = false;
    engine.register('morning-brief', async (ctx) => {
      triggered = true;
      return `Good morning!`;
    }, {
      schedule: '0 7 * * *',
    });

    // Advance exactly to 7:00 AM (60 seconds)
    vi.advanceTimersByTime(60_000);
    await settle();

    // Advance a bit more for the engine execution pipeline to complete
    vi.advanceTimersByTime(100);
    await settle();

    expect(triggered).toBe(true);

    // Shutdown: advance timers to let drain complete
    const shutdownPromise = engine.shutdown();
    vi.advanceTimersByTime(1000);
    await settle();
    vi.advanceTimersByTime(100);
    await settle();
    await shutdownPromise;
  }, 10_000);

  it('should generate correct idempotency key for scheduled triggers', async () => {
    const now = new Date('2026-03-01T06:59:00.000Z');
    vi.setSystemTime(now);

    const engine = await createEngine({
      model: { provider: createMockProvider() },
    });

    // Capture execution IDs from completion events
    const completedIds: string[] = [];
    engine.on('execution:complete', (event) => {
      completedIds.push(event.executionId);
    });

    engine.register('test-flow', async () => 'done', {
      schedule: '0 7 * * *',
    });

    // Fire the scheduled trigger
    vi.advanceTimersByTime(60_000);
    await settle();
    vi.advanceTimersByTime(100);
    await settle();

    expect(completedIds.length).toBeGreaterThanOrEqual(1);

    // Verify the execution has a scheduled: prefix idempotency key
    const exec = await engine.getExecution(completedIds[0]);
    expect(exec).toBeDefined();
    expect(exec!.idempotencyKey).toMatch(
      /^scheduled:test-flow:\d{4}-\d{2}-\d{2}T/,
    );

    const shutdownPromise = engine.shutdown();
    vi.advanceTimersByTime(1000);
    await settle();
    vi.advanceTimersByTime(100);
    await settle();
    await shutdownPromise;
  }, 10_000);

  it('should stop scheduling when flow is unregistered', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    vi.setSystemTime(now);

    const engine = await createEngine({
      model: { provider: createMockProvider() },
    });

    let triggerCount = 0;
    engine.register('ephemeral', async () => {
      triggerCount++;
      return 'result';
    }, {
      schedule: '* * * * *', // every minute
    });

    // First trigger fires at 00:01
    vi.advanceTimersByTime(60_000);
    await settle();
    vi.advanceTimersByTime(100);
    await settle();

    const countAfterFirst = triggerCount;
    expect(countAfterFirst).toBe(1);

    // Unregister the flow — removes the schedule
    engine.unregister('ephemeral');

    // Advance more time — no more triggers should fire
    vi.advanceTimersByTime(300_000);
    await settle();

    expect(triggerCount).toBe(countAfterFirst);

    const shutdownPromise = engine.shutdown();
    vi.advanceTimersByTime(1000);
    await settle();
    vi.advanceTimersByTime(100);
    await settle();
    await shutdownPromise;
  }, 10_000);

  it('should not fire any triggers during shutdown drain', async () => {
    const now = new Date('2026-03-01T00:00:30.000Z');
    vi.setSystemTime(now);

    const engine = await createEngine({
      model: { provider: createMockProvider() },
    });

    let triggerCount = 0;
    engine.register('drain-test', async () => {
      triggerCount++;
      return 'result';
    }, {
      schedule: '* * * * *', // next fire at 00:01:00, 30s away
    });

    // Shutdown before the schedule fires (only 30s in, next fire at 60s)
    const shutdownPromise = engine.shutdown();
    vi.advanceTimersByTime(1000);
    await settle();
    vi.advanceTimersByTime(100);
    await settle();
    await shutdownPromise;

    expect(triggerCount).toBe(0);
  }, 10_000);

  // T032: Full event sequence integration test (US4)
  it('should emit scheduler:registered event on flow registration', async () => {
    const now = new Date('2026-03-01T06:59:00.000Z');
    vi.setSystemTime(now);

    const engine = await createEngine({
      model: { provider: createMockProvider() },
    });

    const events: Array<{ type: string; payload: any }> = [];
    engine.on('scheduler:registered', (payload) => {
      events.push({ type: 'scheduler:registered', payload });
    });
    engine.on('scheduler:trigger', (payload) => {
      events.push({ type: 'scheduler:trigger', payload });
    });
    engine.on('scheduler:removed', (payload) => {
      events.push({ type: 'scheduler:removed', payload });
    });

    // Register → scheduler:registered
    engine.register('event-flow', async () => 'done', {
      schedule: '0 7 * * *',
    });

    const registeredEvents = events.filter((e) => e.type === 'scheduler:registered');
    expect(registeredEvents.length).toBe(1);
    expect(registeredEvents[0].payload.flowName).toBe('event-flow');
    expect(registeredEvents[0].payload.cronExpression).toBe('0 7 * * *');

    // Fire trigger → scheduler:trigger
    vi.advanceTimersByTime(60_000);
    await settle();
    vi.advanceTimersByTime(100);
    await settle();

    const triggerEvents = events.filter((e) => e.type === 'scheduler:trigger');
    expect(triggerEvents.length).toBe(1);
    expect(triggerEvents[0].payload.flowName).toBe('event-flow');

    // Unregister → scheduler:removed
    engine.unregister('event-flow');

    const removedEvents = events.filter((e) => e.type === 'scheduler:removed');
    expect(removedEvents.length).toBe(1);
    expect(removedEvents[0].payload.flowName).toBe('event-flow');

    const shutdownPromise = engine.shutdown();
    vi.advanceTimersByTime(1000);
    await settle();
    vi.advanceTimersByTime(100);
    await settle();
    await shutdownPromise;
  }, 10_000);
});
