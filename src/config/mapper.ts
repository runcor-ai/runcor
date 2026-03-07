// Maps parsed+validated RuncorConfigFile → EngineConfig

import type { RuncorConfigFile, ProviderEntry, ConnectionEntry, ServerEntry, HttpServerEntry, SchedulerEntry, StateEntry, DiscernmentEntry, ObjectiveEntry } from './schema.js';
import type {
  EngineConfig,
  ProviderConfig,
  CostConfig,
  BudgetScopeConfig,
  BudgetWindow,
  TelemetryConfig,
  PolicyConfig,
  RateLimitConfig,
  AccessPolicy,
  TenantConfig,
  EvaluationConfig,
  AdapterConfig,
  AdapterManagerConfig,
  TransportType,
  OperationType,
  StateStoreConfig,
} from '../types.js';
import type { DiscernmentConfig, HeuristicThresholds, ObjectiveDeclaration } from '../discernment/types.js';
import type { MCPServerConfig } from '../server/types.js';
import type { ModelProvider } from '../model/provider.js';
import type { ProviderFactory, EvaluatorFactory } from './factories.js';
import { gmailAdapterConfig } from '../adapter/reference/gmail.js';
import { slackAdapterConfig } from '../adapter/reference/slack.js';
import { calendarAdapterConfig } from '../adapter/reference/calendar.js';

/** Preset resolver map: preset name → factory function */
const presetResolvers: Record<string, (overrides?: Partial<AdapterConfig>) => AdapterConfig> = {
  gmail: gmailAdapterConfig,
  slack: slackAdapterConfig,
  calendar: calendarAdapterConfig,
};

/** Map a validated RuncorConfigFile to an EngineConfig */
export function mapToEngineConfig(
  yaml: RuncorConfigFile,
  providerFactories: Record<string, ProviderFactory>,
  evaluatorFactories: Record<string, EvaluatorFactory>,
): EngineConfig {
  const config: EngineConfig = {
    model: mapProviders(yaml, providerFactories),
  };

  // Engine-level settings
  if (yaml.engine) {
    if (yaml.engine.concurrency !== undefined) config.concurrency = yaml.engine.concurrency;
    if (yaml.engine.drainTimeout !== undefined) config.drainTimeout = yaml.engine.drainTimeout;
    if (yaml.engine.retentionPeriod !== undefined) config.retentionPeriod = yaml.engine.retentionPeriod;
  }

  // Routing (merged into model config)
  if (yaml.routing) {
    if (yaml.routing.strategy !== undefined) {
      config.model.strategy = yaml.routing.strategy as EngineConfig['model']['strategy'];
    }
    if (yaml.routing.maxFallbackAttempts !== undefined) {
      config.model.maxFallbackAttempts = yaml.routing.maxFallbackAttempts;
    }
    if (yaml.routing.failureThreshold !== undefined) {
      config.model.failureThreshold = yaml.routing.failureThreshold;
    }
    if (yaml.routing.cooldownMs !== undefined) {
      config.model.cooldownMs = yaml.routing.cooldownMs;
    }
  }

  // Connections → adapters
  if (yaml.connections && yaml.connections.length > 0) {
    config.adapters = mapConnections(yaml.connections);
  }

  // Costs
  if (yaml.costs) {
    config.cost = mapCosts(yaml.costs);
  }

  // Telemetry (scalar fields only — no OTel provider instances)
  if (yaml.telemetry) {
    config.telemetry = mapTelemetry(yaml.telemetry);
  }

  // Policy (rateLimits + accessPolicies + tenants — no rules/guardrails from YAML)
  if (yaml.policy) {
    config.policy = mapPolicy(yaml.policy);
  }

  // Evaluation
  if (yaml.evaluation) {
    config.evaluation = mapEvaluation(yaml.evaluation, evaluatorFactories);
  }

  // Server
  if (yaml.server) {
    config.server = mapServer(yaml.server);
  }

  // Scheduler
  if (yaml.scheduler) {
    config.scheduler = {};
    if (yaml.scheduler.defaultTimezone !== undefined) {
      config.scheduler.defaultTimezone = yaml.scheduler.defaultTimezone;
    }
  }

  // State backend
  if (yaml.state) {
    config.state = mapState(yaml.state);
  }

  // Discernment
  if (yaml.discernment) {
    config.discernment = mapDiscernment(yaml.discernment, yaml.objectives);
  }

  return config;
}

/** Map providers section + routing to model config */
function mapProviders(
  yaml: RuncorConfigFile,
  factories: Record<string, ProviderFactory>,
): EngineConfig['model'] {
  const providers = yaml.providers;
  if (!providers || providers.length === 0) {
    // No providers declared — return minimal model config
    return {};
  }

  const providerConfigs: ProviderConfig[] = providers.map((entry) => {
    const factory = factories[entry.type];
    let provider: ModelProvider;

    if (factory) {
      provider = factory({
        apiKey: entry.apiKey,
        baseUrl: entry.baseUrl,
        type: entry.type,
      });
    } else {
      // For unknown types without custom factory — this shouldn't happen
      // because validation catches it, but fall back gracefully
      throw new Error(`No factory registered for provider type "${entry.type}"`);
    }

    const pc: ProviderConfig = {
      provider,
      priority: entry.priority,
      models: entry.models,
    };

    if (entry.costPerToken) {
      pc.costPerToken = {
        input: entry.costPerToken.input,
        output: entry.costPerToken.output,
      };
    }

    return pc;
  });

  return {
    providers: providerConfigs,
  };
}

/** Map connections section to AdapterManagerConfig */
function mapConnections(connections: ConnectionEntry[]): AdapterManagerConfig {
  const adapters: AdapterConfig[] = connections.map((conn) => {
    // Preset resolution
    if (conn.preset) {
      const resolver = presetResolvers[conn.preset];
      if (resolver) {
        const overrides: Partial<AdapterConfig> = {};
        if (conn.name) overrides.name = conn.name;
        if (conn.timeoutMs !== undefined) overrides.timeoutMs = conn.timeoutMs;
        if (conn.retryAttempts !== undefined) overrides.retryAttempts = conn.retryAttempts;
        if (conn.retryDelayMs !== undefined) overrides.retryDelayMs = conn.retryDelayMs;
        if (conn.healthCheckIntervalMs !== undefined) overrides.healthCheckIntervalMs = conn.healthCheckIntervalMs;
        if (conn.headers) overrides.headers = conn.headers;
        if (conn.transport) overrides.transport = conn.transport as TransportType;
        if (conn.command) overrides.command = conn.command;
        if (conn.args) overrides.args = conn.args;
        if (conn.url) overrides.url = conn.url;
        return resolver(overrides);
      }
    }

    // Custom connection
    const adapter: AdapterConfig = {
      name: conn.name,
      transport: conn.transport as TransportType,
    };

    if (conn.command) adapter.command = conn.command;
    if (conn.args) adapter.args = conn.args;
    if (conn.url) adapter.url = conn.url;
    if (conn.headers) adapter.headers = conn.headers;
    if (conn.timeoutMs !== undefined) adapter.timeoutMs = conn.timeoutMs;
    if (conn.retryAttempts !== undefined) adapter.retryAttempts = conn.retryAttempts;
    if (conn.retryDelayMs !== undefined) adapter.retryDelayMs = conn.retryDelayMs;
    if (conn.healthCheckIntervalMs !== undefined) adapter.healthCheckIntervalMs = conn.healthCheckIntervalMs;

    return adapter;
  });

  return { adapters };
}

/** Map costs section to CostConfig */
function mapCosts(costs: NonNullable<RuncorConfigFile['costs']>): CostConfig {
  const config: CostConfig = {};

  if (costs.warningThreshold !== undefined) config.warningThreshold = costs.warningThreshold;
  if (costs.defaultTokenEstimate !== undefined) config.defaultTokenEstimate = costs.defaultTokenEstimate;
  if (costs.maxLedgerEntries !== undefined) config.maxLedgerEntries = costs.maxLedgerEntries;

  if (costs.budgets) {
    config.budgets = {};
    if (costs.budgets.perRequest) config.budgets.perRequest = mapBudgetScope(costs.budgets.perRequest);
    if (costs.budgets.perUser) config.budgets.perUser = mapBudgetScope(costs.budgets.perUser);
    if (costs.budgets.perFlow) config.budgets.perFlow = mapBudgetScope(costs.budgets.perFlow);
    if (costs.budgets.global) config.budgets.global = mapBudgetScope(costs.budgets.global);
  }

  return config;
}

/** Map a single budget entry to BudgetScopeConfig */
function mapBudgetScope(entry: { limit: number; enforcement?: string; window?: { type: string; durationMs?: number } }): BudgetScopeConfig {
  const scope: BudgetScopeConfig = {
    limit: entry.limit,
  };

  if (entry.enforcement) {
    scope.enforcement = entry.enforcement as 'hard' | 'soft' | 'disabled';
  }

  if (entry.window) {
    const win: BudgetWindow = {
      type: entry.window.type as BudgetWindow['type'],
    };
    if (entry.window.durationMs !== undefined) {
      win.durationMs = entry.window.durationMs;
    }
    scope.window = win;
  }

  return scope;
}

/** Map telemetry section to TelemetryConfig (scalar fields only) */
function mapTelemetry(tel: NonNullable<RuncorConfigFile['telemetry']>): TelemetryConfig {
  const config: TelemetryConfig = {};
  if (tel.serviceName !== undefined) config.serviceName = tel.serviceName;
  if (tel.serviceVersion !== undefined) config.serviceVersion = tel.serviceVersion;
  if (tel.memorySpans !== undefined) config.memorySpans = tel.memorySpans;
  return config;
}

/** Map policy section to PolicyConfig (no rules/guardrails from YAML) */
function mapPolicy(pol: NonNullable<RuncorConfigFile['policy']>): PolicyConfig {
  const config: PolicyConfig = {};

  if (pol.rateLimits) {
    config.rateLimits = pol.rateLimits.map((rl) => {
      const mapped: RateLimitConfig = {
        name: rl.name,
        scope: rl.scope as 'user' | 'flow' | 'global',
        limit: rl.limit,
        windowMs: rl.windowMs,
      };
      if (rl.behavior) mapped.behavior = rl.behavior as 'reject' | 'queue';
      if (rl.maxQueueDepth !== undefined) mapped.maxQueueDepth = rl.maxQueueDepth;
      if (rl.queueTimeoutMs !== undefined) mapped.queueTimeoutMs = rl.queueTimeoutMs;
      if (rl.flowName) mapped.flowName = rl.flowName;
      return mapped;
    });
  }

  if (pol.accessPolicies) {
    config.accessPolicies = pol.accessPolicies.map((ap) => {
      const mapped: AccessPolicy = { identity: ap.identity };
      if (ap.allowedFlows) mapped.allowedFlows = ap.allowedFlows;
      if (ap.deniedFlows) mapped.deniedFlows = ap.deniedFlows;
      if (ap.allowedOperations) {
        mapped.allowedOperations = ap.allowedOperations as OperationType[];
      }
      if (ap.deniedOperations) {
        mapped.deniedOperations = ap.deniedOperations as OperationType[];
      }
      return mapped;
    });
  }

  if (pol.tenants) {
    config.tenants = pol.tenants.map((t) => {
      const mapped: TenantConfig = { tenantId: t.tenantId };
      if (t.rateLimits) {
        mapped.rateLimits = t.rateLimits.map((rl) => {
          const r: RateLimitConfig = {
            name: rl.name,
            scope: rl.scope as 'user' | 'flow' | 'global',
            limit: rl.limit,
            windowMs: rl.windowMs,
          };
          if (rl.behavior) r.behavior = rl.behavior as 'reject' | 'queue';
          if (rl.maxQueueDepth !== undefined) r.maxQueueDepth = rl.maxQueueDepth;
          if (rl.queueTimeoutMs !== undefined) r.queueTimeoutMs = rl.queueTimeoutMs;
          if (rl.flowName) r.flowName = rl.flowName;
          return r;
        });
      }
      if (t.allowedFlows) mapped.allowedFlows = t.allowedFlows;
      if (t.accessPolicies) {
        mapped.accessPolicies = t.accessPolicies.map((ap) => {
          const a: AccessPolicy = { identity: ap.identity };
          if (ap.allowedFlows) a.allowedFlows = ap.allowedFlows;
          if (ap.deniedFlows) a.deniedFlows = ap.deniedFlows;
          if (ap.allowedOperations) a.allowedOperations = ap.allowedOperations as OperationType[];
          if (ap.deniedOperations) a.deniedOperations = ap.deniedOperations as OperationType[];
          return a;
        });
      }
      return mapped;
    });
  }

  return config;
}

/** Map evaluation section to EvaluationConfig */
function mapEvaluation(
  evalEntry: NonNullable<RuncorConfigFile['evaluation']>,
  factories: Record<string, EvaluatorFactory>,
): EvaluationConfig {
  const config: EvaluationConfig = {};

  if (evalEntry.autoFlagScoreThreshold !== undefined) {
    config.autoFlagScoreThreshold = evalEntry.autoFlagScoreThreshold;
  }

  if (evalEntry.evaluators) {
    config.evaluators = evalEntry.evaluators.map((e) => {
      const factory = factories[e.type];
      if (!factory) {
        throw new Error(`No factory registered for evaluator type "${e.type}"`);
      }
      return factory({
        name: e.name,
        weight: e.weight,
        config: e.config,
      });
    });
  }

  return config;
}

/** Map server section to MCPServerConfig */
function mapServer(server: NonNullable<RuncorConfigFile['server']>): MCPServerConfig {
  const config: MCPServerConfig = {};
  if (server.enabled !== undefined) config.enabled = server.enabled;
  if (server.name !== undefined) config.name = server.name;
  if (server.version !== undefined) config.version = server.version;
  return config;
}

/** Extract httpServer section for CLI dev command */
export function extractHttpServerConfig(yaml: RuncorConfigFile): {
  enabled: boolean;
  port: number;
  hostname: string;
  cors: boolean;
} {
  const hs = yaml.httpServer;
  return {
    enabled: hs?.enabled ?? false,
    port: hs?.port ?? 3000,
    hostname: hs?.hostname ?? '127.0.0.1',
    cors: hs?.cors ?? true,
  };
}

/** Map state section to StateStoreConfig */
function mapState(state: StateEntry): StateStoreConfig {
  const config: Partial<StateStoreConfig> = {};
  if (state.type) config.type = state.type as 'memory' | 'sqlite';
  if (state.path) config.path = state.path;
  // onOrphanedExecution is programmatic-only, not mapped from YAML
  return config as StateStoreConfig;
}

/** Map discernment section to DiscernmentConfig */
function mapDiscernment(
  disc: DiscernmentEntry,
  objectives?: ObjectiveEntry[],
): DiscernmentConfig {
  const config: DiscernmentConfig = {
    enabled: disc.enabled ?? false,
    autonomy: (disc.autonomy as DiscernmentConfig['autonomy']) ?? 'recommend',
    schedule: disc.schedule ?? 'daily',
  };

  if (disc.provider !== undefined) config.provider = disc.provider;
  if (disc.lookbackPeriod !== undefined) config.lookbackPeriod = disc.lookbackPeriod;
  if (disc.gracePeriod !== undefined) config.gracePeriod = disc.gracePeriod;
  if (disc.prompt !== undefined) config.prompt = disc.prompt;

  if (disc.thresholds) {
    const t: HeuristicThresholds = {};
    if (disc.thresholds.idleFlowDays !== undefined) t.idleFlowDays = disc.thresholds.idleFlowDays;
    if (disc.thresholds.disproportionateCostPercent !== undefined) t.disproportionateCostPercent = disc.thresholds.disproportionateCostPercent;
    if (disc.thresholds.qualityDeclinePercent !== undefined) t.qualityDeclinePercent = disc.thresholds.qualityDeclinePercent;
    if (disc.thresholds.agentHardStopPercent !== undefined) t.agentHardStopPercent = disc.thresholds.agentHardStopPercent;
    config.thresholds = t;
  }

  if (objectives && objectives.length > 0) {
    config.objectives = objectives.map((o): ObjectiveDeclaration => ({
      name: o.name,
      description: o.description,
    }));
  }

  return config;
}
