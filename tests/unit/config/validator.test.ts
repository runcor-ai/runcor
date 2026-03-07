// Unit tests for config validator
// Per spec: schema validation, type checking, enum validation, cross-field rules

import { validateConfig } from '../../../src/config/validator.js';
import type { ConfigValidationError } from '../../../src/errors.js';

describe('validateConfig', () => {
  // ── 1. Valid minimal config ──
  describe('valid configs', () => {
    it('accepts a minimal config with just providers', () => {
      const errors = validateConfig({ providers: [{ type: 'mock' }] });
      expect(errors).toEqual([]);
    });

    // ── 2. Valid full config ──
    it('accepts a full config with all sections populated', () => {
      const errors = validateConfig({
        engine: {
          concurrency: 50,
          drainTimeout: 5000,
          retentionPeriod: 7200,
        },
        providers: [
          {
            type: 'anthropic',
            apiKey: 'sk-test',
            baseUrl: 'https://api.anthropic.com',
            priority: 1,
            models: ['claude-3-opus', 'claude-3-sonnet'],
            costPerToken: { input: 0.015, output: 0.075 },
          },
          {
            type: 'openai',
            apiKey: 'sk-openai',
            priority: 2,
            models: ['gpt-4'],
          },
        ],
        routing: {
          strategy: 'priority',
          maxFallbackAttempts: 3,
          failureThreshold: 5,
          cooldownMs: 30000,
        },
        connections: [
          {
            name: 'local-mcp',
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
            timeoutMs: 5000,
            retryAttempts: 3,
            retryDelayMs: 1000,
            healthCheckIntervalMs: 30000,
          },
          {
            name: 'remote-mcp',
            transport: 'sse',
            url: 'https://mcp.example.com/events',
            headers: { Authorization: 'Bearer token' },
            timeoutMs: 10000,
          },
        ],
        costs: {
          warningThreshold: 0.8,
          defaultTokenEstimate: 1000,
          maxLedgerEntries: 50000,
          budgets: {
            perRequest: {
              limit: 1.0,
              enforcement: 'hard',
              window: { type: 'none' },
            },
            perUser: {
              limit: 10.0,
              enforcement: 'soft',
              window: { type: 'daily' },
            },
            perFlow: {
              limit: 50.0,
              enforcement: 'hard',
              window: { type: 'monthly' },
            },
            global: {
              limit: 1000.0,
              enforcement: 'hard',
              window: { type: 'custom', durationMs: 86400000 },
            },
          },
        },
        telemetry: {
          serviceName: 'runcor',
          serviceVersion: '1.0.0',
          memorySpans: true,
        },
        policy: {
          rateLimits: [
            {
              name: 'global-limit',
              scope: 'global',
              limit: 100,
              windowMs: 60000,
              behavior: 'reject',
            },
          ],
          accessPolicies: [
            {
              identity: '*',
              allowedFlows: ['summarize'],
              deniedFlows: ['admin-only'],
              allowedOperations: ['trigger', 'resume'],
              deniedOperations: ['replay'],
            },
          ],
          tenants: [
            {
              tenantId: 'tenant-a',
              rateLimits: [
                {
                  name: 'tenant-a-limit',
                  scope: 'user',
                  limit: 50,
                  windowMs: 60000,
                },
              ],
              allowedFlows: ['summarize'],
              accessPolicies: [
                {
                  identity: 'admin',
                  allowedOperations: ['trigger'],
                },
              ],
            },
          ],
        },
        evaluation: {
          autoFlagScoreThreshold: 0.5,
          evaluators: [
            { type: 'length', name: 'length-check', weight: 1.0, config: { minLength: 10 } },
            { type: 'format', name: 'format-check', weight: 0.5 },
            { type: 'keyword', name: 'keyword-check' },
          ],
        },
      });
      expect(errors).toEqual([]);
    });
  });

  // ── 3. Unknown top-level keys rejected ──
  describe('unknown top-level keys', () => {
    it('rejects an unknown top-level key naming it with valid keys listed', () => {
      const errors = validateConfig({ database: {} });
      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe('database');
      expect(errors[0].message).toContain('Unknown key "database"');
      expect(errors[0].message).toContain('Valid keys:');
      expect(errors[0].message).toContain('engine');
      expect(errors[0].message).toContain('providers');
    });

    // ── 4. Multiple unknown keys all reported ──
    it('reports all unknown top-level keys', () => {
      const errors = validateConfig({ database: {}, cache: {}, auth: {} });
      expect(errors).toHaveLength(3);
      const paths = errors.map((e) => e.path);
      expect(paths).toContain('database');
      expect(paths).toContain('cache');
      expect(paths).toContain('auth');
    });
  });

  // ── 5-11. Required fields ──
  describe('required fields', () => {
    // ── 5. providers[].type is required ──
    it('requires providers[].type with path "providers[0].type"', () => {
      const errors = validateConfig({ providers: [{}] });
      const typeError = errors.find((e) => e.path === 'providers[0].type');
      expect(typeError).toBeDefined();
      expect(typeError!.message).toBe('Required field missing');
    });

    // ── 6. connections[].name is required ──
    it('requires connections[].name', () => {
      const errors = validateConfig({ connections: [{ transport: 'stdio', command: 'node' }] });
      const nameError = errors.find((e) => e.path === 'connections[0].name');
      expect(nameError).toBeDefined();
      expect(nameError!.message).toBe('Required field missing');
    });

    // ── 7. rateLimits[].name, scope, limit, windowMs are required ──
    it('requires rateLimits[].name, scope, limit, and windowMs', () => {
      const errors = validateConfig({
        policy: { rateLimits: [{}] },
      });
      const paths = errors.map((e) => e.path);
      expect(paths).toContain('policy.rateLimits[0].name');
      expect(paths).toContain('policy.rateLimits[0].scope');
      expect(paths).toContain('policy.rateLimits[0].limit');
      expect(paths).toContain('policy.rateLimits[0].windowMs');
    });

    // ── 8. accessPolicies[].identity is required ──
    it('requires accessPolicies[].identity', () => {
      const errors = validateConfig({
        policy: { accessPolicies: [{}] },
      });
      const identityError = errors.find((e) => e.path === 'policy.accessPolicies[0].identity');
      expect(identityError).toBeDefined();
      expect(identityError!.message).toBe('Required field missing');
    });

    // ── 9. tenants[].tenantId is required ──
    it('requires tenants[].tenantId', () => {
      const errors = validateConfig({
        policy: { tenants: [{}] },
      });
      const tenantError = errors.find((e) => e.path === 'policy.tenants[0].tenantId');
      expect(tenantError).toBeDefined();
      expect(tenantError!.message).toBe('Required field missing');
    });

    // ── 10. evaluators[].type is required ──
    it('requires evaluators[].type', () => {
      const errors = validateConfig({
        evaluation: { evaluators: [{}] },
      });
      const typeError = errors.find((e) => e.path === 'evaluation.evaluators[0].type');
      expect(typeError).toBeDefined();
      expect(typeError!.message).toBe('Required field missing');
    });

    // ── 11. budgets entries need limit ──
    it('requires budgets entries to have limit', () => {
      const errors = validateConfig({
        costs: {
          budgets: {
            perRequest: { enforcement: 'hard' } as any,
            perUser: {} as any,
          },
        },
      });
      const limitErrors = errors.filter((e) => e.message === 'Required field missing');
      const paths = limitErrors.map((e) => e.path);
      expect(paths).toContain('costs.budgets.perRequest.limit');
      expect(paths).toContain('costs.budgets.perUser.limit');
    });
  });

  // ── 12-17. Type checking ──
  describe('type checking', () => {
    // ── 12. engine.concurrency must be number ──
    it('rejects engine.concurrency as string', () => {
      const errors = validateConfig({ engine: { concurrency: 'fast' as any } });
      const err = errors.find((e) => e.path === 'engine.concurrency');
      expect(err).toBeDefined();
      expect(err!.message).toBe('Expected number, received string');
    });

    // ── 13. engine.drainTimeout must be number ──
    it('rejects engine.drainTimeout as non-number', () => {
      const errors = validateConfig({ engine: { drainTimeout: true as any } });
      const err = errors.find((e) => e.path === 'engine.drainTimeout');
      expect(err).toBeDefined();
      expect(err!.message).toBe('Expected number, received boolean');
    });

    // ── 14. telemetry.memorySpans must be boolean ──
    it('rejects telemetry.memorySpans as non-boolean', () => {
      const errors = validateConfig({ telemetry: { memorySpans: 'yes' as any } });
      const err = errors.find((e) => e.path === 'telemetry.memorySpans');
      expect(err).toBeDefined();
      expect(err!.message).toBe('Expected boolean, received string');
    });

    // ── 15. providers[].priority must be number ──
    it('rejects providers[].priority as non-number', () => {
      const errors = validateConfig({ providers: [{ type: 'mock', priority: 'high' as any }] });
      const err = errors.find((e) => e.path === 'providers[0].priority');
      expect(err).toBeDefined();
      expect(err!.message).toBe('Expected number, received string');
    });

    // ── 16. providers[].models must be array of strings ──
    it('rejects providers[].models as non-array', () => {
      const errors = validateConfig({ providers: [{ type: 'mock', models: 'gpt-4' as any }] });
      const err = errors.find((e) => e.path === 'providers[0].models');
      expect(err).toBeDefined();
      expect(err!.message).toContain('Expected array');
    });

    // ── 17. connections[].timeoutMs must be number ──
    it('rejects connections[].timeoutMs as non-number', () => {
      const errors = validateConfig({
        connections: [{ name: 'test', transport: 'stdio', command: 'node', timeoutMs: '5000' as any }],
      });
      const err = errors.find((e) => e.path === 'connections[0].timeoutMs');
      expect(err).toBeDefined();
      expect(err!.message).toBe('Expected number, received string');
    });

    // ── extra: costs.warningThreshold must be number ──
    it('rejects costs.warningThreshold as non-number', () => {
      const errors = validateConfig({ costs: { warningThreshold: 'high' as any } });
      const err = errors.find((e) => e.path === 'costs.warningThreshold');
      expect(err).toBeDefined();
      expect(err!.message).toBe('Expected number, received string');
    });
  });

  // ── 19-25. Enum validation ──
  describe('enum validation', () => {
    // ── 19. routing.strategy ──
    it('rejects invalid routing.strategy', () => {
      const errors = validateConfig({ routing: { strategy: 'random' } });
      const err = errors.find((e) => e.path === 'routing.strategy');
      expect(err).toBeDefined();
      expect(err!.message).toContain('"priority"');
      expect(err!.message).toContain('"round-robin"');
      expect(err!.message).toContain('"lowest-cost"');
      expect(err!.message).toContain('"random"');
    });

    // ── 20. connections[].transport ──
    it('rejects invalid connections[].transport', () => {
      const errors = validateConfig({
        connections: [{ name: 'test', transport: 'websocket' }],
      });
      const err = errors.find((e) => e.path === 'connections[0].transport');
      expect(err).toBeDefined();
      expect(err!.message).toContain('"stdio"');
      expect(err!.message).toContain('"sse"');
      expect(err!.message).toContain('"websocket"');
    });

    // ── 21. rateLimits[].scope ──
    it('rejects invalid rateLimits[].scope', () => {
      const errors = validateConfig({
        policy: {
          rateLimits: [{ name: 'rl', scope: 'tenant', limit: 10, windowMs: 1000 }],
        },
      });
      const err = errors.find((e) => e.path === 'policy.rateLimits[0].scope');
      expect(err).toBeDefined();
      expect(err!.message).toContain('"user"');
      expect(err!.message).toContain('"flow"');
      expect(err!.message).toContain('"global"');
    });

    // ── 22. rateLimits[].behavior ──
    it('rejects invalid rateLimits[].behavior', () => {
      const errors = validateConfig({
        policy: {
          rateLimits: [{ name: 'rl', scope: 'user', limit: 10, windowMs: 1000, behavior: 'throttle' }],
        },
      });
      const err = errors.find((e) => e.path === 'policy.rateLimits[0].behavior');
      expect(err).toBeDefined();
      expect(err!.message).toContain('"reject"');
      expect(err!.message).toContain('"queue"');
    });

    // ── 23. budgets[].enforcement ──
    it('rejects invalid budgets enforcement value', () => {
      const errors = validateConfig({
        costs: {
          budgets: {
            perRequest: { limit: 1, enforcement: 'warn' },
          },
        },
      });
      const err = errors.find((e) => e.path === 'costs.budgets.perRequest.enforcement');
      expect(err).toBeDefined();
      expect(err!.message).toContain('"hard"');
      expect(err!.message).toContain('"soft"');
      expect(err!.message).toContain('"disabled"');
    });

    // ── 24. budgets[].window.type ──
    it('rejects invalid window type', () => {
      const errors = validateConfig({
        costs: {
          budgets: {
            global: { limit: 100, window: { type: 'weekly' } },
          },
        },
      });
      const err = errors.find((e) => e.path === 'costs.budgets.global.window.type');
      expect(err).toBeDefined();
      expect(err!.message).toContain('"hourly"');
      expect(err!.message).toContain('"daily"');
      expect(err!.message).toContain('"monthly"');
      expect(err!.message).toContain('"custom"');
      expect(err!.message).toContain('"none"');
    });

    // ── 25. evaluators[].type ──
    it('rejects invalid evaluator type', () => {
      const errors = validateConfig({
        evaluation: { evaluators: [{ type: 'sentiment' }] },
      });
      const err = errors.find((e) => e.path === 'evaluation.evaluators[0].type');
      expect(err).toBeDefined();
      expect(err!.message).toContain('"length"');
      expect(err!.message).toContain('"format"');
      expect(err!.message).toContain('"keyword"');
    });
  });

  // ── 26-28. Cross-field validation ──
  describe('cross-field validation', () => {
    // ── 26. SSE transport requires url ──
    it('requires url when transport is sse', () => {
      const errors = validateConfig({
        connections: [{ name: 'remote', transport: 'sse' }],
      });
      const err = errors.find((e) => e.path === 'connections[0].url');
      expect(err).toBeDefined();
      expect(err!.message).toContain('SSE transport requires "url" field');
    });

    // ── 27. stdio transport requires command ──
    it('requires command when transport is stdio', () => {
      const errors = validateConfig({
        connections: [{ name: 'local', transport: 'stdio' }],
      });
      const err = errors.find((e) => e.path === 'connections[0].command');
      expect(err).toBeDefined();
      expect(err!.message).toContain('stdio transport requires "command" field');
    });

    // ── 28. custom window type requires durationMs ──
    it('requires durationMs when window type is custom', () => {
      const errors = validateConfig({
        costs: {
          budgets: {
            global: { limit: 100, window: { type: 'custom' } },
          },
        },
      });
      const err = errors.find((e) => e.path === 'costs.budgets.global.window.durationMs');
      expect(err).toBeDefined();
      expect(err!.message).toContain('custom');
      expect(err!.message).toContain('durationMs');
    });
  });

  // ── 29. All errors collected (not fail-on-first) ──
  describe('error collection', () => {
    it('collects all errors instead of failing on first', () => {
      const errors = validateConfig({
        database: {},
        engine: { concurrency: 'fast' as any },
        providers: [{}],
        routing: { strategy: 'random' },
      });
      // Should have at least: unknown key, type error, missing required, enum error
      expect(errors.length).toBeGreaterThanOrEqual(4);
      const paths = errors.map((e) => e.path);
      expect(paths).toContain('database');
      expect(paths).toContain('engine.concurrency');
      expect(paths).toContain('providers[0].type');
      expect(paths).toContain('routing.strategy');
    });
  });

  // ── 30. Field paths use array indices ──
  describe('field path formatting', () => {
    it('uses array indices in field paths', () => {
      const errors = validateConfig({
        providers: [{ type: 'mock' }, {}],
        policy: { rateLimits: [{}] },
      });
      const providerError = errors.find((e) => e.path === 'providers[1].type');
      expect(providerError).toBeDefined();
      const rateLimitError = errors.find((e) => e.path === 'policy.rateLimits[0].name');
      expect(rateLimitError).toBeDefined();
    });
  });

  // ── 31. Empty config (undefined/null) passes ──
  describe('empty config handling', () => {
    it('returns empty errors for undefined config', () => {
      const errors = validateConfig(undefined);
      expect(errors).toEqual([]);
    });

    it('returns empty errors for null config', () => {
      const errors = validateConfig(null);
      expect(errors).toEqual([]);
    });

    it('returns empty errors for empty object', () => {
      const errors = validateConfig({});
      expect(errors).toEqual([]);
    });
  });

  // ── 32. Preset connections don't require transport ──
  describe('preset connections', () => {
    it('accepts a preset connection without transport', () => {
      const errors = validateConfig({
        connections: [{ name: 'gmail', preset: 'gmail' }],
      });
      expect(errors).toEqual([]);
    });

    // ── 33. Unknown preset name ──
    it('rejects unknown preset name', () => {
      const errors = validateConfig({
        connections: [{ name: 'test', preset: 'unknown' }],
      });
      const err = errors.find((e) => e.path === 'connections[0].preset');
      expect(err).toBeDefined();
      expect(err!.message).toContain('Unknown connection preset "unknown"');
      expect(err!.message).toContain('Valid presets:');
    });
  });

  // ── 34. Provider type validation ──
  describe('provider type validation', () => {
    it('rejects unknown provider type', () => {
      const errors = validateConfig({
        providers: [{ type: 'unknown-provider' }],
      });
      const err = errors.find((e) => e.path === 'providers[0].type');
      expect(err).toBeDefined();
      expect(err!.message).toContain('Unknown provider type "unknown-provider"');
      expect(err!.message).toContain('Valid types:');
      expect(err!.message).toContain('anthropic');
      expect(err!.message).toContain('openai');
      expect(err!.message).toContain('ollama');
      expect(err!.message).toContain('mock');
    });

    it('accepts custom provider types when registered', () => {
      const customTypes = new Set(['my-custom-provider']);
      const errors = validateConfig(
        { providers: [{ type: 'my-custom-provider' }] },
        customTypes,
      );
      expect(errors).toEqual([]);
    });

    it('still validates built-in types with custom types registered', () => {
      const customTypes = new Set(['my-custom-provider']);
      const errors = validateConfig(
        { providers: [{ type: 'mock' }] },
        customTypes,
      );
      expect(errors).toEqual([]);
    });
  });

  // ── Feature 016: State section validation ──
  describe('state section', () => {
    it('accepts valid memory state config', () => {
      const errors = validateConfig({ state: { type: 'memory' } });
      expect(errors).toEqual([]);
    });

    it('accepts valid sqlite state config with path', () => {
      const errors = validateConfig({ state: { type: 'sqlite', path: './data/test.db' } });
      expect(errors).toEqual([]);
    });

    it('rejects invalid state type', () => {
      const errors = validateConfig({ state: { type: 'postgres' } });
      expect(errors.length).toBe(1);
      expect(errors[0].path).toBe('state.type');
    });

    it('rejects sqlite without path', () => {
      const errors = validateConfig({ state: { type: 'sqlite' } });
      expect(errors.length).toBe(1);
      expect(errors[0].path).toBe('state.path');
      expect(errors[0].message).toContain('Required');
    });

    it('rejects sqlite with empty path', () => {
      const errors = validateConfig({ state: { type: 'sqlite', path: '' } });
      expect(errors.length).toBe(1);
      expect(errors[0].path).toBe('state.path');
    });

    it('warns on unknown keys in state section', () => {
      const errors = validateConfig({ state: { type: 'memory', unknownKey: true } } as any);
      expect(errors.length).toBe(1);
      expect(errors[0].path).toBe('state.unknownKey');
      expect(errors[0].message).toContain('Unknown key');
    });
  });
});
