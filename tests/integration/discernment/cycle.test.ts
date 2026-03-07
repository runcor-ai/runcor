// Integration tests for scheduled discernment cycles

import { describe, it, expect } from 'vitest';
import { DiscernmentEngine } from '../../../src/discernment/engine.js';
import type { DiscernmentConfig } from '../../../src/discernment/types.js';

describe('DiscernmentEngine — Schedule Configuration', () => {
  it('resolves daily shorthand to cron expression', () => {
    const engine = new DiscernmentEngine({
      enabled: true,
      autonomy: 'recommend',
      schedule: 'daily',
    });

    expect(engine.resolvedSchedule).toBe('0 0 * * *');
  });

  it('resolves hourly shorthand to cron expression', () => {
    const engine = new DiscernmentEngine({
      enabled: true,
      autonomy: 'recommend',
      schedule: 'hourly',
    });

    expect(engine.resolvedSchedule).toBe('0 * * * *');
  });

  it('resolves weekly shorthand to cron expression', () => {
    const engine = new DiscernmentEngine({
      enabled: true,
      autonomy: 'recommend',
      schedule: 'weekly',
    });

    expect(engine.resolvedSchedule).toBe('0 0 * * 0');
  });

  it('passes through custom cron expression', () => {
    const engine = new DiscernmentEngine({
      enabled: true,
      autonomy: 'recommend',
      schedule: '30 6 * * 1-5',
    });

    expect(engine.resolvedSchedule).toBe('30 6 * * 1-5');
  });
});
