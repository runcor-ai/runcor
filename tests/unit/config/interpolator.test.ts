// Unit tests for env var interpolator
// Covers ${VAR} resolution, ${VAR:-default} fallback, error collection,
// nested traversal, array handling, and secret redaction.

import { interpolateEnvVars } from '../../../src/config/interpolator.js';
import { EngineError } from '../../../src/errors.js';

describe('interpolateEnvVars', () => {
  // Save and restore process.env between tests to avoid cross-contamination
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  // ── 1. Basic ${VAR} resolution ──

  describe('basic ${VAR} resolution', () => {
    it('resolves a single env var reference', () => {
      process.env.MY_VAR = 'hello';
      const result = interpolateEnvVars({ my_var: '${MY_VAR}' });
      expect(result).toEqual({ my_var: 'hello' });
    });

    it('resolves env var embedded in a larger string', () => {
      process.env.HOST = 'localhost';
      const result = interpolateEnvVars({ url: 'http://${HOST}:3000' });
      expect(result).toEqual({ url: 'http://localhost:3000' });
    });
  });

  // ── 2. ${VAR:-default} fallback when VAR is not set ──

  describe('${VAR:-default} fallback', () => {
    it('uses the default value when the env var is not set', () => {
      delete process.env.MISSING_VAR;
      const result = interpolateEnvVars({ val: '${MISSING_VAR:-fallback}' });
      expect(result).toEqual({ val: 'fallback' });
    });

    it('uses the default value when the env var is undefined', () => {
      delete process.env.UNDEF_VAR;
      const result = interpolateEnvVars({ port: '${UNDEF_VAR:-8080}' });
      expect(result).toEqual({ port: '8080' });
    });
  });

  // ── 3. ${VAR:-default} when VAR IS set ──

  describe('${VAR:-default} when VAR is set', () => {
    it('uses the env var value instead of the default', () => {
      process.env.DB_HOST = 'prod-db.example.com';
      const result = interpolateEnvVars({ host: '${DB_HOST:-localhost}' });
      expect(result).toEqual({ host: 'prod-db.example.com' });
    });
  });

  // ── 4. Missing required var (no default) — error collection ──

  describe('missing required var (no default)', () => {
    it('throws EngineError with code CONFIG_INVALID', () => {
      delete process.env.REQUIRED_VAR;
      expect(() => interpolateEnvVars({ key: '${REQUIRED_VAR}' })).toThrow(EngineError);
    });

    it('reports missing var without leaking var name', () => {
      delete process.env.REQUIRED_VAR;
      try {
        interpolateEnvVars({ key: '${REQUIRED_VAR}' });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('CONFIG_INVALID');
        // Field path shown, var name not leaked
        expect((err as EngineError).message).toContain('key: required environment variable is not set');
      }
    });

    it('includes the field path in the error message', () => {
      delete process.env.API_SECRET;
      try {
        interpolateEnvVars({ provider: { apiKey: '${API_SECRET}' } });
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as EngineError).message).toContain('provider.apiKey');
      }
    });
  });

  // ── 5. Batch error collection — multiple missing vars ──

  describe('batch error collection', () => {
    it('collects all missing vars in a single error', () => {
      delete process.env.VAR_A;
      delete process.env.VAR_B;
      delete process.env.VAR_C;
      try {
        interpolateEnvVars({
          a: '${VAR_A}',
          b: '${VAR_B}',
          c: '${VAR_C}',
        });
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as EngineError).message;
        // Error shows field paths, not var names (security: don't leak var names)
        expect(msg).toContain('a: required environment variable is not set');
        expect(msg).toContain('b: required environment variable is not set');
        expect(msg).toContain('c: required environment variable is not set');
      }
    });

    it('reports all errors even when mixed with valid vars', () => {
      process.env.GOOD_VAR = 'ok';
      delete process.env.BAD_ONE;
      delete process.env.BAD_TWO;
      try {
        interpolateEnvVars({
          good: '${GOOD_VAR}',
          bad1: '${BAD_ONE}',
          bad2: '${BAD_TWO}',
        });
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as EngineError).message;
        // Error shows field paths, not var names
        expect(msg).toContain('bad1: required environment variable is not set');
        expect(msg).toContain('bad2: required environment variable is not set');
        // Should NOT mention the successfully-resolved var's field
        expect(msg).not.toContain('good:');
      }
    });
  });

  // ── 6. Nested object traversal ──

  describe('nested object traversal', () => {
    it('resolves vars in deeply nested objects', () => {
      process.env.DEEP_VAL = 'found-it';
      const result = interpolateEnvVars({
        level1: {
          level2: {
            level3: '${DEEP_VAL}',
          },
        },
      });
      expect(result).toEqual({
        level1: { level2: { level3: 'found-it' } },
      });
    });

    it('resolves vars at multiple nesting levels', () => {
      process.env.A_VAL = 'aaa';
      process.env.B_VAL = 'bbb';
      const result = interpolateEnvVars({
        top: '${A_VAL}',
        nested: { inner: '${B_VAL}' },
      });
      expect(result).toEqual({
        top: 'aaa',
        nested: { inner: 'bbb' },
      });
    });
  });

  // ── 7. Array traversal ──

  describe('array traversal', () => {
    it('resolves vars in arrays of strings', () => {
      process.env.ITEM_A = 'alpha';
      process.env.ITEM_B = 'beta';
      const result = interpolateEnvVars({
        items: ['${ITEM_A}', '${ITEM_B}'],
      });
      expect(result).toEqual({ items: ['alpha', 'beta'] });
    });

    it('resolves vars in arrays of objects', () => {
      process.env.KEY_ONE = 'k1';
      process.env.KEY_TWO = 'k2';
      const result = interpolateEnvVars({
        providers: [
          { apiKey: '${KEY_ONE}' },
          { apiKey: '${KEY_TWO}' },
        ],
      });
      expect(result).toEqual({
        providers: [
          { apiKey: 'k1' },
          { apiKey: 'k2' },
        ],
      });
    });
  });

  // ── 8. Non-string passthrough ──

  describe('non-string passthrough', () => {
    it('passes through numbers unchanged', () => {
      const result = interpolateEnvVars({ port: 3000 });
      expect(result).toEqual({ port: 3000 });
    });

    it('passes through booleans unchanged', () => {
      const result = interpolateEnvVars({ enabled: true, debug: false });
      expect(result).toEqual({ enabled: true, debug: false });
    });

    it('passes through null unchanged', () => {
      const result = interpolateEnvVars({ value: null });
      expect(result).toEqual({ value: null });
    });

    it('passes through arrays of numbers unchanged', () => {
      const result = interpolateEnvVars({ counts: [1, 2, 3] });
      expect(result).toEqual({ counts: [1, 2, 3] });
    });

    it('returns non-object primitives at root as-is', () => {
      expect(interpolateEnvVars(42)).toBe(42);
      expect(interpolateEnvVars('plain string')).toBe('plain string');
      expect(interpolateEnvVars(null)).toBe(null);
      expect(interpolateEnvVars(undefined)).toBe(undefined);
      expect(interpolateEnvVars(true)).toBe(true);
    });
  });

  // ── 9. Multiple vars in the same string ──

  describe('multiple vars in same string', () => {
    it('resolves multiple env var references in one string', () => {
      process.env.TOKEN = 'abc123';
      const result = interpolateEnvVars({ auth: 'Bearer ${TOKEN}' });
      expect(result).toEqual({ auth: 'Bearer abc123' });
    });

    it('resolves two adjacent vars', () => {
      process.env.FIRST = 'hello';
      process.env.SECOND = 'world';
      const result = interpolateEnvVars({ msg: '${FIRST} ${SECOND}' });
      expect(result).toEqual({ msg: 'hello world' });
    });

    it('collects errors for all missing vars in a single string', () => {
      delete process.env.MISS_X;
      delete process.env.MISS_Y;
      try {
        interpolateEnvVars({ combo: '${MISS_X}-${MISS_Y}' });
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as EngineError).message;
        // Both missing vars in the same field produce two error lines for that path
        expect(msg).toContain('combo: required environment variable is not set');
        expect(msg).toContain('2 undefined environment variables');
      }
    });
  });

  // ── 10. Empty default ──

  describe('empty default', () => {
    it('resolves ${VAR:-} to empty string when VAR is not set', () => {
      delete process.env.OPT_VAR;
      const result = interpolateEnvVars({ optional: '${OPT_VAR:-}' });
      expect(result).toEqual({ optional: '' });
    });

    it('resolves ${VAR:-} to the env value when VAR is set', () => {
      process.env.OPT_VAR = 'present';
      const result = interpolateEnvVars({ optional: '${OPT_VAR:-}' });
      expect(result).toEqual({ optional: 'present' });
    });
  });

  // ── 11. Field path tracking ──

  describe('field path tracking', () => {
    it('tracks array index paths like providers[0].apiKey', () => {
      delete process.env.PROVIDER_KEY;
      try {
        interpolateEnvVars({
          providers: [{ apiKey: '${PROVIDER_KEY}' }],
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as EngineError).message).toContain('providers[0].apiKey');
      }
    });

    it('tracks deeply nested array and object paths', () => {
      delete process.env.NESTED_SECRET;
      try {
        interpolateEnvVars({
          config: {
            items: [
              { sub: { key: '${NESTED_SECRET}' } },
            ],
          },
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as EngineError).message).toContain('config.items[0].sub.key');
      }
    });

    it('tracks multiple distinct paths in batch errors', () => {
      delete process.env.PATH_A;
      delete process.env.PATH_B;
      try {
        interpolateEnvVars({
          top: '${PATH_A}',
          nested: { deep: '${PATH_B}' },
        });
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as EngineError).message;
        expect(msg).toContain('top');
        expect(msg).toContain('nested.deep');
      }
    });
  });

  // ── 12. Secret redaction ──

  describe('secret redaction', () => {
    it('error messages contain field PATHS but never var NAMES or resolved VALUES', () => {
      process.env.SAFE_KEY = 'super-secret-value-12345';
      delete process.env.MISSING_KEY;
      try {
        interpolateEnvVars({
          good: '${SAFE_KEY}',
          bad: '${MISSING_KEY}',
        });
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as EngineError).message;
        // Should mention the field path
        expect(msg).toContain('bad: required environment variable is not set');
        // Should NOT contain any var names or resolved secret values
        expect(msg).not.toContain('MISSING_KEY');
        expect(msg).not.toContain('SAFE_KEY');
        expect(msg).not.toContain('super-secret-value-12345');
      }
    });

    it('never leaks env var values in error messages even for valid vars', () => {
      process.env.SECRET_TOKEN = 'sk-live-xxxxxxxxxxxx';
      delete process.env.OTHER_VAR;
      try {
        interpolateEnvVars({
          token: '${SECRET_TOKEN}',
          missing: '${OTHER_VAR}',
        });
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as EngineError).message;
        expect(msg).not.toContain('sk-live-xxxxxxxxxxxx');
      }
    });
  });
});
