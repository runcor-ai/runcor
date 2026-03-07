// Integration tests for the full config loading pipeline
// End-to-end flow: YAML file -> loadConfig -> EngineConfig -> usable by engine

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/config/loader.js';
import { EngineError } from '../../src/errors.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = resolve(__dirname, '../fixtures/config');

// -- Helpers --

/** Save and restore process.env between tests */
let savedEnv: NodeJS.ProcessEnv;

/** Temp directory for independent section tests */
let tempDir: string;

beforeEach(() => {
  savedEnv = { ...process.env };
  tempDir = resolve(tmpdir(), `runcor-config-test-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  process.env = savedEnv;
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/** Write a temp YAML file and return its path */
function writeTempYaml(filename: string, content: string): string {
  const filePath = resolve(tempDir, filename);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// -- 1. Full Pipeline Tests --

describe('Full pipeline tests', () => {
  it('loads minimal.yaml and returns EngineConfig with mock provider', async () => {
    const config = await loadConfig({
      path: resolve(fixturesDir, 'minimal.yaml'),
    });

    expect(config).toBeDefined();
    expect(config!.model).toBeDefined();
    expect(config!.model.providers).toBeDefined();
    expect(config!.model.providers).toHaveLength(1);
    expect(config!.model.providers![0].provider.name).toBe('mock');
  });

  it('loads full.yaml with all 8 sections populated', async () => {
    const config = await loadConfig({
      path: resolve(fixturesDir, 'full.yaml'),
    });

    expect(config).toBeDefined();

    // Engine settings
    expect(config!.concurrency).toBe(50);
    expect(config!.drainTimeout).toBe(5000);
    expect(config!.retentionPeriod).toBe(7200);

    // Providers
    expect(config!.model.providers).toHaveLength(1);
    expect(config!.model.providers![0].provider.name).toBe('mock');
    expect(config!.model.providers![0].priority).toBe(1);
    expect(config!.model.providers![0].models).toEqual(['mock-v1']);
    expect(config!.model.providers![0].costPerToken).toEqual({
      input: 0.001,
      output: 0.002,
    });

    // Routing (merged into model)
    expect(config!.model.strategy).toBe('priority');
    expect(config!.model.maxFallbackAttempts).toBe(3);
    expect(config!.model.failureThreshold).toBe(5);
    expect(config!.model.cooldownMs).toBe(30000);

    // Connections -> adapters
    expect(config!.adapters).toBeDefined();
    expect(config!.adapters!.adapters).toHaveLength(1);
    expect(config!.adapters!.adapters![0].name).toBe('test-sse');
    expect(config!.adapters!.adapters![0].transport).toBe('sse');
    expect(config!.adapters!.adapters![0].url).toBe('http://localhost:3000');

    // Costs
    expect(config!.cost).toBeDefined();
    expect(config!.cost!.warningThreshold).toBe(0.8);
    expect(config!.cost!.defaultTokenEstimate).toBe(500);
    expect(config!.cost!.budgets!.perRequest!.limit).toBe(1.0);
    expect(config!.cost!.budgets!.global!.limit).toBe(100.0);
    expect(config!.cost!.budgets!.global!.window!.type).toBe('daily');

    // Telemetry
    expect(config!.telemetry).toBeDefined();
    expect(config!.telemetry!.serviceName).toBe('runcor-test');
    expect(config!.telemetry!.serviceVersion).toBe('1.0.0');
    expect(config!.telemetry!.memorySpans).toBe(true);

    // Policy
    expect(config!.policy).toBeDefined();
    expect(config!.policy!.rateLimits).toHaveLength(1);
    expect(config!.policy!.rateLimits![0].name).toBe('global-limit');
    expect(config!.policy!.accessPolicies).toHaveLength(1);
    expect(config!.policy!.accessPolicies![0].identity).toBe('admin');
    expect(config!.policy!.tenants).toHaveLength(1);
    expect(config!.policy!.tenants![0].tenantId).toBe('tenant-1');

    // Evaluation
    expect(config!.evaluation).toBeDefined();
    expect(config!.evaluation!.autoFlagScoreThreshold).toBe(0.3);
    expect(config!.evaluation!.evaluators).toHaveLength(1);
    expect(config!.evaluation!.evaluators![0].name).toBe('length-check');
  });

  it('throws CONFIG_INVALID for unknown top-level keys', async () => {
    await expect(
      loadConfig({ path: resolve(fixturesDir, 'unknown-keys.yaml') }),
    ).rejects.toThrow(EngineError);

    try {
      await loadConfig({ path: resolve(fixturesDir, 'unknown-keys.yaml') });
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).code).toBe('CONFIG_INVALID');
      expect((err as EngineError).message).toContain('banana');
      expect((err as EngineError).message).toContain('pineapple');
    }
  });

  it('throws CONFIG_NOT_FOUND for missing explicit path', async () => {
    await expect(
      loadConfig({ path: resolve(fixturesDir, 'does-not-exist.yaml') }),
    ).rejects.toThrow(EngineError);

    try {
      await loadConfig({ path: resolve(fixturesDir, 'does-not-exist.yaml') });
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).code).toBe('CONFIG_NOT_FOUND');
    }
  });

  it('throws CONFIG_INVALID for wrong types (invalid-type.yaml)', async () => {
    await expect(
      loadConfig({ path: resolve(fixturesDir, 'invalid-type.yaml') }),
    ).rejects.toThrow(EngineError);

    try {
      await loadConfig({ path: resolve(fixturesDir, 'invalid-type.yaml') });
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).code).toBe('CONFIG_INVALID');
      expect((err as EngineError).message).toContain('priority');
    }
  });
});

// -- 2. Zero-Config Mode --

describe('Zero-config mode', () => {
  it('returns undefined when basePath has no runcor.yaml', async () => {
    const result = await loadConfig({ basePath: tempDir });
    expect(result).toBeUndefined();
  });
});

// -- 3. Env Var Integration --

describe('Env var integration', () => {
  it('resolves env var when TEST_API_KEY is set', async () => {
    process.env.TEST_API_KEY = 'sk-test-secret-key-12345';

    const config = await loadConfig({
      path: resolve(fixturesDir, 'env-vars.yaml'),
    });

    expect(config).toBeDefined();
    expect(config!.model.providers).toHaveLength(1);
    // The apiKey gets passed to the factory; for mock it does not store it,
    // but the load succeeds without error, confirming interpolation worked
  });

  it('throws CONFIG_INVALID when required env var is missing', async () => {
    delete process.env.TEST_API_KEY;

    await expect(
      loadConfig({ path: resolve(fixturesDir, 'env-vars.yaml') }),
    ).rejects.toThrow(EngineError);

    try {
      await loadConfig({ path: resolve(fixturesDir, 'env-vars.yaml') });
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).code).toBe('CONFIG_INVALID');
      expect((err as EngineError).message).toContain('required environment variable is not set');
    }
  });
});

// -- 4. Independent Section Tests (SC-007) --

describe('Independent section tests (SC-007)', () => {
  it('loads providers-only config', async () => {
    const filePath = writeTempYaml('providers-only.yaml', 'providers:\n  - type: mock\n');

    const config = await loadConfig({ path: filePath });

    expect(config).toBeDefined();
    expect(config!.model.providers).toHaveLength(1);
    expect(config!.model.providers![0].provider.name).toBe('mock');
    // Other sections should be absent
    expect(config!.cost).toBeUndefined();
    expect(config!.telemetry).toBeUndefined();
    expect(config!.policy).toBeUndefined();
    expect(config!.evaluation).toBeUndefined();
    expect(config!.adapters).toBeUndefined();
  });

  it('loads costs-only config', async () => {
    const filePath = writeTempYaml('costs-only.yaml', 'costs:\n  warningThreshold: 0.8\n');

    const config = await loadConfig({ path: filePath });

    expect(config).toBeDefined();
    expect(config!.cost).toBeDefined();
    expect(config!.cost!.warningThreshold).toBe(0.8);
    // No providers, so model.providers should be absent
    expect(config!.model.providers).toBeUndefined();
  });

  it('loads telemetry-only config', async () => {
    const filePath = writeTempYaml('telemetry-only.yaml', 'telemetry:\n  serviceName: test\n');

    const config = await loadConfig({ path: filePath });

    expect(config).toBeDefined();
    expect(config!.telemetry).toBeDefined();
    expect(config!.telemetry!.serviceName).toBe('test');
    expect(config!.model.providers).toBeUndefined();
  });

  it('loads policy-only config with rate limits', async () => {
    const yaml = [
      'policy:',
      '  rateLimits:',
      '    - name: test',
      '      scope: global',
      '      limit: 100',
      '      windowMs: 60000',
    ].join('\n');
    const filePath = writeTempYaml('policy-only.yaml', yaml);

    const config = await loadConfig({ path: filePath });

    expect(config).toBeDefined();
    expect(config!.policy).toBeDefined();
    expect(config!.policy!.rateLimits).toHaveLength(1);
    expect(config!.policy!.rateLimits![0].name).toBe('test');
    expect(config!.policy!.rateLimits![0].scope).toBe('global');
    expect(config!.policy!.rateLimits![0].limit).toBe(100);
    expect(config!.policy!.rateLimits![0].windowMs).toBe(60000);
  });

  it('loads evaluation-only config with built-in evaluator type', async () => {
    const yaml = [
      'evaluation:',
      '  autoFlagScoreThreshold: 0.5',
      '  evaluators:',
      '    - type: length',
      '      name: my-length-eval',
      '      weight: 0.7',
      '      config:',
      '        minLength: 5',
      '        maxLength: 500',
    ].join('\n');
    const filePath = writeTempYaml('evaluation-only.yaml', yaml);

    const config = await loadConfig({ path: filePath });

    expect(config).toBeDefined();
    expect(config!.evaluation).toBeDefined();
    expect(config!.evaluation!.autoFlagScoreThreshold).toBe(0.5);
    expect(config!.evaluation!.evaluators).toHaveLength(1);
    expect(config!.evaluation!.evaluators![0].name).toBe('my-length-eval');
  });

  it('loads connections-only config', async () => {
    const yaml = [
      'connections:',
      '  - name: test',
      '    transport: sse',
      '    url: http://localhost',
    ].join('\n');
    const filePath = writeTempYaml('connections-only.yaml', yaml);

    const config = await loadConfig({ path: filePath });

    expect(config).toBeDefined();
    expect(config!.adapters).toBeDefined();
    expect(config!.adapters!.adapters).toHaveLength(1);
    expect(config!.adapters!.adapters![0].name).toBe('test');
    expect(config!.adapters!.adapters![0].transport).toBe('sse');
    expect(config!.adapters!.adapters![0].url).toBe('http://localhost');
  });
});

// -- 5. Performance Test (SC-001) --

describe('Performance (SC-001)', () => {
  it('loads full.yaml in under 100ms', async () => {
    const fullPath = resolve(fixturesDir, 'full.yaml');

    // Warm up: load once to prime any JIT / module caches
    await loadConfig({ path: fullPath });

    const start = performance.now();
    await loadConfig({ path: fullPath });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
  });
});

// -- 6. Secret Safety (SC-005) --

describe('Secret safety (SC-005)', () => {
  it('does not leak resolved env var values to console output', async () => {
    const secret = 'super-secret-api-key-DO-NOT-LEAK';
    process.env.TEST_API_KEY = secret;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await loadConfig({ path: resolve(fixturesDir, 'env-vars.yaml') });
    } finally {
      // Collect all console output
      const allOutput = [
        ...logSpy.mock.calls.map((args) => args.join(' ')),
        ...warnSpy.mock.calls.map((args) => args.join(' ')),
        ...errorSpy.mock.calls.map((args) => args.join(' ')),
      ].join('\n');

      // Verify the secret does not appear in any console output
      expect(allOutput).not.toContain(secret);

      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('does not leak secrets in error messages for invalid configs', async () => {
    const secret = 'another-secret-value-99';
    process.env.TEST_API_KEY = secret;

    // Create a config that uses env var but also has validation errors
    const yaml = [
      'providers:',
      '  - type: mock',
      '    apiKey: ${TEST_API_KEY}',
      'unknownKey: true',
    ].join('\n');
    const filePath = writeTempYaml('secret-error.yaml', yaml);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await loadConfig({ path: filePath });
    } catch (err) {
      const errorMessage = (err as Error).message;
      expect(errorMessage).not.toContain(secret);
    } finally {
      const allOutput = [
        ...logSpy.mock.calls.map((args) => args.join(' ')),
        ...warnSpy.mock.calls.map((args) => args.join(' ')),
        ...errorSpy.mock.calls.map((args) => args.join(' ')),
      ].join('\n');

      expect(allOutput).not.toContain(secret);

      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

// -- Additional Edge Cases --

describe('Edge cases', () => {
  it('auto-detects runcor.yaml in basePath directory', async () => {
    writeTempYaml('runcor.yaml', 'providers:\n  - type: mock\n');

    const config = await loadConfig({ basePath: tempDir });

    expect(config).toBeDefined();
    expect(config!.model.providers).toHaveLength(1);
    expect(config!.model.providers![0].provider.name).toBe('mock');
  });

  it('resolves RUNCOR_CONFIG env var for path discovery', async () => {
    const filePath = writeTempYaml('custom-name.yaml', 'providers:\n  - type: mock\n');

    process.env.RUNCOR_CONFIG = filePath;

    const config = await loadConfig({ basePath: tempDir });

    expect(config).toBeDefined();
    expect(config!.model.providers).toHaveLength(1);
  });
});
