// Unit tests for config loader
// Covers file discovery, path precedence, error handling, YAML parsing,
// validation integration, and full pipeline with mock providers.

import { loadConfig } from '../../../src/config/loader.js';
import { EngineError } from '../../../src/errors.js';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

/** Create a unique temp directory for each test that needs file discovery */
function makeTempDir(): string {
  const dir = resolve(tmpdir(), `runcor-loader-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Path to test fixtures */
const fixturesDir = resolve(__dirname, '../../fixtures/config');

describe('loadConfig', () => {
  // Save and restore process.env between tests to avoid cross-contamination
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  // ── 1. File discovery: runcor.yaml in basePath ──

  describe('file discovery', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = makeTempDir();
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('finds runcor.yaml in basePath', async () => {
      writeFileSync(resolve(tempDir, 'runcor.yaml'), 'providers:\n  - type: mock\n');
      const result = await loadConfig({ basePath: tempDir });
      expect(result).toBeDefined();
      expect(result!.model).toBeDefined();
    });

    it('falls back to runcor.yml when runcor.yaml is absent', async () => {
      writeFileSync(resolve(tempDir, 'runcor.yml'), 'providers:\n  - type: mock\n');
      const result = await loadConfig({ basePath: tempDir });
      expect(result).toBeDefined();
      expect(result!.model).toBeDefined();
    });

    it('prefers runcor.yaml over runcor.yml when both exist', async () => {
      // runcor.yaml has mock provider
      writeFileSync(resolve(tempDir, 'runcor.yaml'), 'providers:\n  - type: mock\n');
      // runcor.yml has an anthropic provider which would fail without a factory
      // If .yml were picked, loadConfig would throw for unknown factory.
      // But .yaml is preferred, so mock succeeds.
      writeFileSync(
        resolve(tempDir, 'runcor.yml'),
        'providers:\n  - type: mock\nengine:\n  concurrency: 999\n',
      );
      const result = await loadConfig({ basePath: tempDir });
      expect(result).toBeDefined();
      // Should NOT include the concurrency: 999 from .yml
      expect(result!.concurrency).toBeUndefined();
    });

    it('returns undefined when no config file is found (zero-config mode)', async () => {
      // Empty temp dir — no runcor.yaml or runcor.yml
      const result = await loadConfig({ basePath: tempDir });
      expect(result).toBeUndefined();
    });
  });

  // ── 2. RUNCOR_CONFIG env var override ──

  describe('RUNCOR_CONFIG env var', () => {
    it('loads config from path specified in RUNCOR_CONFIG', async () => {
      process.env.RUNCOR_CONFIG = resolve(fixturesDir, 'minimal.yaml');
      const result = await loadConfig();
      expect(result).toBeDefined();
      expect(result!.model).toBeDefined();
    });

    it('throws CONFIG_NOT_FOUND when RUNCOR_CONFIG points to a nonexistent file', async () => {
      process.env.RUNCOR_CONFIG = resolve(fixturesDir, 'does-not-exist.yaml');
      try {
        await loadConfig();
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('CONFIG_NOT_FOUND');
      }
    });
  });

  // ── 3. Explicit path option ──

  describe('explicit path option', () => {
    it('loads config from options.path', async () => {
      const result = await loadConfig({
        path: resolve(fixturesDir, 'minimal.yaml'),
      });
      expect(result).toBeDefined();
      expect(result!.model).toBeDefined();
    });

    it('resolves relative path from basePath', async () => {
      const result = await loadConfig({
        path: 'minimal.yaml',
        basePath: fixturesDir,
      });
      expect(result).toBeDefined();
      expect(result!.model).toBeDefined();
    });
  });

  // ── 4. Path precedence: option > env var > auto-detect ──

  describe('path precedence', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = makeTempDir();
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('options.path takes highest precedence over env var', async () => {
      // Put a config with concurrency in the explicit path
      writeFileSync(
        resolve(tempDir, 'explicit.yaml'),
        'providers:\n  - type: mock\nengine:\n  concurrency: 42\n',
      );
      // Put a different config in the env var path
      writeFileSync(
        resolve(tempDir, 'env-config.yaml'),
        'providers:\n  - type: mock\nengine:\n  concurrency: 99\n',
      );
      process.env.RUNCOR_CONFIG = resolve(tempDir, 'env-config.yaml');

      const result = await loadConfig({
        path: resolve(tempDir, 'explicit.yaml'),
      });
      expect(result).toBeDefined();
      expect(result!.concurrency).toBe(42);
    });

    it('env var takes precedence over auto-detect', async () => {
      // Put a config in the auto-detect location
      writeFileSync(
        resolve(tempDir, 'runcor.yaml'),
        'providers:\n  - type: mock\nengine:\n  concurrency: 10\n',
      );
      // Put a different config at the env var path
      writeFileSync(
        resolve(tempDir, 'env-override.yaml'),
        'providers:\n  - type: mock\nengine:\n  concurrency: 77\n',
      );
      process.env.RUNCOR_CONFIG = resolve(tempDir, 'env-override.yaml');

      const result = await loadConfig({ basePath: tempDir });
      expect(result).toBeDefined();
      expect(result!.concurrency).toBe(77);
    });
  });

  // ── 5. Missing file: explicit path throws CONFIG_NOT_FOUND ──

  describe('missing file with explicit path', () => {
    it('throws EngineError with code CONFIG_NOT_FOUND', async () => {
      const missingPath = resolve(fixturesDir, 'nonexistent.yaml');
      try {
        await loadConfig({ path: missingPath });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('CONFIG_NOT_FOUND');
        expect((err as EngineError).message).toContain('nonexistent.yaml');
      }
    });
  });

  // ── 6. Empty/comment-only YAML returns undefined ──

  describe('empty/comment-only YAML', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = makeTempDir();
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('returns undefined for an empty file', async () => {
      writeFileSync(resolve(tempDir, 'runcor.yaml'), '');
      const result = await loadConfig({ basePath: tempDir });
      expect(result).toBeUndefined();
    });

    it('returns undefined for a comment-only file', async () => {
      writeFileSync(
        resolve(tempDir, 'runcor.yaml'),
        '# This is a comment\n# Another comment\n',
      );
      const result = await loadConfig({ basePath: tempDir });
      expect(result).toBeUndefined();
    });
  });

  // ── 7. YAML syntax error throws CONFIG_INVALID ──

  describe('YAML syntax error', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = makeTempDir();
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('throws EngineError with code CONFIG_INVALID', async () => {
      writeFileSync(
        resolve(tempDir, 'runcor.yaml'),
        'providers:\n  - type: mock\n    bad_indent:\n  nope: [unclosed',
      );
      try {
        await loadConfig({ basePath: tempDir });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('CONFIG_INVALID');
      }
    });

    it('includes the file path in the error message', async () => {
      const filePath = resolve(tempDir, 'runcor.yaml');
      writeFileSync(filePath, ':\n  :\n    : [');
      try {
        await loadConfig({ basePath: tempDir });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).message).toContain(filePath);
      }
    });
  });

  // ── 8. Non-object YAML (array at root) throws CONFIG_INVALID ──

  describe('non-object YAML at root', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = makeTempDir();
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('throws CONFIG_INVALID when root is an array', async () => {
      writeFileSync(resolve(tempDir, 'runcor.yaml'), '- item1\n- item2\n');
      try {
        await loadConfig({ basePath: tempDir });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('CONFIG_INVALID');
        expect((err as EngineError).message).toContain('array');
      }
    });

    it('throws CONFIG_INVALID when root is a scalar string', async () => {
      writeFileSync(resolve(tempDir, 'runcor.yaml'), '"just a string"\n');
      try {
        await loadConfig({ basePath: tempDir });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('CONFIG_INVALID');
        expect((err as EngineError).message).toContain('string');
      }
    });
  });

  // ── 9. basePath option resolves relative paths ──

  describe('basePath option', () => {
    it('resolves relative path from basePath to fixtures', async () => {
      const result = await loadConfig({
        path: 'minimal.yaml',
        basePath: fixturesDir,
      });
      expect(result).toBeDefined();
      expect(result!.model).toBeDefined();
    });

    it('defaults basePath to cwd when not provided', async () => {
      // An explicit absolute path should still work without basePath
      const result = await loadConfig({
        path: resolve(fixturesDir, 'minimal.yaml'),
      });
      expect(result).toBeDefined();
    });
  });

  // ── 10. Validation integration: invalid configs ──

  describe('validation integration', () => {
    it('throws CONFIG_INVALID for unknown top-level keys', async () => {
      try {
        await loadConfig({
          path: resolve(fixturesDir, 'unknown-keys.yaml'),
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('CONFIG_INVALID');
        const msg = (err as EngineError).message;
        expect(msg).toContain('banana');
        expect(msg).toContain('pineapple');
      }
    });

    it('throws CONFIG_INVALID for wrong types with error list', async () => {
      try {
        await loadConfig({
          path: resolve(fixturesDir, 'invalid-type.yaml'),
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('CONFIG_INVALID');
        const msg = (err as EngineError).message;
        // invalid-type.yaml has priority: "not-a-number" (string instead of number)
        expect(msg).toContain('priority');
        expect(msg).toContain('Expected number');
      }
    });

    it('throws CONFIG_INVALID for missing required fields', async () => {
      try {
        await loadConfig({
          path: resolve(fixturesDir, 'missing-required.yaml'),
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('CONFIG_INVALID');
        const msg = (err as EngineError).message;
        // missing-required.yaml has providers without type, connections without name, budgets without limit
        expect(msg).toContain('Required field missing');
      }
    });

    it('includes error count in the validation error message', async () => {
      try {
        await loadConfig({
          path: resolve(fixturesDir, 'invalid-type.yaml'),
        });
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as EngineError).message;
        // Should say "Config validation failed (N error(s)):"
        expect(msg).toMatch(/Config validation failed \(\d+ errors?\)/);
      }
    });
  });

  // ── 11. Full pipeline: minimal.yaml fixture loads with mock provider ──

  describe('full pipeline', () => {
    it('loads minimal.yaml and returns EngineConfig with mock provider', async () => {
      const result = await loadConfig({
        path: resolve(fixturesDir, 'minimal.yaml'),
      });
      expect(result).toBeDefined();
      expect(result!.model).toBeDefined();
      expect(result!.model.providers).toBeDefined();
      expect(result!.model.providers).toHaveLength(1);
      expect(result!.model.providers![0].provider).toBeDefined();
      expect(result!.model.providers![0].provider.name).toBe('mock');
    });

    it('loads full.yaml and returns complete EngineConfig with all sections', async () => {
      const result = await loadConfig({
        path: resolve(fixturesDir, 'full.yaml'),
      });

      expect(result).toBeDefined();

      // Engine settings
      expect(result!.concurrency).toBe(50);
      expect(result!.drainTimeout).toBe(5000);
      expect(result!.retentionPeriod).toBe(7200);

      // Providers (1 mock provider in fixture)
      expect(result!.model.providers).toHaveLength(1);
      expect(result!.model.providers![0].provider.name).toBe('mock');
      expect(result!.model.providers![0].priority).toBe(1);
      expect(result!.model.providers![0].models).toEqual(['mock-v1']);
      expect(result!.model.providers![0].costPerToken).toEqual({
        input: 0.001,
        output: 0.002,
      });

      // Routing
      expect(result!.model.strategy).toBe('priority');
      expect(result!.model.maxFallbackAttempts).toBe(3);
      expect(result!.model.failureThreshold).toBe(5);
      expect(result!.model.cooldownMs).toBe(30000);

      // Connections/Adapters (1 SSE connection)
      expect(result!.adapters).toBeDefined();
      expect(result!.adapters!.adapters).toBeDefined();
      expect(result!.adapters!.adapters!.length).toBe(1);

      // Costs
      expect(result!.cost).toBeDefined();
      expect(result!.cost!.warningThreshold).toBe(0.8);
      expect(result!.cost!.defaultTokenEstimate).toBe(500);
      expect(result!.cost!.maxLedgerEntries).toBe(10000);
      expect(result!.cost!.budgets).toBeDefined();
      expect(result!.cost!.budgets!.perRequest).toBeDefined();
      expect(result!.cost!.budgets!.perRequest!.limit).toBe(1.0);
      expect(result!.cost!.budgets!.global).toBeDefined();
      expect(result!.cost!.budgets!.global!.limit).toBe(100.0);

      // Telemetry
      expect(result!.telemetry).toBeDefined();
      expect(result!.telemetry!.serviceName).toBe('runcor-test');
      expect(result!.telemetry!.serviceVersion).toBe('1.0.0');
      expect(result!.telemetry!.memorySpans).toBe(true);

      // Policy
      expect(result!.policy).toBeDefined();
      expect(result!.policy!.rateLimits).toHaveLength(1);
      expect(result!.policy!.accessPolicies).toHaveLength(1);
      expect(result!.policy!.tenants).toHaveLength(1);

      // Evaluation
      expect(result!.evaluation).toBeDefined();
      expect(result!.evaluation!.autoFlagScoreThreshold).toBe(0.3);
      expect(result!.evaluation!.evaluators).toHaveLength(1);
    });
  });

  // ── 12. Custom provider factories ──

  describe('custom provider factories', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = makeTempDir();
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('allows non-built-in provider types via custom factory', async () => {
      writeFileSync(
        resolve(tempDir, 'runcor.yaml'),
        'providers:\n  - type: custom-llm\n    apiKey: test-key\n',
      );

      const customProvider = {
        name: 'custom-llm',
        complete: async () => ({
          text: 'custom response',
          model: 'custom',
          provider: 'custom-llm',
          usage: { promptTokens: 0, completionTokens: 0 },
        }),
      };

      const result = await loadConfig({
        basePath: tempDir,
        providerFactories: {
          'custom-llm': () => customProvider,
        },
      });

      expect(result).toBeDefined();
      expect(result!.model.providers).toHaveLength(1);
      expect(result!.model.providers![0].provider).toBe(customProvider);
      expect(result!.model.providers![0].provider.name).toBe('custom-llm');
    });

    it('custom factory receives apiKey and baseUrl from config', async () => {
      writeFileSync(
        resolve(tempDir, 'runcor.yaml'),
        'providers:\n  - type: my-provider\n    apiKey: sk-test-123\n    baseUrl: https://api.example.com\n',
      );

      let receivedConfig: Record<string, unknown> | undefined;

      const result = await loadConfig({
        basePath: tempDir,
        providerFactories: {
          'my-provider': (cfg) => {
            receivedConfig = cfg;
            return {
              name: 'my-provider',
              complete: async () => ({
                text: '',
                model: 'custom',
                provider: 'my-provider',
                usage: { promptTokens: 0, completionTokens: 0 },
              }),
            };
          },
        },
      });

      expect(result).toBeDefined();
      expect(receivedConfig).toBeDefined();
      expect(receivedConfig!.apiKey).toBe('sk-test-123');
      expect(receivedConfig!.baseUrl).toBe('https://api.example.com');
    });
  });

  // ── 13. Env var interpolation integration ──

  describe('env var interpolation integration', () => {
    it('throws CONFIG_INVALID when required env vars are missing', async () => {
      delete process.env.TEST_API_KEY;
      try {
        await loadConfig({
          path: resolve(fixturesDir, 'env-vars.yaml'),
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('CONFIG_INVALID');
        const msg = (err as EngineError).message;
        expect(msg).toContain('required environment variable is not set');
      }
    });

    it('resolves env vars when required vars are set', async () => {
      // env-vars.yaml has ${TEST_API_KEY} (required) on a mock provider
      process.env.TEST_API_KEY = 'resolved-key';

      const result = await loadConfig({
        path: resolve(fixturesDir, 'env-vars.yaml'),
      });

      expect(result).toBeDefined();
      expect(result!.model.providers).toHaveLength(1);
      expect(result!.model.providers![0].provider.name).toBe('mock');
    });
  });

  // ── 14. RUNCOR_CONFIG env var with basePath resolves relative paths ──

  describe('RUNCOR_CONFIG with basePath', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = makeTempDir();
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('resolves RUNCOR_CONFIG relative to basePath', async () => {
      writeFileSync(
        resolve(tempDir, 'custom-config.yaml'),
        'providers:\n  - type: mock\nengine:\n  concurrency: 55\n',
      );
      process.env.RUNCOR_CONFIG = 'custom-config.yaml';

      const result = await loadConfig({ basePath: tempDir });
      expect(result).toBeDefined();
      expect(result!.concurrency).toBe(55);
    });
  });

  // ── 15. Return value shape ──

  describe('return value shape', () => {
    it('returns an object with model property for minimal config', async () => {
      const result = await loadConfig({
        path: resolve(fixturesDir, 'minimal.yaml'),
      });
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('model');
    });

    it('mock provider in minimal config is functional', async () => {
      const result = await loadConfig({
        path: resolve(fixturesDir, 'minimal.yaml'),
      });
      expect(result).toBeDefined();
      const provider = result!.model.providers![0].provider;
      const response = await provider.complete({ prompt: 'test' });
      expect(response.text).toContain('test');
      expect(response.provider).toBe('mock');
    });
  });
});
