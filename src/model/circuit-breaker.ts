// CircuitBreaker class — per-provider health tracking

import type { HealthState } from '../types.js';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  onHealthChange?: (providerName: string, from: HealthState, to: HealthState) => void;
}

export class CircuitBreaker {
  private readonly providerName: string;
  private state: HealthState = 'healthy';
  private failureCount = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onHealthChange?: (providerName: string, from: HealthState, to: HealthState) => void;

  constructor(providerName: string, options?: CircuitBreakerOptions) {
    this.providerName = providerName;
    this.failureThreshold = options?.failureThreshold ?? 5;
    this.cooldownMs = options?.cooldownMs ?? 30000;
    this.onHealthChange = options?.onHealthChange;
  }

  getState(): HealthState {
    return this.state;
  }

  /** Returns true for healthy and half_open (available for requests) */
  isAvailable(): boolean {
    return this.state === 'healthy' || this.state === 'half_open';
  }

  recordSuccess(): void {
    this.failureCount = 0;

    if (this.state === 'half_open') {
      this.transition('healthy');
    }
  }

  recordFailure(): void {
    if (this.state === 'half_open') {
      // Probe failed — back to unhealthy with cooldown reset
      this.transition('unhealthy');
      this.startCooldown();
      return;
    }

    this.failureCount++;

    if (this.state === 'healthy' && this.failureCount >= this.failureThreshold) {
      this.transition('unhealthy');
      this.startCooldown();
    }
  }

  /** Clear cooldown timers — call on engine shutdown */
  shutdown(): void {
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  private transition(to: HealthState): void {
    const from = this.state;
    this.state = to;

    if (to === 'healthy') {
      this.failureCount = 0;
      this.clearCooldown();
    }

    this.onHealthChange?.(this.providerName, from, to);
  }

  private startCooldown(): void {
    this.clearCooldown();
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.transition('half_open');
    }, this.cooldownMs);
  }

  private clearCooldown(): void {
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }
}
