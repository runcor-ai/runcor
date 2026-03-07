// Unit tests for config mapper
// Per spec: maps validated RuncorConfigFile → EngineConfig across all 7 mapping groups

import { describe, it, expect, vi } from 'vitest';
import { mapToEngineConfig } from '../../../src/config/mapper.js';
import type { RuncorConfigFile } from '../../../src/config/schema.js';
import type { ProviderFactory, EvaluatorFactory } from '../../../src/config/factories.js';
import { mergeProviderFactories, mergeEvaluatorFactories } from '../../../src/config/factories.js';
import { MockProvider } from '../../../src/model/mock.js';

// Shared factory instances for most tests
const providerFactories = mergeProviderFactories();
const evaluatorFactories = mergeEvaluatorFactories();

/** Helper: call mapper with minimal boilerplate */
function map(yaml: RuncorConfigFile) {
  return mapToEngineConfig(yaml, providerFactories, evaluatorFactories);
}

// ── 1. Provider Mapping (US4) ──

describe('mapToEngineConfig — provider mapping', () => {
  it('returns empty model config when providers is undefined', () => {
    const result = map({});
    expect(result.model).toEqual({});
    expect(result.model.providers).toBeUndefined();
  });

  it('returns empty model config when providers is an empty array', () => {
    const result = map({ providers: [] });
    expect(result.model).toEqual({});
    expect(result.model.providers).toBeUndefined();
  });

  it('maps a single mock provider to model.providers with MockProvider instance', () => {
    const result = map({ providers: [{ type: 'mock' }] });
    expect(result.model.providers).toHaveLength(1);
    expect(result.model.providers![0].provider).toBeInstanceOf(MockProvider);
  });

  it('maps provider priority to ProviderConfig.priority', () => {
    const result = map({
      providers: [{ type: 'mock', priority: 5 }],
    });
    expect(result.model.providers![0].priority).toBe(5);
  });

  it('maps provider costPerToken to ProviderConfig.costPerToken', () => {
    const result = map({
      providers: [{ type: 'mock', costPerToken: { input: 0.01, output: 0.03 } }],
    });
    expect(result.model.providers![0].costPerToken).toEqual({
      input: 0.01,
      output: 0.03,
    });
  });

  it('maps provider models array to ProviderConfig.models', () => {
    const result = map({
      providers: [{ type: 'mock', models: ['mock-v1', 'mock-v2'] }],
    });
    expect(result.model.providers![0].models).toEqual(['mock-v1', 'mock-v2']);
  });

  it('maps multiple providers in order', () => {
    const result = map({
      providers: [
        { type: 'mock', priority: 1 },
        { type: 'mock', priority: 2 },
        { type: 'mock', priority: 3 },
      ],
    });
    expect(result.model.providers).toHaveLength(3);
    expect(result.model.providers![0].priority).toBe(1);
    expect(result.model.providers![1].priority).toBe(2);
    expect(result.model.providers![2].priority).toBe(3);
  });

  it('throws for an unknown provider type with no registered factory', () => {
    expect(() =>
      map({ providers: [{ type: 'nonexistent-provider' }] }),
    ).toThrow('No factory registered for provider type "nonexistent-provider"');
  });

  it('uses a custom provider factory when registered', () => {
    const customProvider = { name: 'custom', complete: vi.fn() };
    const customFactory: ProviderFactory = vi.fn().mockReturnValue(customProvider);
    const factories = mergeProviderFactories({ 'custom-type': customFactory });

    const result = mapToEngineConfig(
      { providers: [{ type: 'custom-type', apiKey: 'key-123', baseUrl: 'https://custom.api' }] },
      factories,
      evaluatorFactories,
    );

    expect(customFactory).toHaveBeenCalledWith({
      apiKey: 'key-123',
      baseUrl: 'https://custom.api',
      type: 'custom-type',
    });
    expect(result.model.providers![0].provider).toBe(customProvider);
  });

  it('maps routing strategy to model.strategy', () => {
    const result = map({
      providers: [{ type: 'mock' }],
      routing: { strategy: 'round-robin' },
    });
    expect(result.model.strategy).toBe('round-robin');
  });

  it('maps routing maxFallbackAttempts to model.maxFallbackAttempts', () => {
    const result = map({
      providers: [{ type: 'mock' }],
      routing: { maxFallbackAttempts: 5 },
    });
    expect(result.model.maxFallbackAttempts).toBe(5);
  });

  it('maps routing failureThreshold to model.failureThreshold', () => {
    const result = map({
      providers: [{ type: 'mock' }],
      routing: { failureThreshold: 10 },
    });
    expect(result.model.failureThreshold).toBe(10);
  });

  it('maps routing cooldownMs to model.cooldownMs', () => {
    const result = map({
      providers: [{ type: 'mock' }],
      routing: { cooldownMs: 60000 },
    });
    expect(result.model.cooldownMs).toBe(60000);
  });

  it('maps all routing fields together', () => {
    const result = map({
      providers: [{ type: 'mock' }],
      routing: {
        strategy: 'lowest-cost',
        maxFallbackAttempts: 3,
        failureThreshold: 7,
        cooldownMs: 15000,
      },
    });
    expect(result.model.strategy).toBe('lowest-cost');
    expect(result.model.maxFallbackAttempts).toBe(3);
    expect(result.model.failureThreshold).toBe(7);
    expect(result.model.cooldownMs).toBe(15000);
  });
});

// ── 2. Engine Settings ──

describe('mapToEngineConfig — engine settings', () => {
  it('maps engine.concurrency to config.concurrency', () => {
    const result = map({ engine: { concurrency: 50 } });
    expect(result.concurrency).toBe(50);
  });

  it('maps engine.drainTimeout to config.drainTimeout', () => {
    const result = map({ engine: { drainTimeout: 5000 } });
    expect(result.drainTimeout).toBe(5000);
  });

  it('maps engine.retentionPeriod to config.retentionPeriod', () => {
    const result = map({ engine: { retentionPeriod: 7200 } });
    expect(result.retentionPeriod).toBe(7200);
  });

  it('does not set engine properties when engine section is missing', () => {
    const result = map({});
    expect(result.concurrency).toBeUndefined();
    expect(result.drainTimeout).toBeUndefined();
    expect(result.retentionPeriod).toBeUndefined();
  });

  it('does not set engine properties when engine section is empty', () => {
    const result = map({ engine: {} });
    expect(result.concurrency).toBeUndefined();
    expect(result.drainTimeout).toBeUndefined();
    expect(result.retentionPeriod).toBeUndefined();
  });
});

// ── 3. Connection Mapping (US5) ──

describe('mapToEngineConfig — connection mapping', () => {
  it('maps a custom SSE connection to adapter config', () => {
    const result = map({
      connections: [
        {
          name: 'remote-mcp',
          transport: 'sse',
          url: 'https://mcp.example.com/events',
          headers: { Authorization: 'Bearer token' },
        },
      ],
    });
    expect(result.adapters).toBeDefined();
    expect(result.adapters!.adapters).toHaveLength(1);
    const adapter = result.adapters!.adapters![0];
    expect(adapter.name).toBe('remote-mcp');
    expect(adapter.transport).toBe('sse');
    expect(adapter.url).toBe('https://mcp.example.com/events');
    expect(adapter.headers).toEqual({ Authorization: 'Bearer token' });
  });

  it('maps a custom stdio connection to adapter config', () => {
    const result = map({
      connections: [
        {
          name: 'local-mcp',
          transport: 'stdio',
          command: 'node',
          args: ['server.js', '--port', '3000'],
        },
      ],
    });
    const adapter = result.adapters!.adapters![0];
    expect(adapter.name).toBe('local-mcp');
    expect(adapter.transport).toBe('stdio');
    expect(adapter.command).toBe('node');
    expect(adapter.args).toEqual(['server.js', '--port', '3000']);
  });

  it('resolves the gmail preset to the gmail reference config', () => {
    const result = map({
      connections: [{ name: 'my-gmail', preset: 'gmail' }],
    });
    const adapter = result.adapters!.adapters![0];
    expect(adapter.name).toBe('my-gmail');
    expect(adapter.transport).toBe('stdio');
    expect(adapter.command).toBe('npx');
    expect(adapter.args).toEqual(['-y', '@anthropic/gmail-mcp-server']);
    expect(adapter.timeoutMs).toBe(30_000);
    expect(adapter.retryAttempts).toBe(3);
  });

  it('resolves a preset with overrides (slack with timeoutMs override)', () => {
    const result = map({
      connections: [{ name: 'my-slack', preset: 'slack', timeoutMs: 10000 }],
    });
    const adapter = result.adapters!.adapters![0];
    expect(adapter.name).toBe('my-slack');
    expect(adapter.transport).toBe('stdio');
    expect(adapter.command).toBe('npx');
    expect(adapter.args).toEqual(['-y', '@anthropic/slack-mcp-server']);
    // The override should take effect
    expect(adapter.timeoutMs).toBe(10000);
    // Non-overridden defaults should remain
    expect(adapter.retryAttempts).toBe(3);
  });

  it('maps multiple connections to adapters.adapters array', () => {
    const result = map({
      connections: [
        { name: 'gmail', preset: 'gmail' },
        { name: 'custom-sse', transport: 'sse', url: 'https://example.com/sse' },
        { name: 'local', transport: 'stdio', command: 'python', args: ['server.py'] },
      ],
    });
    expect(result.adapters!.adapters).toHaveLength(3);
    expect(result.adapters!.adapters![0].name).toBe('gmail');
    expect(result.adapters!.adapters![1].name).toBe('custom-sse');
    expect(result.adapters!.adapters![2].name).toBe('local');
  });

  it('does not set adapters when connections is undefined', () => {
    const result = map({});
    expect(result.adapters).toBeUndefined();
  });

  it('does not set adapters when connections is an empty array', () => {
    const result = map({ connections: [] });
    expect(result.adapters).toBeUndefined();
  });

  it('maps optional connection fields (timeoutMs, retryAttempts, retryDelayMs, healthCheckIntervalMs)', () => {
    const result = map({
      connections: [
        {
          name: 'detailed',
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          timeoutMs: 5000,
          retryAttempts: 5,
          retryDelayMs: 2000,
          healthCheckIntervalMs: 15000,
        },
      ],
    });
    const adapter = result.adapters!.adapters![0];
    expect(adapter.timeoutMs).toBe(5000);
    expect(adapter.retryAttempts).toBe(5);
    expect(adapter.retryDelayMs).toBe(2000);
    expect(adapter.healthCheckIntervalMs).toBe(15000);
  });
});

// ── 4. Costs Mapping (US6) ──

describe('mapToEngineConfig — costs mapping', () => {
  it('maps warningThreshold to cost.warningThreshold', () => {
    const result = map({ costs: { warningThreshold: 0.9 } });
    expect(result.cost).toBeDefined();
    expect(result.cost!.warningThreshold).toBe(0.9);
  });

  it('maps budgets.global with limit, enforcement, and window', () => {
    const result = map({
      costs: {
        budgets: {
          global: {
            limit: 100,
            enforcement: 'hard',
            window: { type: 'daily' },
          },
        },
      },
    });
    expect(result.cost!.budgets!.global).toEqual({
      limit: 100,
      enforcement: 'hard',
      window: { type: 'daily' },
    });
  });

  it('maps budgets with all four scopes', () => {
    const result = map({
      costs: {
        budgets: {
          perRequest: { limit: 1 },
          perUser: { limit: 10, enforcement: 'soft' },
          perFlow: { limit: 50, window: { type: 'hourly' } },
          global: { limit: 500, enforcement: 'hard', window: { type: 'monthly' } },
        },
      },
    });
    const budgets = result.cost!.budgets!;
    expect(budgets.perRequest).toEqual({ limit: 1 });
    expect(budgets.perUser).toEqual({ limit: 10, enforcement: 'soft' });
    expect(budgets.perFlow).toEqual({ limit: 50, window: { type: 'hourly' } });
    expect(budgets.global).toEqual({
      limit: 500,
      enforcement: 'hard',
      window: { type: 'monthly' },
    });
  });

  it('maps a custom budget window with type and durationMs', () => {
    const result = map({
      costs: {
        budgets: {
          global: {
            limit: 200,
            window: { type: 'custom', durationMs: 3600000 },
          },
        },
      },
    });
    expect(result.cost!.budgets!.global!.window).toEqual({
      type: 'custom',
      durationMs: 3600000,
    });
  });

  it('does not set cost when costs section is missing', () => {
    const result = map({});
    expect(result.cost).toBeUndefined();
  });

  it('maps defaultTokenEstimate and maxLedgerEntries', () => {
    const result = map({
      costs: {
        defaultTokenEstimate: 500,
        maxLedgerEntries: 50000,
      },
    });
    expect(result.cost!.defaultTokenEstimate).toBe(500);
    expect(result.cost!.maxLedgerEntries).toBe(50000);
  });
});

// ── 5. Telemetry Mapping ──

describe('mapToEngineConfig — telemetry mapping', () => {
  it('maps serviceName to telemetry.serviceName', () => {
    const result = map({ telemetry: { serviceName: 'my-service' } });
    expect(result.telemetry!.serviceName).toBe('my-service');
  });

  it('maps serviceVersion to telemetry.serviceVersion', () => {
    const result = map({ telemetry: { serviceVersion: '2.0.0' } });
    expect(result.telemetry!.serviceVersion).toBe('2.0.0');
  });

  it('maps memorySpans to telemetry.memorySpans', () => {
    const result = map({ telemetry: { memorySpans: true } });
    expect(result.telemetry!.memorySpans).toBe(true);
  });

  it('does not set telemetry when telemetry section is missing', () => {
    const result = map({});
    expect(result.telemetry).toBeUndefined();
  });

  it('maps all telemetry fields together', () => {
    const result = map({
      telemetry: {
        serviceName: 'runcor',
        serviceVersion: '1.0.0',
        memorySpans: false,
      },
    });
    expect(result.telemetry).toEqual({
      serviceName: 'runcor',
      serviceVersion: '1.0.0',
      memorySpans: false,
    });
  });
});

// ── 6. Policy Mapping ──

describe('mapToEngineConfig — policy mapping', () => {
  it('maps rateLimits with all fields', () => {
    const result = map({
      policy: {
        rateLimits: [
          {
            name: 'global-limit',
            scope: 'global',
            limit: 100,
            windowMs: 60000,
            behavior: 'queue',
            maxQueueDepth: 50,
            queueTimeoutMs: 10000,
          },
        ],
      },
    });
    expect(result.policy!.rateLimits).toHaveLength(1);
    expect(result.policy!.rateLimits![0]).toEqual({
      name: 'global-limit',
      scope: 'global',
      limit: 100,
      windowMs: 60000,
      behavior: 'queue',
      maxQueueDepth: 50,
      queueTimeoutMs: 10000,
    });
  });

  it('maps rateLimits with flowName field', () => {
    const result = map({
      policy: {
        rateLimits: [
          {
            name: 'flow-limit',
            scope: 'flow',
            limit: 10,
            windowMs: 5000,
            flowName: 'my-flow',
          },
        ],
      },
    });
    expect(result.policy!.rateLimits![0].flowName).toBe('my-flow');
  });

  it('maps accessPolicies with all fields', () => {
    const result = map({
      policy: {
        accessPolicies: [
          {
            identity: 'admin-user',
            allowedFlows: ['admin-flow'],
            deniedFlows: ['restricted-flow'],
            allowedOperations: ['trigger', 'resume'],
            deniedOperations: ['replay'],
          },
        ],
      },
    });
    expect(result.policy!.accessPolicies).toHaveLength(1);
    expect(result.policy!.accessPolicies![0]).toEqual({
      identity: 'admin-user',
      allowedFlows: ['admin-flow'],
      deniedFlows: ['restricted-flow'],
      allowedOperations: ['trigger', 'resume'],
      deniedOperations: ['replay'],
    });
  });

  it('maps tenants with nested rateLimits and accessPolicies', () => {
    const result = map({
      policy: {
        tenants: [
          {
            tenantId: 'tenant-a',
            rateLimits: [
              {
                name: 'tenant-limit',
                scope: 'user',
                limit: 20,
                windowMs: 30000,
                behavior: 'reject',
              },
            ],
            allowedFlows: ['flow-a', 'flow-b'],
            accessPolicies: [
              {
                identity: 'user-1',
                allowedFlows: ['flow-a'],
                allowedOperations: ['trigger'],
              },
            ],
          },
        ],
      },
    });
    expect(result.policy!.tenants).toHaveLength(1);
    const tenant = result.policy!.tenants![0];
    expect(tenant.tenantId).toBe('tenant-a');
    expect(tenant.rateLimits).toHaveLength(1);
    expect(tenant.rateLimits![0].name).toBe('tenant-limit');
    expect(tenant.rateLimits![0].scope).toBe('user');
    expect(tenant.rateLimits![0].behavior).toBe('reject');
    expect(tenant.allowedFlows).toEqual(['flow-a', 'flow-b']);
    expect(tenant.accessPolicies).toHaveLength(1);
    expect(tenant.accessPolicies![0].identity).toBe('user-1');
    expect(tenant.accessPolicies![0].allowedOperations).toEqual(['trigger']);
  });

  it('does not set policy when policy section is missing', () => {
    const result = map({});
    expect(result.policy).toBeUndefined();
  });

  it('maps rateLimits with minimal fields (no optional behavior/queue fields)', () => {
    const result = map({
      policy: {
        rateLimits: [
          { name: 'basic', scope: 'global', limit: 50, windowMs: 10000 },
        ],
      },
    });
    const rl = result.policy!.rateLimits![0];
    expect(rl).toEqual({
      name: 'basic',
      scope: 'global',
      limit: 50,
      windowMs: 10000,
    });
    expect(rl.behavior).toBeUndefined();
    expect(rl.maxQueueDepth).toBeUndefined();
    expect(rl.queueTimeoutMs).toBeUndefined();
  });

  it('maps accessPolicies with only identity (no flow or operation filters)', () => {
    const result = map({
      policy: {
        accessPolicies: [{ identity: '*' }],
      },
    });
    const ap = result.policy!.accessPolicies![0];
    expect(ap.identity).toBe('*');
    expect(ap.allowedFlows).toBeUndefined();
    expect(ap.deniedFlows).toBeUndefined();
    expect(ap.allowedOperations).toBeUndefined();
    expect(ap.deniedOperations).toBeUndefined();
  });
});

// ── 7. Evaluation Mapping ──

describe('mapToEngineConfig — evaluation mapping', () => {
  it('maps autoFlagScoreThreshold to evaluation.autoFlagScoreThreshold', () => {
    const result = map({ evaluation: { autoFlagScoreThreshold: 0.3 } });
    expect(result.evaluation!.autoFlagScoreThreshold).toBe(0.3);
  });

  it('maps a length evaluator via built-in factory', () => {
    const result = map({
      evaluation: {
        evaluators: [
          {
            type: 'length',
            name: 'my-length',
            weight: 0.5,
            config: { minLength: 10, maxLength: 500 },
          },
        ],
      },
    });
    expect(result.evaluation!.evaluators).toHaveLength(1);
    expect(result.evaluation!.evaluators![0].name).toBe('my-length');
  });

  it('maps a format evaluator via built-in factory', () => {
    const result = map({
      evaluation: {
        evaluators: [
          {
            type: 'format',
            name: 'json-check',
            config: { expectedFormat: 'json' },
          },
        ],
      },
    });
    expect(result.evaluation!.evaluators).toHaveLength(1);
    expect(result.evaluation!.evaluators![0].name).toBe('json-check');
  });

  it('maps a keyword evaluator via built-in factory', () => {
    const result = map({
      evaluation: {
        evaluators: [
          {
            type: 'keyword',
            name: 'keyword-check',
            config: {
              requiredKeywords: ['hello'],
              forbiddenKeywords: ['goodbye'],
              caseSensitive: true,
            },
          },
        ],
      },
    });
    expect(result.evaluation!.evaluators).toHaveLength(1);
    expect(result.evaluation!.evaluators![0].name).toBe('keyword-check');
  });

  it('throws for an unknown evaluator type with no registered factory', () => {
    expect(() =>
      map({
        evaluation: {
          evaluators: [{ type: 'nonexistent-evaluator', name: 'bad' }],
        },
      }),
    ).toThrow('No factory registered for evaluator type "nonexistent-evaluator"');
  });

  it('uses a custom evaluator factory when registered', () => {
    const customEvaluator = {
      name: 'custom-eval',
      priority: 50,
      evaluate: vi.fn(),
    };
    const customFactory: EvaluatorFactory = vi.fn().mockReturnValue(customEvaluator);
    const factories = mergeEvaluatorFactories({ 'custom-eval-type': customFactory });

    const result = mapToEngineConfig(
      {
        evaluation: {
          evaluators: [
            {
              type: 'custom-eval-type',
              name: 'my-custom',
              weight: 0.8,
              config: { foo: 'bar' },
            },
          ],
        },
      },
      providerFactories,
      factories,
    );

    expect(customFactory).toHaveBeenCalledWith({
      name: 'my-custom',
      weight: 0.8,
      config: { foo: 'bar' },
    });
    expect(result.evaluation!.evaluators![0]).toBe(customEvaluator);
  });

  it('does not set evaluation when evaluation section is missing', () => {
    const result = map({});
    expect(result.evaluation).toBeUndefined();
  });

  it('maps evaluation with only autoFlagScoreThreshold (no evaluators)', () => {
    const result = map({ evaluation: { autoFlagScoreThreshold: 0.5 } });
    expect(result.evaluation!.autoFlagScoreThreshold).toBe(0.5);
    expect(result.evaluation!.evaluators).toBeUndefined();
  });

  it('maps multiple evaluators in order', () => {
    const result = map({
      evaluation: {
        evaluators: [
          { type: 'length', name: 'len' },
          { type: 'format', name: 'fmt' },
          { type: 'keyword', name: 'kw' },
        ],
      },
    });
    expect(result.evaluation!.evaluators).toHaveLength(3);
    expect(result.evaluation!.evaluators![0].name).toBe('len');
    expect(result.evaluation!.evaluators![1].name).toBe('fmt');
    expect(result.evaluation!.evaluators![2].name).toBe('kw');
  });
});

// ── 8. Full Integration: all sections together ──

describe('mapToEngineConfig — full config integration', () => {
  it('maps a complete config with all sections populated', () => {
    const result = map({
      engine: { concurrency: 25, drainTimeout: 3000, retentionPeriod: 1800 },
      providers: [
        { type: 'mock', priority: 1, models: ['mock-v1'], costPerToken: { input: 0.001, output: 0.002 } },
      ],
      routing: { strategy: 'priority', maxFallbackAttempts: 2, failureThreshold: 3, cooldownMs: 10000 },
      connections: [
        { name: 'gmail', preset: 'gmail' },
        { name: 'custom', transport: 'sse', url: 'https://example.com/sse' },
      ],
      costs: {
        warningThreshold: 0.75,
        budgets: {
          global: { limit: 1000, enforcement: 'hard', window: { type: 'daily' } },
        },
      },
      telemetry: { serviceName: 'runcor', serviceVersion: '1.0.0', memorySpans: true },
      policy: {
        rateLimits: [{ name: 'global', scope: 'global', limit: 100, windowMs: 60000 }],
        accessPolicies: [{ identity: '*', allowedOperations: ['trigger'] }],
      },
      evaluation: {
        autoFlagScoreThreshold: 0.4,
        evaluators: [{ type: 'length', name: 'len-check' }],
      },
    });

    // Engine
    expect(result.concurrency).toBe(25);
    expect(result.drainTimeout).toBe(3000);
    expect(result.retentionPeriod).toBe(1800);

    // Providers
    expect(result.model.providers).toHaveLength(1);
    expect(result.model.providers![0].provider).toBeInstanceOf(MockProvider);
    expect(result.model.providers![0].priority).toBe(1);
    expect(result.model.providers![0].models).toEqual(['mock-v1']);
    expect(result.model.providers![0].costPerToken).toEqual({ input: 0.001, output: 0.002 });

    // Routing
    expect(result.model.strategy).toBe('priority');
    expect(result.model.maxFallbackAttempts).toBe(2);
    expect(result.model.failureThreshold).toBe(3);
    expect(result.model.cooldownMs).toBe(10000);

    // Connections
    expect(result.adapters!.adapters).toHaveLength(2);
    expect(result.adapters!.adapters![0].name).toBe('gmail');
    expect(result.adapters!.adapters![1].name).toBe('custom');

    // Costs
    expect(result.cost!.warningThreshold).toBe(0.75);
    expect(result.cost!.budgets!.global!.limit).toBe(1000);

    // Telemetry
    expect(result.telemetry!.serviceName).toBe('runcor');
    expect(result.telemetry!.serviceVersion).toBe('1.0.0');
    expect(result.telemetry!.memorySpans).toBe(true);

    // Policy
    expect(result.policy!.rateLimits).toHaveLength(1);
    expect(result.policy!.accessPolicies).toHaveLength(1);

    // Evaluation
    expect(result.evaluation!.autoFlagScoreThreshold).toBe(0.4);
    expect(result.evaluation!.evaluators).toHaveLength(1);
  });
});

// ── Feature 016: State Mapping ──

describe('state mapping', () => {
  it('maps sqlite state config with type and path', () => {
    const result = map({ state: { type: 'sqlite', path: './data/test.db' } });
    expect(result.state).toBeDefined();
    expect(result.state!.type).toBe('sqlite');
    expect(result.state!.path).toBe('./data/test.db');
  });

  it('maps memory state config', () => {
    const result = map({ state: { type: 'memory' } });
    expect(result.state).toBeDefined();
    expect(result.state!.type).toBe('memory');
    expect(result.state!.path).toBeUndefined();
  });

  it('does not include onOrphanedExecution from YAML', () => {
    const result = map({ state: { type: 'sqlite', path: './test.db' } });
    expect(result.state!.onOrphanedExecution).toBeUndefined();
  });

  it('omits state config when not in YAML', () => {
    const result = map({});
    expect(result.state).toBeUndefined();
  });
});
