// Unit tests for CircuitBreaker
// Per data-model.md CircuitBreaker entity and spec FR-009

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from '../../../src/model/circuit-breaker.js';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should start in healthy state', () => {
    const breaker = new CircuitBreaker('test-provider');
    expect(breaker.getState()).toBe('healthy');
    expect(breaker.isAvailable()).toBe(true);
    breaker.shutdown();
  });

  it('should count failures', () => {
    const breaker = new CircuitBreaker('test-provider', { failureThreshold: 5 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('healthy');
    expect(breaker.isAvailable()).toBe(true);
    breaker.shutdown();
  });

  it('should transition to unhealthy when failure threshold is breached', () => {
    const breaker = new CircuitBreaker('test-provider', { failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('healthy');

    breaker.recordFailure(); // hits threshold
    expect(breaker.getState()).toBe('unhealthy');
    expect(breaker.isAvailable()).toBe(false);
    breaker.shutdown();
  });

  it('should transition to half_open after cooldown expires', () => {
    const breaker = new CircuitBreaker('test-provider', {
      failureThreshold: 2,
      cooldownMs: 5000,
    });

    breaker.recordFailure();
    breaker.recordFailure(); // trips to unhealthy
    expect(breaker.getState()).toBe('unhealthy');

    vi.advanceTimersByTime(5000);
    expect(breaker.getState()).toBe('half_open');
    expect(breaker.isAvailable()).toBe(true);
    breaker.shutdown();
  });

  it('should transition from half_open to healthy on probe success', () => {
    const breaker = new CircuitBreaker('test-provider', {
      failureThreshold: 2,
      cooldownMs: 1000,
    });

    breaker.recordFailure();
    breaker.recordFailure();
    vi.advanceTimersByTime(1000); // → half_open
    expect(breaker.getState()).toBe('half_open');

    breaker.recordSuccess(); // probe succeeds
    expect(breaker.getState()).toBe('healthy');
    expect(breaker.isAvailable()).toBe(true);
    breaker.shutdown();
  });

  it('should transition from half_open to unhealthy on probe failure with cooldown reset', () => {
    const breaker = new CircuitBreaker('test-provider', {
      failureThreshold: 2,
      cooldownMs: 1000,
    });

    breaker.recordFailure();
    breaker.recordFailure();
    vi.advanceTimersByTime(1000); // → half_open
    expect(breaker.getState()).toBe('half_open');

    breaker.recordFailure(); // probe fails → unhealthy
    expect(breaker.getState()).toBe('unhealthy');

    // Cooldown should reset — not half_open yet
    vi.advanceTimersByTime(500);
    expect(breaker.getState()).toBe('unhealthy');

    // After full new cooldown → half_open
    vi.advanceTimersByTime(500);
    expect(breaker.getState()).toBe('half_open');
    breaker.shutdown();
  });

  it('should reset failure count on success', () => {
    const breaker = new CircuitBreaker('test-provider', { failureThreshold: 3 });

    breaker.recordFailure();
    breaker.recordFailure();
    // 2 failures, 1 more would trip it
    breaker.recordSuccess(); // resets counter

    breaker.recordFailure();
    breaker.recordFailure();
    // Only 2 failures again — should still be healthy
    expect(breaker.getState()).toBe('healthy');
    breaker.shutdown();
  });

  it('should invoke onHealthChange callback on state transitions', () => {
    const onChange = vi.fn();
    const breaker = new CircuitBreaker('test-provider', {
      failureThreshold: 2,
      cooldownMs: 1000,
      onHealthChange: onChange,
    });

    breaker.recordFailure();
    breaker.recordFailure(); // healthy → unhealthy
    expect(onChange).toHaveBeenCalledWith('test-provider', 'healthy', 'unhealthy');

    vi.advanceTimersByTime(1000); // unhealthy → half_open
    expect(onChange).toHaveBeenCalledWith('test-provider', 'unhealthy', 'half_open');

    breaker.recordSuccess(); // half_open → healthy
    expect(onChange).toHaveBeenCalledWith('test-provider', 'half_open', 'healthy');

    expect(onChange).toHaveBeenCalledTimes(3);
    breaker.shutdown();
  });

  it('should clean up timers on shutdown', () => {
    const breaker = new CircuitBreaker('test-provider', {
      failureThreshold: 1,
      cooldownMs: 10000,
    });

    breaker.recordFailure(); // trips — starts cooldown timer
    expect(breaker.getState()).toBe('unhealthy');

    breaker.shutdown();

    // Advancing time should NOT trigger half_open since timer was cleaned
    vi.advanceTimersByTime(10000);
    expect(breaker.getState()).toBe('unhealthy');
  });

  it('should use default threshold and cooldown', () => {
    const breaker = new CircuitBreaker('test-provider');

    // Default threshold is 5
    for (let i = 0; i < 4; i++) {
      breaker.recordFailure();
    }
    expect(breaker.getState()).toBe('healthy');

    breaker.recordFailure(); // 5th failure
    expect(breaker.getState()).toBe('unhealthy');

    // Default cooldown is 30000ms
    vi.advanceTimersByTime(29999);
    expect(breaker.getState()).toBe('unhealthy');
    vi.advanceTimersByTime(1);
    expect(breaker.getState()).toBe('half_open');
    breaker.shutdown();
  });
});
