// Config file schema validator
// Validates a parsed runcor.yaml config object and returns structured errors

import type { ConfigValidationError } from '../errors.js';
import {
  VALID_TOP_LEVEL_KEYS,
  VALID_PROVIDER_TYPES,
  VALID_STRATEGIES,
  VALID_TRANSPORTS,
  VALID_PRESETS,
  VALID_SCOPES,
  VALID_BEHAVIORS,
  VALID_ENFORCEMENTS,
  VALID_WINDOW_TYPES,
  VALID_EVALUATOR_TYPES,
  VALID_OPERATIONS,
  VALID_STATE_TYPES,
  VALID_AUTONOMY_LEVELS,
} from './schema.js';

// ── Helper utilities ──

function addError(
  errors: ConfigValidationError[],
  path: string,
  message: string,
  expected?: string,
  received?: string,
): void {
  const err: ConfigValidationError = { path, message };
  if (expected !== undefined) err.expected = expected;
  if (received !== undefined) err.received = received;
  errors.push(err);
}

function checkType(
  errors: ConfigValidationError[],
  value: unknown,
  expectedType: string,
  path: string,
): boolean {
  if (value === undefined || value === null) return true;
  const actualType = typeof value;
  if (expectedType === 'array') {
    if (!Array.isArray(value)) {
      addError(errors, path, `Expected array, received ${actualType}`, 'array', actualType);
      return false;
    }
    return true;
  }
  if (actualType !== expectedType) {
    addError(errors, path, `Expected ${expectedType}, received ${actualType}`, expectedType, actualType);
    return false;
  }
  return true;
}

function checkEnum(
  errors: ConfigValidationError[],
  value: unknown,
  validSet: ReadonlySet<string>,
  path: string,
  typeName: string,
): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string' || !validSet.has(value)) {
    const options = [...validSet].map((v) => `"${v}"`).join(' | ');
    addError(errors, path, `Expected ${options}, received "${value}"`, typeName, String(value));
    return false;
  }
  return true;
}

function checkRequired(
  errors: ConfigValidationError[],
  obj: Record<string, unknown>,
  field: string,
  path: string,
): boolean {
  if (obj[field] === undefined || obj[field] === null) {
    addError(errors, path, 'Required field missing');
    return false;
  }
  return true;
}

// ── Section validators ──

function validateEngine(
  errors: ConfigValidationError[],
  engine: Record<string, unknown>,
): void {
  if (engine.concurrency !== undefined) checkType(errors, engine.concurrency, 'number', 'engine.concurrency');
  if (engine.drainTimeout !== undefined) checkType(errors, engine.drainTimeout, 'number', 'engine.drainTimeout');
  if (engine.retentionPeriod !== undefined) checkType(errors, engine.retentionPeriod, 'number', 'engine.retentionPeriod');
}

function validateProvider(
  errors: ConfigValidationError[],
  provider: Record<string, unknown>,
  index: number,
  customProviderTypes?: ReadonlySet<string>,
): void {
  const prefix = `providers[${index}]`;

  if (checkRequired(errors, provider, 'type', `${prefix}.type`)) {
    if (typeof provider.type === 'string') {
      const allValidTypes = customProviderTypes
        ? new Set([...VALID_PROVIDER_TYPES, ...customProviderTypes])
        : VALID_PROVIDER_TYPES;
      if (!allValidTypes.has(provider.type)) {
        const validList = [...VALID_PROVIDER_TYPES].join(', ');
        addError(
          errors,
          `${prefix}.type`,
          `Unknown provider type "${provider.type}". Valid types: ${validList}`,
          'valid provider type',
          provider.type,
        );
      }
    }
  }

  if (provider.apiKey !== undefined) checkType(errors, provider.apiKey, 'string', `${prefix}.apiKey`);
  if (provider.baseUrl !== undefined) checkType(errors, provider.baseUrl, 'string', `${prefix}.baseUrl`);
  if (provider.priority !== undefined) checkType(errors, provider.priority, 'number', `${prefix}.priority`);
  if (provider.models !== undefined) checkType(errors, provider.models, 'array', `${prefix}.models`);
  if (provider.costPerToken !== undefined && typeof provider.costPerToken === 'object' && provider.costPerToken !== null) {
    const cpt = provider.costPerToken as Record<string, unknown>;
    if (cpt.input !== undefined) checkType(errors, cpt.input, 'number', `${prefix}.costPerToken.input`);
    if (cpt.output !== undefined) checkType(errors, cpt.output, 'number', `${prefix}.costPerToken.output`);
  }
}

function validateRouting(
  errors: ConfigValidationError[],
  routing: Record<string, unknown>,
): void {
  if (routing.strategy !== undefined) checkEnum(errors, routing.strategy, VALID_STRATEGIES, 'routing.strategy', 'strategy');
  if (routing.maxFallbackAttempts !== undefined) checkType(errors, routing.maxFallbackAttempts, 'number', 'routing.maxFallbackAttempts');
  if (routing.failureThreshold !== undefined) checkType(errors, routing.failureThreshold, 'number', 'routing.failureThreshold');
  if (routing.cooldownMs !== undefined) checkType(errors, routing.cooldownMs, 'number', 'routing.cooldownMs');
}

function validateConnection(
  errors: ConfigValidationError[],
  conn: Record<string, unknown>,
  index: number,
): void {
  const prefix = `connections[${index}]`;

  checkRequired(errors, conn, 'name', `${prefix}.name`);

  // Validate preset if present
  if (conn.preset !== undefined) {
    checkEnum(errors, conn.preset, VALID_PRESETS, `${prefix}.preset`, 'preset');
    if (typeof conn.preset === 'string' && !VALID_PRESETS.has(conn.preset)) {
      // Error already added by checkEnum, but with different format.
      // Remove the last error and add a custom one.
      const lastErr = errors[errors.length - 1];
      if (lastErr && lastErr.path === `${prefix}.preset`) {
        errors.pop();
        const presetList = [...VALID_PRESETS].join(', ');
        addError(
          errors,
          `${prefix}.preset`,
          `Unknown connection preset "${conn.preset}". Valid presets: ${presetList}`,
          'valid preset',
          conn.preset,
        );
      }
    }
  }

  // Transport is required unless preset is set
  if (conn.preset === undefined) {
    if (conn.transport === undefined) {
      addError(errors, `${prefix}.transport`, 'Required field missing');
    }
  }

  if (conn.transport !== undefined) {
    const transportValid = checkEnum(errors, conn.transport, VALID_TRANSPORTS, `${prefix}.transport`, 'transport');

    // Cross-field: SSE requires url
    if (transportValid && conn.transport === 'sse' && !conn.url) {
      addError(errors, `${prefix}.url`, 'SSE transport requires "url" field');
    }

    // Cross-field: stdio requires command
    if (transportValid && conn.transport === 'stdio' && !conn.command) {
      addError(errors, `${prefix}.command`, 'stdio transport requires "command" field');
    }
  }

  if (conn.timeoutMs !== undefined) checkType(errors, conn.timeoutMs, 'number', `${prefix}.timeoutMs`);
  if (conn.retryAttempts !== undefined) checkType(errors, conn.retryAttempts, 'number', `${prefix}.retryAttempts`);
  if (conn.retryDelayMs !== undefined) checkType(errors, conn.retryDelayMs, 'number', `${prefix}.retryDelayMs`);
  if (conn.healthCheckIntervalMs !== undefined) checkType(errors, conn.healthCheckIntervalMs, 'number', `${prefix}.healthCheckIntervalMs`);
}

function validateBudgetEntry(
  errors: ConfigValidationError[],
  entry: Record<string, unknown>,
  path: string,
): void {
  checkRequired(errors, entry, 'limit', `${path}.limit`);
  if (entry.limit !== undefined) checkType(errors, entry.limit, 'number', `${path}.limit`);
  if (entry.enforcement !== undefined) checkEnum(errors, entry.enforcement, VALID_ENFORCEMENTS, `${path}.enforcement`, 'enforcement');

  if (entry.window !== undefined && typeof entry.window === 'object' && entry.window !== null) {
    const win = entry.window as Record<string, unknown>;
    if (win.type !== undefined) {
      checkEnum(errors, win.type, VALID_WINDOW_TYPES, `${path}.window.type`, 'window type');

      // Cross-field: custom requires durationMs
      if (win.type === 'custom' && win.durationMs === undefined) {
        addError(errors, `${path}.window.durationMs`, 'custom window type requires "durationMs" field');
      }
    }
    if (win.durationMs !== undefined) checkType(errors, win.durationMs, 'number', `${path}.window.durationMs`);
  }
}

function validateCosts(
  errors: ConfigValidationError[],
  costs: Record<string, unknown>,
): void {
  if (costs.warningThreshold !== undefined) checkType(errors, costs.warningThreshold, 'number', 'costs.warningThreshold');
  if (costs.defaultTokenEstimate !== undefined) checkType(errors, costs.defaultTokenEstimate, 'number', 'costs.defaultTokenEstimate');
  if (costs.maxLedgerEntries !== undefined) checkType(errors, costs.maxLedgerEntries, 'number', 'costs.maxLedgerEntries');

  if (costs.budgets !== undefined && typeof costs.budgets === 'object' && costs.budgets !== null) {
    const budgets = costs.budgets as Record<string, unknown>;
    const budgetScopes = ['perRequest', 'perUser', 'perFlow', 'global'] as const;
    for (const scope of budgetScopes) {
      if (budgets[scope] !== undefined && typeof budgets[scope] === 'object' && budgets[scope] !== null) {
        validateBudgetEntry(errors, budgets[scope] as Record<string, unknown>, `costs.budgets.${scope}`);
      }
    }
  }
}

function validateTelemetry(
  errors: ConfigValidationError[],
  telemetry: Record<string, unknown>,
): void {
  if (telemetry.serviceName !== undefined) checkType(errors, telemetry.serviceName, 'string', 'telemetry.serviceName');
  if (telemetry.serviceVersion !== undefined) checkType(errors, telemetry.serviceVersion, 'string', 'telemetry.serviceVersion');
  if (telemetry.memorySpans !== undefined) checkType(errors, telemetry.memorySpans, 'boolean', 'telemetry.memorySpans');
}

function validateRateLimit(
  errors: ConfigValidationError[],
  rl: Record<string, unknown>,
  prefix: string,
): void {
  checkRequired(errors, rl, 'name', `${prefix}.name`);
  checkRequired(errors, rl, 'scope', `${prefix}.scope`);
  checkRequired(errors, rl, 'limit', `${prefix}.limit`);
  checkRequired(errors, rl, 'windowMs', `${prefix}.windowMs`);

  if (rl.name !== undefined) checkType(errors, rl.name, 'string', `${prefix}.name`);
  if (rl.scope !== undefined) checkEnum(errors, rl.scope, VALID_SCOPES, `${prefix}.scope`, 'scope');
  if (rl.limit !== undefined) checkType(errors, rl.limit, 'number', `${prefix}.limit`);
  if (rl.windowMs !== undefined) checkType(errors, rl.windowMs, 'number', `${prefix}.windowMs`);
  if (rl.behavior !== undefined) checkEnum(errors, rl.behavior, VALID_BEHAVIORS, `${prefix}.behavior`, 'behavior');
  if (rl.maxQueueDepth !== undefined) checkType(errors, rl.maxQueueDepth, 'number', `${prefix}.maxQueueDepth`);
  if (rl.queueTimeoutMs !== undefined) checkType(errors, rl.queueTimeoutMs, 'number', `${prefix}.queueTimeoutMs`);
  if (rl.flowName !== undefined) checkType(errors, rl.flowName, 'string', `${prefix}.flowName`);
}

function validateAccessPolicy(
  errors: ConfigValidationError[],
  policy: Record<string, unknown>,
  prefix: string,
): void {
  checkRequired(errors, policy, 'identity', `${prefix}.identity`);
  if (policy.identity !== undefined) checkType(errors, policy.identity, 'string', `${prefix}.identity`);

  if (policy.allowedFlows !== undefined) checkType(errors, policy.allowedFlows, 'array', `${prefix}.allowedFlows`);
  if (policy.deniedFlows !== undefined) checkType(errors, policy.deniedFlows, 'array', `${prefix}.deniedFlows`);
  if (policy.allowedOperations !== undefined) {
    if (checkType(errors, policy.allowedOperations, 'array', `${prefix}.allowedOperations`)) {
      const ops = policy.allowedOperations as unknown[];
      for (let i = 0; i < ops.length; i++) {
        if (typeof ops[i] === 'string' && !VALID_OPERATIONS.has(ops[i] as string)) {
          const validOps = [...VALID_OPERATIONS].map((v) => `"${v}"`).join(' | ');
          addError(
            errors,
            `${prefix}.allowedOperations[${i}]`,
            `Expected ${validOps}, received "${ops[i]}"`,
            'valid operation',
            String(ops[i]),
          );
        }
      }
    }
  }
  if (policy.deniedOperations !== undefined) checkType(errors, policy.deniedOperations, 'array', `${prefix}.deniedOperations`);
}

function validatePolicy(
  errors: ConfigValidationError[],
  policy: Record<string, unknown>,
): void {
  if (policy.rateLimits !== undefined && Array.isArray(policy.rateLimits)) {
    for (let i = 0; i < policy.rateLimits.length; i++) {
      const rl = policy.rateLimits[i] as Record<string, unknown>;
      validateRateLimit(errors, rl, `policy.rateLimits[${i}]`);
    }
  }

  if (policy.accessPolicies !== undefined && Array.isArray(policy.accessPolicies)) {
    for (let i = 0; i < policy.accessPolicies.length; i++) {
      const ap = policy.accessPolicies[i] as Record<string, unknown>;
      validateAccessPolicy(errors, ap, `policy.accessPolicies[${i}]`);
    }
  }

  if (policy.tenants !== undefined && Array.isArray(policy.tenants)) {
    for (let i = 0; i < policy.tenants.length; i++) {
      const tenant = policy.tenants[i] as Record<string, unknown>;
      const prefix = `policy.tenants[${i}]`;

      checkRequired(errors, tenant, 'tenantId', `${prefix}.tenantId`);
      if (tenant.tenantId !== undefined) checkType(errors, tenant.tenantId, 'string', `${prefix}.tenantId`);

      if (tenant.rateLimits !== undefined && Array.isArray(tenant.rateLimits)) {
        for (let j = 0; j < tenant.rateLimits.length; j++) {
          const rl = tenant.rateLimits[j] as Record<string, unknown>;
          validateRateLimit(errors, rl, `${prefix}.rateLimits[${j}]`);
        }
      }

      if (tenant.allowedFlows !== undefined) checkType(errors, tenant.allowedFlows, 'array', `${prefix}.allowedFlows`);

      if (tenant.accessPolicies !== undefined && Array.isArray(tenant.accessPolicies)) {
        for (let j = 0; j < tenant.accessPolicies.length; j++) {
          const ap = tenant.accessPolicies[j] as Record<string, unknown>;
          validateAccessPolicy(errors, ap, `${prefix}.accessPolicies[${j}]`);
        }
      }
    }
  }
}

function validateEvaluation(
  errors: ConfigValidationError[],
  evaluation: Record<string, unknown>,
): void {
  if (evaluation.autoFlagScoreThreshold !== undefined) {
    checkType(errors, evaluation.autoFlagScoreThreshold, 'number', 'evaluation.autoFlagScoreThreshold');
  }

  if (evaluation.evaluators !== undefined && Array.isArray(evaluation.evaluators)) {
    for (let i = 0; i < evaluation.evaluators.length; i++) {
      const ev = evaluation.evaluators[i] as Record<string, unknown>;
      const prefix = `evaluation.evaluators[${i}]`;

      if (checkRequired(errors, ev, 'type', `${prefix}.type`)) {
        checkEnum(errors, ev.type, VALID_EVALUATOR_TYPES, `${prefix}.type`, 'evaluator type');
      }

      if (ev.name !== undefined) checkType(errors, ev.name, 'string', `${prefix}.name`);
      if (ev.weight !== undefined) checkType(errors, ev.weight, 'number', `${prefix}.weight`);
    }
  }
}

function validateServer(
  errors: ConfigValidationError[],
  server: Record<string, unknown>,
): void {
  if (server.enabled !== undefined) checkType(errors, server.enabled, 'boolean', 'server.enabled');
  if (server.name !== undefined) checkType(errors, server.name, 'string', 'server.name');
  if (server.version !== undefined) checkType(errors, server.version, 'string', 'server.version');
}

function validateDiscernment(
  errors: ConfigValidationError[],
  disc: Record<string, unknown>,
): void {
  if (disc.enabled !== undefined) checkType(errors, disc.enabled, 'boolean', 'discernment.enabled');
  if (disc.autonomy !== undefined) checkEnum(errors, disc.autonomy, VALID_AUTONOMY_LEVELS, 'discernment.autonomy', 'autonomy level');
  if (disc.schedule !== undefined) checkType(errors, disc.schedule, 'string', 'discernment.schedule');
  if (disc.provider !== undefined) checkType(errors, disc.provider, 'string', 'discernment.provider');
  if (disc.lookbackPeriod !== undefined) checkType(errors, disc.lookbackPeriod, 'number', 'discernment.lookbackPeriod');
  if (disc.gracePeriod !== undefined) checkType(errors, disc.gracePeriod, 'number', 'discernment.gracePeriod');
  if (disc.prompt !== undefined) checkType(errors, disc.prompt, 'string', 'discernment.prompt');

  if (disc.thresholds !== undefined && typeof disc.thresholds === 'object' && disc.thresholds !== null) {
    const t = disc.thresholds as Record<string, unknown>;
    if (t.idleFlowDays !== undefined) checkType(errors, t.idleFlowDays, 'number', 'discernment.thresholds.idleFlowDays');
    if (t.disproportionateCostPercent !== undefined) checkType(errors, t.disproportionateCostPercent, 'number', 'discernment.thresholds.disproportionateCostPercent');
    if (t.qualityDeclinePercent !== undefined) checkType(errors, t.qualityDeclinePercent, 'number', 'discernment.thresholds.qualityDeclinePercent');
    if (t.agentHardStopPercent !== undefined) checkType(errors, t.agentHardStopPercent, 'number', 'discernment.thresholds.agentHardStopPercent');
  }
}

function validateObjectives(
  errors: ConfigValidationError[],
  objectives: unknown[],
): void {
  for (let i = 0; i < objectives.length; i++) {
    const obj = objectives[i] as Record<string, unknown>;
    const prefix = `objectives[${i}]`;

    checkRequired(errors, obj, 'name', `${prefix}.name`);
    if (obj.name !== undefined) checkType(errors, obj.name, 'string', `${prefix}.name`);

    checkRequired(errors, obj, 'description', `${prefix}.description`);
    if (obj.description !== undefined) checkType(errors, obj.description, 'string', `${prefix}.description`);
  }
}

function validateState(
  errors: ConfigValidationError[],
  state: Record<string, unknown>,
): void {
  // Validate type
  if (state.type !== undefined) {
    checkEnum(errors, state.type, VALID_STATE_TYPES, 'state.type', 'state type');
  }

  // Path required when type is sqlite
  if (state.type === 'sqlite') {
    if (state.path === undefined || state.path === null || state.path === '') {
      addError(errors, 'state.path', 'Required when state.type is "sqlite"');
    } else {
      checkType(errors, state.path, 'string', 'state.path');
    }
  } else if (state.path !== undefined) {
    checkType(errors, state.path, 'string', 'state.path');
  }

  // Warn on unknown keys
  const validStateKeys = new Set(['type', 'path']);
  for (const key of Object.keys(state)) {
    if (!validStateKeys.has(key)) {
      addError(errors, `state.${key}`, `Unknown key "${key}" in state section`);
    }
  }
}

// ── Main export ──

/**
 * Validates a parsed config object against the runcor.yaml schema.
 * Returns an array of structured validation errors (empty = valid).
 * Collects all errors rather than failing on first.
 *
 * @param config - Parsed config object (null/undefined treated as empty, returns [])
 * @param customProviderTypes - Optional set of user-registered provider factory type identifiers
 */
export function validateConfig(
  config: Record<string, unknown> | null | undefined,
  customProviderTypes?: ReadonlySet<string>,
): ConfigValidationError[] {
  if (config === null || config === undefined) return [];

  const errors: ConfigValidationError[] = [];

  // Check for unknown top-level keys
  for (const key of Object.keys(config)) {
    if (!VALID_TOP_LEVEL_KEYS.has(key)) {
      const validList = [...VALID_TOP_LEVEL_KEYS].join(', ');
      addError(errors, key, `Unknown key "${key}". Valid keys: ${validList}`);
    }
  }

  // Validate each section
  if (config.engine !== undefined && typeof config.engine === 'object' && config.engine !== null) {
    validateEngine(errors, config.engine as Record<string, unknown>);
  }

  if (config.providers !== undefined && Array.isArray(config.providers)) {
    for (let i = 0; i < config.providers.length; i++) {
      validateProvider(errors, config.providers[i] as Record<string, unknown>, i, customProviderTypes);
    }
  }

  if (config.routing !== undefined && typeof config.routing === 'object' && config.routing !== null) {
    validateRouting(errors, config.routing as Record<string, unknown>);
  }

  if (config.connections !== undefined && Array.isArray(config.connections)) {
    for (let i = 0; i < config.connections.length; i++) {
      validateConnection(errors, config.connections[i] as Record<string, unknown>, i);
    }
  }

  if (config.costs !== undefined && typeof config.costs === 'object' && config.costs !== null) {
    validateCosts(errors, config.costs as Record<string, unknown>);
  }

  if (config.telemetry !== undefined && typeof config.telemetry === 'object' && config.telemetry !== null) {
    validateTelemetry(errors, config.telemetry as Record<string, unknown>);
  }

  if (config.policy !== undefined && typeof config.policy === 'object' && config.policy !== null) {
    validatePolicy(errors, config.policy as Record<string, unknown>);
  }

  if (config.evaluation !== undefined && typeof config.evaluation === 'object' && config.evaluation !== null) {
    validateEvaluation(errors, config.evaluation as Record<string, unknown>);
  }

  if (config.server !== undefined && typeof config.server === 'object' && config.server !== null) {
    validateServer(errors, config.server as Record<string, unknown>);
  }

  if (config.state !== undefined && typeof config.state === 'object' && config.state !== null) {
    validateState(errors, config.state as Record<string, unknown>);
  }

  // Discernment
  if (config.discernment !== undefined && typeof config.discernment === 'object' && config.discernment !== null) {
    validateDiscernment(errors, config.discernment as Record<string, unknown>);
  }

  // Objectives
  if (config.objectives !== undefined && Array.isArray(config.objectives)) {
    validateObjectives(errors, config.objectives as unknown[]);
  }

  return errors;
}
