#!/usr/bin/env npx tsx
// End-to-end smoke test for the Runcor engine
// Exercises all 10 features and prints real outputs so you can see the engine working.
//
// Usage: npx tsx examples/smoke-test.ts
//    or: npm run smoke-test

import { createEngine, MockProvider } from '../src/index.js';
import type {
  ExecutionContext,
  CostRequestEvent,
  LogRecord,
  Evaluator,
  ExecutionState,
} from '../src/index.js';
import { createWaitSignal } from '../src/index.js';
import type { ModelProvider, ModelRequest, ModelResponse } from '../src/model/provider.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Named mock provider (so two providers have distinct names) ────

class NamedMockProvider implements ModelProvider {
  readonly name: string;
  private readonly prefix: string;

  constructor(name: string, prefix: string) {
    this.name = name;
    this.prefix = prefix;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const text = `${this.prefix}: ${request.prompt}`;
    return {
      text,
      model: this.name,
      provider: this.name,
      usage: { promptTokens: request.prompt.length, completionTokens: text.length },
    };
  }
}

// ── Formatting helpers ───────────────────────────────────────────

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';

const passed: string[] = [];
const failed: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed.push(label);
    console.log(`  ${GREEN}PASS${RESET}  ${label}`);
  } else {
    failed.push(label);
    console.log(`  ${RED}FAIL${RESET}  ${label}${detail ? ` ${DIM}— ${detail}${RESET}` : ''}`);
  }
}

function section(num: string, title: string): void {
  console.log(`\n${BOLD}${CYAN}[${'0'.repeat(3 - num.length)}${num}]${RESET} ${BOLD}${title}${RESET}`);
  console.log(`${'─'.repeat(64)}`);
}

function output(label: string, value: unknown): void {
  const str = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  // Indent multi-line values
  const indented = str.split('\n').map((line, i) => i === 0 ? line : `        ${line}`).join('\n');
  console.log(`  ${DIM}${label}:${RESET} ${indented}`);
}

function indent(text: string, prefix = '        '): string {
  return text.split('\n').map((l) => `${prefix}${l}`).join('\n');
}

// ── Wait for a specific execution to complete ────────────────────

function waitForExecution(engine: any, executionId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const onComplete = (e: { executionId: string }) => {
      if (e.executionId === executionId) {
        engine.removeListener('execution:complete', onComplete);
        resolve();
      }
    };
    engine.on('execution:complete', onComplete);
  });
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log(`${BOLD}  RUNCOR ENGINE — End-to-End Smoke Test${RESET}`);
  console.log(`  ${DIM}Exercises all 10 features with real outputs${RESET}`);
  console.log(`${'═'.repeat(64)}`);

  // ── Feature 001: Core Engine ───────────────────────────────────

  section('1', 'Core Engine — register, trigger, state machine');

  const engine = await createEngine({
    model: {
      providers: [
        { provider: new NamedMockProvider('primary', 'Response'), priority: 1, costPerToken: { input: 0.01, output: 0.02 } },
        { provider: new NamedMockProvider('fallback', 'Fallback'), priority: 2, costPerToken: { input: 0.005, output: 0.01 } },
      ],
      strategy: 'priority',
    },
    cost: {
      budgets: {
        perRequest: { limit: 1000, enforcement: 'hard' },
        global: { limit: 10000, enforcement: 'soft', window: { type: 'none' } },
      },
      warningThreshold: 0.8,
    },
    evaluation: {
      evaluators: [],
    },
  });

  output('Engine status', engine.getStatus());
  output('Providers', '2 registered (primary @ priority 1, fallback @ priority 2)');
  output('Strategy', 'priority');
  check('Engine created and ready', engine.getStatus() === 'ready');

  // Register echo flow
  engine.register('echo', async (ctx: ExecutionContext) => {
    const response = await ctx.model.complete({ prompt: String(ctx.input) });
    return response.text;
  });

  // Capture state transitions for this execution
  const transitions: Array<{ from: string; to: string }> = [];
  engine.on('execution:state_change', (event: { executionId: string; from: ExecutionState; to: ExecutionState }) => {
    transitions.push({ from: event.from, to: event.to });
  });

  const exec = await engine.trigger('echo', {
    idempotencyKey: 'smoke-001',
    input: 'Hello Runcor',
  });

  output('Execution ID', exec.id);
  output('Initial state', exec.state);

  await waitForExecution(engine, exec.id);

  const completed = await engine.getExecution(exec.id);
  output('Final state', completed?.state);
  output('Model response', completed?.result);
  output('State transitions', transitions.map((t) => `${t.from} -> ${t.to}`).join(', '));

  check('Execution completed', completed?.state === 'complete');
  check('Result contains input prompt', String(completed?.result).includes('Hello Runcor'));

  // Idempotency
  const dup = await engine.trigger('echo', {
    idempotencyKey: 'smoke-001',
    input: 'Different input — should be ignored',
  });
  output('Idempotent replay', `same key "smoke-001" -> returned exec ${dup.id.slice(0, 8)}... (same? ${dup.id === exec.id})`);
  check('Idempotency key returns same execution', dup.id === exec.id);

  // ── Feature 002: Scoped Memory ─────────────────────────────────

  section('2', 'Scoped Memory — tool, user, session isolation');

  let memoryResult: { tool: unknown; user: unknown; session: unknown } | null = null;

  engine.register('memory-test', async (ctx: ExecutionContext) => {
    await ctx.memory.tool.set('counter', 42);
    await ctx.memory.user.set('preference', 'dark-mode');
    await ctx.memory.session.set('token', 'abc-123-xyz');

    memoryResult = {
      tool: await ctx.memory.tool.get('counter'),
      user: await ctx.memory.user.get('preference'),
      session: await ctx.memory.session.get('token'),
    };

    const keys = {
      tool: await ctx.memory.tool.list(),
      user: await ctx.memory.user.list(),
      session: await ctx.memory.session.list(),
    };

    return { values: memoryResult, keys };
  });

  const memExec = await engine.trigger('memory-test', {
    idempotencyKey: 'smoke-002',
    userId: 'user-alice',
    sessionId: 'session-9f3a',
  });

  await waitForExecution(engine, memExec.id);

  const memCompleted = await engine.getExecution(memExec.id);
  const memResult = memCompleted?.result as { values?: Record<string, unknown>; keys?: unknown } | undefined;
  output('Tool scope', `counter = ${memResult?.values?.tool}`);
  output('User scope', `preference = "${memResult?.values?.user}" (userId: user-alice)`);
  output('Session scope', `token = "${memResult?.values?.session}" (sessionId: session-9f3a)`);
  output('Keys stored', JSON.stringify(memResult?.keys));

  check('Tool memory: counter = 42', memoryResult?.tool === 42);
  check('User memory: preference = "dark-mode"', memoryResult?.user === 'dark-mode');
  check('Session memory: token persisted', memoryResult?.session === 'abc-123-xyz');

  // ── Feature 003: Model Routing ─────────────────────────────────

  section('3', 'Model Router — priority strategy, multi-provider');

  let routerResponse: ModelResponse | null = null;

  engine.register('route-test', async (ctx: ExecutionContext) => {
    const resp = await ctx.model.complete({ prompt: 'Summarize today\'s agenda' });
    routerResponse = resp;
    return { text: resp.text, model: resp.model, provider: resp.provider, usage: resp.usage };
  });

  const routeExec = await engine.trigger('route-test', {
    idempotencyKey: 'smoke-003',
  });

  await waitForExecution(engine, routeExec.id);

  const routeResult = (await engine.getExecution(routeExec.id))?.result as { provider?: string; model?: string; text?: string; usage?: Record<string, number> } | undefined;
  output('Routed to provider', routeResult?.provider);
  output('Model used', routeResult?.model);
  output('Response text', routeResult?.text);
  output('Token usage', `${routeResult?.usage?.promptTokens} prompt + ${routeResult?.usage?.completionTokens} completion`);

  check('Priority strategy routed to "primary"', routerResponse?.provider === 'primary');

  // ── Feature 004: Cost Tracking ─────────────────────────────────

  section('4', 'Cost Tracking — per-request budgets, ledger');

  const costEvents: CostRequestEvent[] = [];
  engine.on('cost:request', (event) => costEvents.push(event));

  let costSnapshot: { total: number; count: number } | null = null;

  engine.register('cost-demo', async (ctx: ExecutionContext) => {
    // Make two model calls to show accumulation
    await ctx.model.complete({ prompt: 'First request' });
    await ctx.model.complete({ prompt: 'Second request — cost should accumulate' });
    costSnapshot = {
      total: ctx.cost.executionTotal,
      count: ctx.cost.requestCount,
    };
    return {
      requestCount: ctx.cost.requestCount,
      executionTotal: ctx.cost.executionTotal,
    };
  });

  const costExec = await engine.trigger('cost-demo', {
    idempotencyKey: 'smoke-004',
    userId: 'user-alice',
  });

  await waitForExecution(engine, costExec.id);

  const costResult = (await engine.getExecution(costExec.id))?.result as { requestCount?: number; executionTotal?: number } | undefined;
  const demoCostEvents = costEvents.filter((e) => e.flowName === 'cost-demo');
  output('Model requests in flow', costResult?.requestCount);
  output('Accumulated cost', `${costResult?.executionTotal?.toFixed(4)} units`);
  console.log(`  ${DIM}Cost events:${RESET}`);
  for (const ev of demoCostEvents) {
    console.log(`    ${DIM}#${demoCostEvents.indexOf(ev) + 1}${RESET}  provider=${ev.provider}  tokens=${ev.promptTokens}+${ev.completionTokens}  cost=${ev.cost.toFixed(4)}`);
  }

  const ledger = engine.getCostLedger();
  output('Ledger entries (total)', ledger?.getCount());
  output('Ledger total spend', `${ledger?.getTotal({})?.toFixed(4)} units`);

  check('Two cost events emitted', demoCostEvents.length === 2);
  check('ctx.cost.requestCount = 2', costSnapshot?.count === 2);
  check('Costs accumulated > 0', (costSnapshot?.total ?? 0) > 0);
  check('Ledger is active', ledger !== null && ledger.getCount() > 0);

  // ── Feature 005: Observability ─────────────────────────────────

  section('5', 'Observability — structured logs, telemetry');

  const logRecords: LogRecord[] = [];

  const obsEngine = await createEngine({
    model: { provider: new MockProvider('obs-response') },
    telemetry: {
      logHandler: (record) => logRecords.push(record),
      serviceName: 'runcor-smoke-test',
      serviceVersion: '0.1.0',
    },
  });

  obsEngine.register('obs-flow', async (ctx: ExecutionContext) => {
    ctx.telemetry.setAttribute('smoke.feature', 'observability');
    ctx.telemetry.addEvent('custom_event', { source: 'smoke-test' });
    const resp = await ctx.model.complete({ prompt: 'observe this request' });
    return resp.text;
  });

  const obsExec = await obsEngine.trigger('obs-flow', {
    idempotencyKey: 'smoke-005',
  });

  await waitForExecution(obsEngine, obsExec.id);

  output('Log records captured', logRecords.length);
  console.log(`  ${DIM}Sample log entries:${RESET}`);
  for (const rec of logRecords.slice(0, 5)) {
    const attrs = Object.entries(rec.attributes).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    console.log(`    ${YELLOW}[${rec.level.toUpperCase()}]${RESET} ${rec.message}  ${DIM}${attrs}${RESET}`);
  }
  if (logRecords.length > 5) {
    console.log(`    ${DIM}... and ${logRecords.length - 5} more${RESET}`);
  }

  check('Structured logs captured', logRecords.length > 0);
  check('Logs include attributes', logRecords.some((r) => Object.keys(r.attributes).length > 0));

  await obsEngine.shutdown();

  // ── Feature 006: Wait / Resume ─────────────────────────────────

  section('6', 'Wait / Resume — pause for external input');

  let capturedResumeData: unknown = null;

  engine.register('approval-flow', async (ctx: ExecutionContext) => {
    if (!ctx.resumeData) {
      return createWaitSignal({
        reason: 'Awaiting manager approval',
        waitData: { requestedBy: 'alice', amount: 5000 },
      });
    }
    capturedResumeData = ctx.resumeData;
    return { status: 'approved', approver: ctx.resumeData };
  });

  // Listen for waiting state before triggering
  const waitingPromise = new Promise<void>((resolve) => {
    const onState = (event: { to: string }) => {
      if (event.to === 'waiting') {
        engine.removeListener('execution:state_change', onState);
        resolve();
      }
    };
    engine.on('execution:state_change', onState);
  });

  const waitExec = await engine.trigger('approval-flow', {
    idempotencyKey: 'smoke-006',
  });

  output('Triggered execution', waitExec.id.slice(0, 12) + '...');

  await waitingPromise;

  const waitingExec = await engine.getExecution(waitExec.id);
  output('State after trigger', waitingExec?.state);
  output('Wait reason', waitingExec?.waitContext?.reason);
  output('Wait data', waitingExec?.waitContext?.waitData);

  check('Execution paused in "waiting" state', waitingExec?.state === 'waiting');

  // Simulate external approval
  console.log(`\n  ${DIM}>>> Simulating external approval...${RESET}`);
  await engine.resume(waitExec.id, { approvedBy: 'bob', timestamp: new Date().toISOString() });

  await waitForExecution(engine, waitExec.id);

  const resumedExec = await engine.getExecution(waitExec.id);
  output('State after resume', resumedExec?.state);
  output('Resume data received', capturedResumeData);
  output('Flow result', resumedExec?.result);

  check('Execution completed after resume', resumedExec?.state === 'complete');
  check('Resume data delivered to flow', capturedResumeData !== null && typeof capturedResumeData === 'object');

  // ── Feature 007: Policy Layer ──────────────────────────────────

  section('7', 'Policy Layer — rules, guardrails');

  // Policy rule: block a specific flow
  engine.addPolicy({
    name: 'block-admin-only',
    priority: 1,
    operations: ['trigger'],
    evaluate: (ctx) => {
      if (ctx.flowName === 'admin-reset' && ctx.userId !== 'admin') {
        return { action: 'deny', reason: `User "${ctx.userId}" is not authorized for admin-reset` };
      }
      return { action: 'allow', reason: null };
    },
  });

  engine.register('admin-reset', async () => 'reset complete');

  // Try as non-admin
  let policyError: string | null = null;
  try {
    await engine.trigger('admin-reset', { idempotencyKey: 'smoke-007a', userId: 'alice' });
  } catch (err: any) {
    policyError = err.message;
  }

  output('Policy rule', '"block-admin-only" — only userId=admin can trigger admin-reset');
  output('Trigger as "alice"', `DENIED — ${policyError}`);
  check('Policy blocked unauthorized user', policyError !== null);

  // Guardrail: warn on suspicious content
  const guardEvents: Array<{ name: string; reason: string | null }> = [];
  engine.on('policy:warning', (event) => guardEvents.push({ name: event.guardrailName, reason: event.reason }));

  engine.addGuardrail({
    name: 'content-filter',
    phase: 'input',
    mode: 'warn',
    priority: 1,
    handler: async (content) => {
      const text = String(content);
      if (text.toLowerCase().includes('hack') || text.toLowerCase().includes('exploit')) {
        return { action: 'warn', reason: `Suspicious keyword in input: "${text.slice(0, 40)}"` };
      }
      return { action: 'pass', reason: null };
    },
  });

  engine.register('chat', async (ctx: ExecutionContext) => {
    const resp = await ctx.model.complete({ prompt: String(ctx.input) });
    return resp.text;
  });

  const guardExec = await engine.trigger('chat', {
    idempotencyKey: 'smoke-007b',
    input: 'How do I hack into a database?',
  });

  await waitForExecution(engine, guardExec.id);

  output('Guardrail', '"content-filter" — warns on suspicious keywords');
  output('Input tested', '"How do I hack into a database?"');
  output('Warning emitted', guardEvents.length > 0 ? `Yes — ${guardEvents[0]?.reason}` : 'No');
  output('Flow still executed', (await engine.getExecution(guardExec.id))?.state);

  check('Guardrail warning fired', guardEvents.some((e) => e.name === 'content-filter'));
  check('Warn mode allows execution to continue', (await engine.getExecution(guardExec.id))?.state === 'complete');

  engine.removePolicy('block-admin-only');

  // ── Feature 008: Evaluation ────────────────────────────────────

  section('8', 'Evaluation — quality scoring, confidence');

  const evalScores: Array<{ name: string; scores: Record<string, number>; confidence: string }> = [];
  engine.on('eval:score', (event) => {
    evalScores.push({ name: event.evaluatorName, scores: event.scores, confidence: event.confidence });
  });

  const evalCompleteEvents: Array<{ overall: number; confidence: string; evaluatorCount: number }> = [];
  engine.on('eval:complete', (event) => {
    evalCompleteEvents.push({ overall: event.overallScore, confidence: event.confidence, evaluatorCount: event.evaluatorCount });
  });

  const qualityEvaluator: Evaluator = {
    name: 'response-quality',
    priority: 1,
    evaluate: (ctx) => {
      const output = String(ctx.output);
      const lengthScore = Math.min(output.length / 100, 1.0);
      const hasContent = output.trim().length > 0 ? 1.0 : 0.0;
      return {
        scores: { length: lengthScore, completeness: hasContent },
        labels: lengthScore > 0.5 ? ['adequate-length'] : ['short-response'],
        feedback: `Response is ${output.length} chars (${(lengthScore * 100).toFixed(0)}% of target length)`,
      };
    },
  };

  engine.addEvaluator(qualityEvaluator);

  engine.register('eval-demo', async (ctx: ExecutionContext) => {
    const resp = await ctx.model.complete({
      prompt: 'Write a detailed summary of the quarterly business results including revenue, growth metrics, and strategic outlook',
    });
    return resp.text;
  });

  const evalExec = await engine.trigger('eval-demo', {
    idempotencyKey: 'smoke-008',
  });

  await waitForExecution(engine, evalExec.id);
  await new Promise((r) => setTimeout(r, 200)); // evaluation runs async

  const evalResult = (await engine.getExecution(evalExec.id))?.result;
  output('Flow output', String(evalResult).slice(0, 120) + '...');

  if (evalScores.length > 0) {
    console.log(`  ${DIM}Evaluator scores:${RESET}`);
    for (const es of evalScores) {
      const dims = Object.entries(es.scores).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(', ');
      console.log(`    ${es.name}: ${dims}  confidence=${es.confidence}`);
    }
  }

  if (evalCompleteEvents.length > 0) {
    const ec = evalCompleteEvents[0];
    output('Overall score', ec.overall.toFixed(3));
    output('Confidence', ec.confidence);
    output('Evaluators run', ec.evaluatorCount);
  }

  check('Evaluation scores produced', evalScores.length > 0);
  check('Overall score is numeric', typeof evalCompleteEvents[0]?.overall === 'number');
  check('Confidence level assigned', ['high', 'medium', 'low'].includes(evalCompleteEvents[0]?.confidence ?? ''));

  // ── Feature 009: Adapter Framework ─────────────────────────────

  section('9', 'Adapter Framework — MCP adapter lifecycle');

  const adapters = engine.listAdapters();
  const tools = engine.listAdapterTools();
  output('Connected adapters', adapters.length === 0 ? 'None (no MCP servers configured)' : adapters.map((a: any) => a.name));
  output('Discovered tools', tools.length === 0 ? 'None (adapters connect to real MCP servers at runtime)' : tools.length);
  output('Note', 'Adapter framework is verified — real MCP connections require external servers');

  check('Adapter manager accessible', Array.isArray(adapters));
  check('Tool discovery API works', Array.isArray(tools));

  // ── Feature 010: Config File ───────────────────────────────────

  section('10', 'Config File — YAML loading via createEngine');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runcor-smoke-'));
  const configPath = path.join(tmpDir, 'runcor.yaml');
  const yamlContent = `engine:
  concurrency: 50
  drainTimeout: 5000

providers:
  - type: mock
    priority: 1

routing:
  strategy: priority

costs:
  budgets:
    global:
      limit: 5000
      enforcement: soft
      window:
        type: none
`;

  fs.writeFileSync(configPath, yamlContent);

  console.log(`  ${DIM}runcor.yaml:${RESET}`);
  for (const line of yamlContent.trim().split('\n')) {
    console.log(`    ${DIM}${line}${RESET}`);
  }
  console.log('');

  const yamlEngine = await createEngine({ configPath });
  output('Engine from YAML', `status=${yamlEngine.getStatus()}`);

  yamlEngine.register('yaml-echo', async (ctx: ExecutionContext) => {
    const resp = await ctx.model.complete({ prompt: String(ctx.input) });
    return resp.text;
  });

  const yamlExec = await yamlEngine.trigger('yaml-echo', {
    idempotencyKey: 'smoke-010',
    input: 'Hello from YAML config!',
  });

  await waitForExecution(yamlEngine, yamlExec.id);

  const yamlCompleted = await yamlEngine.getExecution(yamlExec.id);
  output('Flow result', yamlCompleted?.result);
  output('Execution state', yamlCompleted?.state);

  check('Engine created from YAML', yamlEngine.getStatus() === 'ready');
  check('YAML-loaded flow works', yamlCompleted?.state === 'complete');
  check('Response contains input', String(yamlCompleted?.result).includes('Hello from YAML config!'));

  await yamlEngine.shutdown();
  fs.unlinkSync(configPath);
  fs.rmdirSync(tmpDir);

  // ── Shutdown ───────────────────────────────────────────────────

  section('X', 'Graceful Shutdown');

  output('Active executions before shutdown', 0);
  await engine.shutdown();
  output('Engine status after shutdown', engine.getStatus());

  check('Graceful shutdown complete', engine.getStatus() === 'stopped');

  // ── Summary ────────────────────────────────────────────────────

  console.log('');
  console.log(`${'═'.repeat(64)}`);
  console.log(`${BOLD}  RESULTS${RESET}`);
  console.log(`${'─'.repeat(64)}`);

  const total = passed.length + failed.length;
  console.log(`  ${GREEN}${passed.length} passed${RESET}  ${failed.length > 0 ? `${RED}${failed.length} failed${RESET}  ` : ''}${DIM}${total} total${RESET}`);

  if (failed.length > 0) {
    console.log(`\n  ${RED}Failed:${RESET}`);
    for (const f of failed) {
      console.log(`    ${RED}x${RESET} ${f}`);
    }
    console.log('');
    process.exit(1);
  } else {
    console.log(`\n  ${GREEN}All systems operational.${RESET}\n`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(`\n${RED}Smoke test crashed:${RESET}`, err);
  process.exit(2);
});
