// PolicyEngine — orchestrates all policy evaluation

import type {
  PolicyConfig,
  PolicyRule,
  PolicyContext,
  PolicyDecision,
  Guardrail,
  GuardrailContext,
  RateLimitConfig,
  AccessPolicy,
  TenantConfig,
  OperationType,
} from '../types.js';
import { EngineError } from '../errors.js';
import { evaluateRules, type RuleEvaluationResult } from './rule-evaluator.js';
import { evaluateAccess } from './access-control.js';
import { RateLimiter } from './rate-limiter.js';
import { runGuardrails, type GuardrailWarning } from './guardrail-runner.js';
import type { EngineInstrumentation } from '../telemetry/instrumentation.js';

/**
 * Internal policy engine that orchestrates all policy evaluation.
 * Instantiated 1:1 with the Runcor engine.
 *
 * Zero-policy default: all methods return immediately when maps are empty,
 * creating no telemetry spans and emitting no events.
 */
export class PolicyEngine {
  private readonly rules = new Map<string, PolicyRule>();
  private readonly guardrails: Guardrail[] = [];
  private readonly rateLimits = new Map<string, RateLimitConfig>();
  private readonly accessPolicies = new Map<string, AccessPolicy>();
  private readonly tenants = new Map<string, TenantConfig>();

  private readonly rateLimiter = new RateLimiter();

  private readonly instrumentation: EngineInstrumentation;
  private readonly emitEvent: (type: string, payload: unknown) => void;

  constructor(
    config: PolicyConfig | undefined,
    instrumentation: EngineInstrumentation,
    emitEvent: (type: string, payload: unknown) => void,
  ) {
    this.instrumentation = instrumentation;
    this.emitEvent = emitEvent;

    // Initialize from config if provided
    if (config) {
      if (config.rules) {
        for (const rule of config.rules) {
          this.rules.set(rule.name, rule);
        }
      }
      if (config.guardrails) {
        for (const guardrail of config.guardrails) {
          this.guardrails.push(guardrail);
        }
      }
      if (config.rateLimits) {
        for (const rl of config.rateLimits) {
          this.rateLimits.set(rl.name, rl);
        }
      }
      if (config.accessPolicies) {
        for (const ap of config.accessPolicies) {
          this.accessPolicies.set(ap.identity, ap);
        }
      }
      if (config.tenants) {
        for (const tc of config.tenants) {
          this.tenants.set(tc.tenantId, tc);
        }
      }
    }
  }

  /** Check if any policies are configured */
  private hasAnyPolicies(): boolean {
    return (
      this.rules.size > 0 ||
      this.guardrails.length > 0 ||
      this.rateLimits.size > 0 ||
      this.accessPolicies.size > 0 ||
      this.tenants.size > 0
    );
  }

  /**
   * Evaluate pre-execution policy checks: access control → rate limits → policy rules.
   * Returns modified input (if any rules modify it), or the original input.
   * Throws EngineError with appropriate code on denial.
   *
   * Zero-policy default: returns immediately without creating spans when no policies configured.
   */
  async evaluatePreExecution(
    context: PolicyContext,
    skipRateLimits: boolean = false,
  ): Promise<unknown> {
    if (!this.hasAnyPolicies()) {
      return context.input;
    }

    let currentInput = context.input;

    // Step 1: Access control
    if (this.accessPolicies.size > 0) {
      const accessResult = evaluateAccess(
        this.accessPolicies,
        context.userId,
        context.tenantId,
        context.operation,
        context.flowName,
      );
      if (!accessResult.allowed) {
        throw new EngineError(
          `Access denied: ${accessResult.reason ?? 'operation not permitted'}`,
          'ACCESS_DENIED',
        );
      }
    }

    // Step 2: Rate limits
    if (!skipRateLimits && this.rateLimits.size > 0) {
      // Find all applicable rate limit configs for this request
      const applicableConfigs = Array.from(this.rateLimits.values()).filter((rl) => {
        // Global scope always applies
        if (rl.scope === 'global') return true;
        // Flow scope applies if flowName matches or config has no flowName restriction
        if (rl.scope === 'flow') return true;
        // User scope applies if userId is present
        if (rl.scope === 'user') return context.userId != null;
        return true;
      });

      if (applicableConfigs.length > 0) {
        try {
          await this.rateLimiter.checkMultiple(
            applicableConfigs,
            context.userId,
            context.flowName,
          );
        } catch (error) {
          if (error instanceof EngineError && error.code === 'RATE_LIMITED') {
            // Emit policy:rate_limited event for the first applicable config
            const config = applicableConfigs[0];
            this.emitEvent('policy:rate_limited', {
              rateLimitName: config.name,
              scope: config.scope,
              flowName: context.flowName,
              userId: context.userId,
              tenantId: context.tenantId,
              limit: config.limit,
              windowMs: config.windowMs,
              currentCount: this.rateLimiter.getCurrentCount(config, context.userId, context.flowName),
              behavior: config.behavior ?? 'reject',
              timestamp: new Date(),
            });
          }
          throw error;
        }
      }
    }

    // Step 3: Policy rules evaluation
    if (this.rules.size > 0) {
      const rules = Array.from(this.rules.values());
      const decision = evaluateRules(rules, { ...context, input: currentInput });

      if (decision.action === 'deny') {
        // Emit policy:violation event
        this.emitEvent('policy:violation', {
          ruleName: decision.ruleName ?? 'unknown',
          operation: context.operation,
          flowName: context.flowName,
          userId: context.userId,
          tenantId: context.tenantId,
          reason: decision.reason ?? 'Policy denied',
          timestamp: new Date(),
        });

        throw new EngineError(
          `Policy denied: ${decision.reason ?? 'operation blocked by policy rule'}`,
          'POLICY_DENIED',
        );
      }

      if (decision.action === 'modify' && decision.modifiedInput !== undefined) {
        currentInput = decision.modifiedInput;
      }
    }

    return currentInput;
  }

  /**
   * Evaluate input guardrails on content before handler execution.
   * Returns modified content (if any guardrails transform it), or the original content.
   * Throws GUARDRAIL_BLOCKED if a block-mode guardrail blocks.
   *
   * Zero-policy default: returns immediately when no guardrails configured.
   */
  async evaluateInputGuardrails(
    content: unknown,
    context: GuardrailContext,
  ): Promise<unknown> {
    if (this.guardrails.length === 0) {
      return content;
    }

    const { content: result, warnings } = await runGuardrails(
      this.guardrails,
      content,
      { ...context, phase: 'input' },
    );

    // Emit policy:warning events for each warning
    for (const w of warnings) {
      this.emitEvent('policy:warning', {
        guardrailName: w.guardrailName,
        phase: w.phase,
        flowName: context.flowName,
        userId: context.userId,
        tenantId: context.tenantId,
        reason: w.reason,
        timestamp: new Date(),
      });
    }

    return result;
  }

  /**
   * Evaluate output guardrails on result after handler execution.
   * Returns modified content (if any guardrails transform it), or the original content.
   * Throws GUARDRAIL_BLOCKED if a block-mode guardrail blocks.
   *
   * Zero-policy default: returns immediately when no guardrails configured.
   */
  async evaluateOutputGuardrails(
    content: unknown,
    context: GuardrailContext,
  ): Promise<unknown> {
    if (this.guardrails.length === 0) {
      return content;
    }

    const { content: result, warnings } = await runGuardrails(
      this.guardrails,
      content,
      { ...context, phase: 'output' },
    );

    // Emit policy:warning events for each warning
    for (const w of warnings) {
      this.emitEvent('policy:warning', {
        guardrailName: w.guardrailName,
        phase: w.phase,
        flowName: context.flowName,
        userId: context.userId,
        tenantId: context.tenantId,
        reason: w.reason,
        timestamp: new Date(),
      });
    }

    return result;
  }

  // ── Policy Rule Management ──

  /** Register a policy rule. Throws DUPLICATE_POLICY if name already exists. */
  addPolicy(rule: PolicyRule): void {
    if (this.rules.has(rule.name)) {
      throw new EngineError(
        `Policy rule "${rule.name}" already exists.`,
        'DUPLICATE_POLICY',
      );
    }
    if (!rule.operations || rule.operations.length === 0) {
      throw new EngineError(
        `Policy rule "${rule.name}" must have at least one operation.`,
        'INVALID_POLICY_CONFIG',
      );
    }
    this.rules.set(rule.name, rule);
  }

  /** Remove a policy rule by name. No-op if not found. */
  removePolicy(name: string): void {
    this.rules.delete(name);
  }

  // ── Guardrail Management ──

  /** Register a guardrail. Throws DUPLICATE_GUARDRAIL if name already exists. */
  addGuardrail(guardrail: Guardrail): void {
    if (this.guardrails.some((g) => g.name === guardrail.name)) {
      throw new EngineError(
        `Guardrail "${guardrail.name}" already exists.`,
        'DUPLICATE_GUARDRAIL',
      );
    }
    this.guardrails.push(guardrail);
  }

  /** Remove a guardrail by name. No-op if not found. */
  removeGuardrail(name: string): void {
    const idx = this.guardrails.findIndex((g) => g.name === name);
    if (idx !== -1) {
      this.guardrails.splice(idx, 1);
    }
  }

  // ── Rate Limit Management ──

  /** Register a rate limit. Throws DUPLICATE_RATE_LIMIT if name already exists. */
  addRateLimit(config: RateLimitConfig): void {
    if (this.rateLimits.has(config.name)) {
      throw new EngineError(
        `Rate limit "${config.name}" already exists.`,
        'DUPLICATE_RATE_LIMIT',
      );
    }
    if (!config.limit || config.limit <= 0) {
      throw new EngineError(
        `Rate limit "${config.name}" must have limit > 0.`,
        'INVALID_POLICY_CONFIG',
      );
    }
    if (!config.windowMs || config.windowMs <= 0) {
      throw new EngineError(
        `Rate limit "${config.name}" must have windowMs > 0.`,
        'INVALID_POLICY_CONFIG',
      );
    }
    this.rateLimits.set(config.name, config);
  }

  /** Remove a rate limit by name. Releases any queued requests. No-op if not found. */
  removeRateLimit(name: string): void {
    if (this.rateLimits.has(name)) {
      this.rateLimiter.releaseQueued(name);
      this.rateLimits.delete(name);
    }
  }

  // ── Access Policy Management ──

  /** Set an access policy for an identity. Overwrites if identity already has a policy. */
  setAccessPolicy(policy: AccessPolicy): void {
    this.accessPolicies.set(policy.identity, policy);
  }

  /** Remove an access policy by identity. No-op if not found. */
  removeAccessPolicy(identity: string): void {
    this.accessPolicies.delete(identity);
  }

  // ── Tenant Configuration ──

  /** Set tenant configuration. Overwrites if tenantId already configured. */
  setTenantConfig(config: TenantConfig): void {
    this.tenants.set(config.tenantId, config);
  }

  /** Remove tenant configuration. No-op if not found. */
  removeTenantConfig(tenantId: string): void {
    this.tenants.delete(tenantId);
  }

  /** Get tenant configuration for a resolved tenant ID. Returns undefined if not found. */
  getTenantConfig(tenantId: string | null): TenantConfig | undefined {
    if (!tenantId) return undefined;
    return this.tenants.get(tenantId);
  }

  /** Resolve tenant identity: explicit tenantId → userId → null */
  resolveTenantId(tenantId?: string, userId?: string): string | null {
    if (tenantId) return tenantId;
    if (userId) return userId;
    return null;
  }

  /** Clear all policy state. Rejects queued rate limit requests. */
  clear(): void {
    this.rateLimiter.clear();
  }
}
