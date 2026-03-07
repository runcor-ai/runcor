// Unit tests for GET /v1/discernment

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../../src/engine.js';
import { MockProvider } from '../../../src/model/mock.js';

describe('Discernment Route Logic', () => {
  let engine: Runcor;

  afterEach(async () => {
    if (engine) await engine.shutdown();
  });

  it('returns enabled=false when discernment disabled', async () => {
    engine = await createEngine({
      model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
    });
    const caps = engine.getCapabilities();
    expect(caps.discernment).toBe(false);
    expect(engine.listObjectives()).toEqual([]);
    expect(engine.listDiscernmentReports()).toEqual([]);
    expect(engine.getRecommendations()).toEqual([]);
  });

  it('returns objectives when discernment enabled', async () => {
    engine = await createEngine({
      model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
      discernment: {
        enabled: true,
        autonomy: 'observe',
        schedule: 'daily',
        objectives: [
          { name: 'retention', description: 'Reduce churn' },
          { name: 'efficiency', description: 'Cut costs' },
        ],
      },
    });

    const caps = engine.getCapabilities();
    expect(caps.discernment).toBe(true);

    const objectives = engine.listObjectives();
    expect(objectives).toHaveLength(2);
    expect(objectives[0].name).toBe('retention');
  });

  it('returns empty reports when no cycle has run', async () => {
    engine = await createEngine({
      model: { providers: [{ provider: new MockProvider(), priority: 1 }] },
      discernment: {
        enabled: true,
        autonomy: 'observe',
        schedule: 'daily',
      },
    });
    const reports = engine.listDiscernmentReports();
    expect(reports).toHaveLength(0);
  });
});
