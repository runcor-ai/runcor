// Unit tests for config server: section
// Tests ServerEntry schema, validation, and mapping

import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../../src/config/validator.js';
import { mapToEngineConfig } from '../../../src/config/mapper.js';
import type { RuncorConfigFile } from '../../../src/config/schema.js';

describe('Config server: section ', () => {
  describe('validation', () => {
    it('should accept valid server config with all fields', () => {
      const errors = validateConfig({
        server: {
          enabled: true,
          name: 'my-engine',
          version: '1.0.0',
        },
      });
      expect(errors).toEqual([]);
    });

    it('should accept partial server config', () => {
      const errors = validateConfig({
        server: { enabled: true },
      });
      expect(errors).toEqual([]);
    });

    it('should accept empty server section', () => {
      const errors = validateConfig({
        server: {},
      });
      expect(errors).toEqual([]);
    });

    it('should reject enabled with non-boolean type', () => {
      const errors = validateConfig({
        server: { enabled: 'yes' },
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].path).toBe('server.enabled');
    });

    it('should reject name with non-string type', () => {
      const errors = validateConfig({
        server: { name: 123 },
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].path).toBe('server.name');
    });

    it('should reject version with non-string type', () => {
      const errors = validateConfig({
        server: { version: true },
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].path).toBe('server.version');
    });
  });

  describe('mapping', () => {
    it('should produce MCPServerConfig from ServerEntry', () => {
      const yaml: RuncorConfigFile = {
        server: {
          enabled: true,
          name: 'my-engine',
          version: '2.0.0',
        },
      };
      const result = mapToEngineConfig(yaml, {}, {});
      expect(result.server).toEqual({
        enabled: true,
        name: 'my-engine',
        version: '2.0.0',
      });
    });

    it('should return undefined server config when server section missing', () => {
      const yaml: RuncorConfigFile = {};
      const result = mapToEngineConfig(yaml, {}, {});
      expect(result.server).toBeUndefined();
    });

    it('should handle partial server config using available fields', () => {
      const yaml: RuncorConfigFile = {
        server: { enabled: true },
      };
      const result = mapToEngineConfig(yaml, {}, {});
      expect(result.server).toEqual({ enabled: true });
    });
  });
});
