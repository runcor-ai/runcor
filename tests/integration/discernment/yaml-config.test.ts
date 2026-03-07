// Integration tests for discernment YAML config support

import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../../src/config/validator.js';
import { mapToEngineConfig } from '../../../src/config/mapper.js';
import type { RuncorConfigFile } from '../../../src/config/schema.js';

describe('Discernment YAML Config', () => {
  describe('validation', () => {
    it('accepts valid discernment section', () => {
      const errors = validateConfig({
        discernment: {
          enabled: true,
          autonomy: 'recommend',
          schedule: 'daily',
        },
      });
      expect(errors).toHaveLength(0);
    });

    it('accepts all autonomy levels', () => {
      for (const autonomy of ['observe', 'recommend', 'advise', 'enforce']) {
        const errors = validateConfig({
          discernment: { enabled: true, autonomy, schedule: 'daily' },
        });
        expect(errors).toHaveLength(0);
      }
    });

    it('rejects invalid autonomy level', () => {
      const errors = validateConfig({
        discernment: { enabled: true, autonomy: 'invalid', schedule: 'daily' },
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].path).toBe('discernment.autonomy');
    });

    it('accepts optional fields', () => {
      const errors = validateConfig({
        discernment: {
          enabled: true,
          autonomy: 'recommend',
          schedule: 'hourly',
          provider: 'anthropic',
          lookbackPeriod: 604800,
          gracePeriod: 86400,
          prompt: 'Custom prompt here.',
          thresholds: {
            idleFlowDays: 14,
            disproportionateCostPercent: 0.5,
            qualityDeclinePercent: 0.1,
            agentHardStopPercent: 0.3,
          },
        },
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects non-number threshold values', () => {
      const errors = validateConfig({
        discernment: {
          enabled: true,
          thresholds: { idleFlowDays: 'seven' },
        },
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].path).toBe('discernment.thresholds.idleFlowDays');
    });

    it('rejects non-boolean enabled', () => {
      const errors = validateConfig({
        discernment: { enabled: 'yes' },
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].path).toBe('discernment.enabled');
    });
  });

  describe('objectives validation', () => {
    it('accepts valid objectives', () => {
      const errors = validateConfig({
        objectives: [
          { name: 'retention', description: 'Reduce churn' },
          { name: 'efficiency', description: 'Cut costs' },
        ],
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects objective without name', () => {
      const errors = validateConfig({
        objectives: [
          { description: 'Missing name' },
        ],
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].path).toBe('objectives[0].name');
    });

    it('rejects objective without description', () => {
      const errors = validateConfig({
        objectives: [
          { name: 'test' },
        ],
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].path).toBe('objectives[0].description');
    });
  });

  describe('mapping', () => {
    it('maps discernment section to DiscernmentConfig', () => {
      const yaml: RuncorConfigFile = {
        discernment: {
          enabled: true,
          autonomy: 'advise',
          schedule: 'hourly',
          provider: 'anthropic',
          lookbackPeriod: 3600,
          gracePeriod: 600,
        },
      };

      const config = mapToEngineConfig(yaml, {}, {});
      expect(config.discernment).toBeDefined();
      expect(config.discernment!.enabled).toBe(true);
      expect(config.discernment!.autonomy).toBe('advise');
      expect(config.discernment!.schedule).toBe('hourly');
      expect(config.discernment!.provider).toBe('anthropic');
      expect(config.discernment!.lookbackPeriod).toBe(3600);
      expect(config.discernment!.gracePeriod).toBe(600);
    });

    it('maps objectives from YAML to DiscernmentConfig.objectives', () => {
      const yaml: RuncorConfigFile = {
        discernment: {
          enabled: true,
          autonomy: 'recommend',
          schedule: 'daily',
        },
        objectives: [
          { name: 'retention', description: 'Reduce churn' },
          { name: 'efficiency', description: 'Cut costs' },
        ],
      };

      const config = mapToEngineConfig(yaml, {}, {});
      expect(config.discernment).toBeDefined();
      expect(config.discernment!.objectives).toHaveLength(2);
      expect(config.discernment!.objectives![0]).toEqual({ name: 'retention', description: 'Reduce churn' });
      expect(config.discernment!.objectives![1]).toEqual({ name: 'efficiency', description: 'Cut costs' });
    });

    it('maps thresholds correctly', () => {
      const yaml: RuncorConfigFile = {
        discernment: {
          enabled: true,
          autonomy: 'observe',
          schedule: 'daily',
          thresholds: {
            idleFlowDays: 30,
            disproportionateCostPercent: 0.5,
          },
        },
      };

      const config = mapToEngineConfig(yaml, {}, {});
      expect(config.discernment!.thresholds).toBeDefined();
      expect(config.discernment!.thresholds!.idleFlowDays).toBe(30);
      expect(config.discernment!.thresholds!.disproportionateCostPercent).toBe(0.5);
    });

    it('defaults enabled=false and autonomy=recommend when not set', () => {
      const yaml: RuncorConfigFile = {
        discernment: {},
      };

      const config = mapToEngineConfig(yaml, {}, {});
      expect(config.discernment).toBeDefined();
      expect(config.discernment!.enabled).toBe(false);
      expect(config.discernment!.autonomy).toBe('recommend');
      expect(config.discernment!.schedule).toBe('daily');
    });

    it('maps custom prompt', () => {
      const yaml: RuncorConfigFile = {
        discernment: {
          enabled: true,
          autonomy: 'recommend',
          schedule: 'daily',
          prompt: 'You are a senior SRE reviewing AI workloads.',
        },
      };

      const config = mapToEngineConfig(yaml, {}, {});
      expect(config.discernment!.prompt).toBe('You are a senior SRE reviewing AI workloads.');
    });

    it('no discernment config when section absent', () => {
      const yaml: RuncorConfigFile = {};
      const config = mapToEngineConfig(yaml, {}, {});
      expect(config.discernment).toBeUndefined();
    });
  });
});
