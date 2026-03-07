// Runcor Demo Server
// Wraps a Runcor engine instance and serves a live dashboard at localhost:3000
// Uses the built-in dashboard (Feature 021) with real-time SSE updates.
// Connect Claude Code via MCP to register and trigger flows while watching them execute.

import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  createEngine,
  AnthropicProvider,
  OpenAIProvider,
  GoogleProvider,
  MockProvider,
} from '../src/index.js';
import type { Execution } from '../src/index.js';
import type { AdapterConfig } from '../src/index.js';
import { createAgentHandler } from '../src/agent/handler.js';
import { ManagedAdapter } from '../src/adapter/managed-adapter.js';
import type { MCPClient, MCPTransport, MCPClientFactory } from '../src/adapter/managed-adapter.js';
import { startDemoSimulation } from './simulation.js';

// Built-in dashboard HTML + route factories from the engine's HTTP module
import { DASHBOARD_HTML } from '../src/http/dashboard-html.js';
import { createHealthRoutes } from '../src/http/routes/health.js';
import { createFlowRoutes } from '../src/http/routes/flows.js';
import { createExecutionRoutes } from '../src/http/routes/executions.js';
import { createAdapterRoutes } from '../src/http/routes/adapters.js';
import { createProviderRoutes } from '../src/http/routes/providers.js';
import { createCostRoutes } from '../src/http/routes/cost.js';
import { createDiscernmentRoutes } from '../src/http/routes/discernment.js';
import { createEventRoutes } from '../src/http/routes/events.js';
import { createSSEManager } from '../src/http/sse.js';

// Track flow types (prompt vs agent)
const flowTypes = new Map<string, string>();

// ── Engine setup ───────────────────────────────────────────────────────────────
async function boot() {
  const isDemoMode = process.env.DEMO_MODE === 'true';
  const simTimers: ReturnType<typeof setTimeout>[] = [];

  // Decide provider based on env
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const googleKey = process.env.GOOGLE_API_KEY;

  const providers: Array<{ provider: AnthropicProvider | OpenAIProvider | GoogleProvider | MockProvider; priority: number; costPerToken?: { input: number; output: number } }> = [];

  if (anthropicKey) {
    const client = new Anthropic({ apiKey: anthropicKey });
    const p = new AnthropicProvider(client);
    providers.push({ provider: p, priority: 1 });
    console.log('[dashboard] Registered provider: anthropic');
  }

  if (openaiKey) {
    const client4o = new OpenAI({ apiKey: openaiKey });
    const clientMini = new OpenAI({ apiKey: openaiKey });
    const p4o = new OpenAIProvider(client4o, { defaultModel: 'gpt-4o' });
    const pMini = new OpenAIProvider(clientMini, { defaultModel: 'gpt-4o-mini' });
    providers.push({ provider: p4o, priority: 1, costPerToken: { input: 0.0000025, output: 0.00001 } });
    providers.push({ provider: pMini, priority: 2, costPerToken: { input: 0.00000015, output: 0.0000006 } });
    console.log('[dashboard] Registered provider: openai/gpt-4o (priority 1)');
    console.log('[dashboard] Registered provider: openai/gpt-4o-mini (priority 2)');
  }

  if (googleKey) {
    const aiFlash = new GoogleGenerativeAI(googleKey);
    const aiPro = new GoogleGenerativeAI(googleKey);
    const pFlash = new GoogleProvider(aiFlash, { defaultModel: 'gemini-2.0-flash' });
    const pPro = new GoogleProvider(aiPro, { defaultModel: 'gemini-2.5-pro' });
    providers.push({ provider: pFlash, priority: 3, costPerToken: { input: 0.0000001, output: 0.0000004 } });
    providers.push({ provider: pPro, priority: 4, costPerToken: { input: 0.00000125, output: 0.00001 } });
    console.log('[dashboard] Registered provider: google/gemini-2.0-flash (priority 3)');
    console.log('[dashboard] Registered provider: google/gemini-2.5-pro (priority 4)');
  }

  let mockProvidersRef: MockProvider[] = [];
  if (providers.length === 0) {
    // Create named mock providers so dashboard shows realistic provider names
    const mockAnthropic = new MockProvider('Claude response to: {prompt}');
    Object.defineProperty(mockAnthropic, 'name', { value: 'anthropic', writable: false });
    const mockOpenai = new MockProvider('GPT response to: {prompt}');
    Object.defineProperty(mockOpenai, 'name', { value: 'openai', writable: false });
    const mockGoogle = new MockProvider('Gemini response to: {prompt}');
    Object.defineProperty(mockGoogle, 'name', { value: 'google', writable: false });
    mockProvidersRef = [mockAnthropic, mockOpenai, mockGoogle];
    providers.push(
      { provider: mockAnthropic, priority: 1, costPerToken: { input: 0.000003, output: 0.000015 } },
      { provider: mockOpenai, priority: 2, costPerToken: { input: 0.0000025, output: 0.00001 } },
      { provider: mockGoogle, priority: 3, costPerToken: { input: 0.0000001, output: 0.0000004 } },
    );
    console.log('[dashboard] No API keys found. Using named mock providers (anthropic, openai, google) for demo.');
  }

  console.log('[dashboard] Creating engine...');
  let engine;
  try {
    const objectives = isDemoMode
      ? [
          { name: 'operational-visibility', description: 'Leadership has daily visibility into all business metrics' },
          { name: 'customer-retention', description: 'Reduce churn through proactive outreach and support' },
          { name: 'revenue-growth', description: 'Increase pipeline conversion and deal velocity' },
          { name: 'cost-optimization', description: 'Reduce operational spend through automation' },
          { name: 'compliance', description: 'Ensure regulatory compliance across all business processes' },
          { name: 'talent-acquisition', description: 'Hire and retain top talent efficiently' },
          { name: 'product-quality', description: 'Ship reliable software with minimal incidents' },
          { name: 'market-intelligence', description: 'Maintain competitive awareness and market positioning' },
          { name: 'cost-efficiency', description: 'Minimize AI spend while maintaining output quality' },
        ]
      : [
          { name: 'operational-visibility', description: 'Leadership has daily visibility into business metrics' },
          { name: 'customer-retention', description: 'Reduce support ticket volume through proactive outreach' },
          { name: 'cost-efficiency', description: 'Minimize AI spend while maintaining output quality' },
        ];

    engine = await createEngine({
      model: { providers, strategy: 'round-robin' },
      cost: {},
      concurrency: isDemoMode ? 50 : 20,
      server: { enabled: true, name: 'runcor-dashboard' },
      discernment: {
        enabled: true,
        autonomy: 'recommend',
        schedule: 'daily',
        objectives,
      },
    });
  } catch (err) {
    console.error('[dashboard] Engine creation failed:', err);
    throw err;
  }
  console.log('[dashboard] Engine created successfully');

  const providerNames = providers.map((p) => p.provider.name).join(', ');

  // ── Register mock adapters for dashboard connections panel ──────────────
  function createMockClientFactory(tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>): MCPClientFactory {
    return {
      createClient: async () => ({
        client: {
          listTools: async () => ({ tools }),
          listResources: async () => ({ resources: [] }),
          callTool: async () => ({ content: [{ type: 'text' as const, text: 'mock result' }], isError: false }),
          readResource: async () => ({ contents: [] }),
          close: async () => {},
        } satisfies MCPClient,
        transport: {
          close: async () => {},
        } satisfies MCPTransport,
      }),
    };
  }

  const adapterManager = (engine as any).adapterManager;
  const originalCreateAdapter = (adapterManager as any).createAdapter;
  const mockFactories: Record<string, MCPClientFactory> = {
    gmail: createMockClientFactory([
      { name: 'send_email', description: 'Send an email', inputSchema: { type: 'object' } },
      { name: 'read_email', description: 'Read an email by ID', inputSchema: { type: 'object' } },
      { name: 'search_emails', description: 'Search emails', inputSchema: { type: 'object' } },
      { name: 'list_labels', description: 'List email labels', inputSchema: { type: 'object' } },
    ]),
    slack: createMockClientFactory([
      { name: 'send_message', description: 'Send a Slack message', inputSchema: { type: 'object' } },
      { name: 'list_channels', description: 'List Slack channels', inputSchema: { type: 'object' } },
      { name: 'search_messages', description: 'Search Slack messages', inputSchema: { type: 'object' } },
    ]),
    'google-calendar': createMockClientFactory([
      { name: 'list_events', description: 'List calendar events', inputSchema: { type: 'object' } },
      { name: 'create_event', description: 'Create a calendar event', inputSchema: { type: 'object' } },
      { name: 'update_event', description: 'Update a calendar event', inputSchema: { type: 'object' } },
    ]),
    'google-drive': createMockClientFactory([
      { name: 'list_files', description: 'List files in Drive', inputSchema: { type: 'object' } },
      { name: 'upload_file', description: 'Upload a file to Drive', inputSchema: { type: 'object' } },
      { name: 'share_file', description: 'Share a file', inputSchema: { type: 'object' } },
      { name: 'search_files', description: 'Search Drive files', inputSchema: { type: 'object' } },
    ]),
    salesforce: createMockClientFactory([
      { name: 'query_records', description: 'Run a SOQL query', inputSchema: { type: 'object' } },
      { name: 'create_record', description: 'Create a Salesforce record', inputSchema: { type: 'object' } },
      { name: 'update_record', description: 'Update a Salesforce record', inputSchema: { type: 'object' } },
      { name: 'get_opportunity', description: 'Get opportunity details', inputSchema: { type: 'object' } },
      { name: 'list_contacts', description: 'List contacts', inputSchema: { type: 'object' } },
    ]),
    hubspot: createMockClientFactory([
      { name: 'create_contact', description: 'Create a HubSpot contact', inputSchema: { type: 'object' } },
      { name: 'create_deal', description: 'Create a deal', inputSchema: { type: 'object' } },
      { name: 'list_deals', description: 'List deals in pipeline', inputSchema: { type: 'object' } },
      { name: 'update_contact', description: 'Update contact properties', inputSchema: { type: 'object' } },
    ]),
    jira: createMockClientFactory([
      { name: 'create_issue', description: 'Create a Jira issue', inputSchema: { type: 'object' } },
      { name: 'search_issues', description: 'Search issues with JQL', inputSchema: { type: 'object' } },
      { name: 'update_issue', description: 'Update an issue', inputSchema: { type: 'object' } },
      { name: 'transition_issue', description: 'Transition issue status', inputSchema: { type: 'object' } },
    ]),
    github: createMockClientFactory([
      { name: 'create_pr', description: 'Create a pull request', inputSchema: { type: 'object' } },
      { name: 'list_issues', description: 'List repository issues', inputSchema: { type: 'object' } },
      { name: 'get_repo', description: 'Get repository info', inputSchema: { type: 'object' } },
    ]),
  };

  (adapterManager as any).createAdapter = (config: AdapterConfig) => {
    const factory = mockFactories[config.name];
    if (factory) return new ManagedAdapter(config, { clientFactory: factory });
    return originalCreateAdapter(config);
  };

  const adapterNames = Object.keys(mockFactories);
  for (const name of adapterNames) {
    await engine.addAdapter({ name, transport: 'sse', url: `http://mock/${name}`, healthCheckIntervalMs: 0 });
  }
  console.log(`[dashboard] Registered ${adapterNames.length} mock adapters (${adapterNames.join(', ')})`);

  // ── Pre-register demo flows ─────────────────────────────────────────────
  engine.register('daily-metrics', async (ctx) => {
    const result = await ctx.model.complete({
      prompt: 'Generate a brief daily metrics summary with 3 KPIs and their trend direction.',
    });
    return { report: result.text, generatedAt: new Date().toISOString() };
  }, {
    description: 'Daily metrics report for leadership',
    objective: 'operational-visibility',
  });

  engine.register('churn-alert', async (ctx) => {
    const input = ctx.input as { customerId?: string } | undefined;
    const result = await ctx.model.complete({
      prompt: `Analyze churn risk for customer ${input?.customerId ?? 'C-1234'}. Provide risk score 1-10 and recommended action.`,
    });
    return { analysis: result.text };
  }, {
    description: 'Customer churn risk analysis',
    objective: 'customer-retention',
  });

  engine.register('cost-report', async (ctx) => {
    const ledger = engine.getCostLedger();
    const total = ledger ? ledger.getTotal({}) : 0;
    const result = await ctx.model.complete({
      prompt: `Current AI spend: $${total.toFixed(4)}. Summarize cost efficiency and suggest optimizations.`,
    });
    return { costAnalysis: result.text, currentSpend: total };
  }, {
    description: 'AI cost efficiency report',
    objective: 'cost-efficiency',
  });

  engine.register('support-responder', async (ctx) => {
    const input = ctx.input as { ticket?: string } | undefined;
    const result = await ctx.model.complete({
      prompt: `Draft a response for support ticket: "${input?.ticket ?? 'Customer cannot log in'}". Be empathetic and actionable.`,
    });
    return { response: result.text };
  }, {
    description: 'Automated support ticket response',
    objective: 'customer-retention',
  });

  engine.register('weekly-summary', async (ctx) => {
    const result = await ctx.model.complete({
      prompt: 'Generate a weekly executive summary covering revenue, pipeline, and team velocity.',
    });
    return { summary: result.text };
  }, {
    description: 'Weekly executive summary',
    objective: 'operational-visibility',
  });

  console.log('[dashboard] Pre-registered 5 demo flows with objectives');

  // ── Hono server ───────────────────────────────────────────────────────────
  const app = new Hono();
  const startTime = Date.now();

  // Serve the built-in dashboard at / and /v1/dashboard
  app.get('/', (c) => c.html(DASHBOARD_HTML));

  // Mount all /v1/ API routes from the engine's HTTP module
  // These are the routes the built-in dashboard expects
  const sseMgr = createSSEManager(engine);
  app.route('/v1', createHealthRoutes(engine, startTime));
  app.route('/v1', createFlowRoutes(engine));
  app.route('/v1', createExecutionRoutes(engine));
  app.route('/v1', createAdapterRoutes(engine));
  app.route('/v1', createEventRoutes(sseMgr));
  app.route('/v1', createProviderRoutes(engine));
  app.route('/v1', createCostRoutes(engine));
  app.route('/v1', createDiscernmentRoutes(engine));
  app.get('/v1/dashboard', (c) => c.html(DASHBOARD_HTML));

  // ── Demo-specific mutation routes (not part of the built-in dashboard) ──

  // POST /api/register — register a flow on the fly
  app.post('/api/register', async (c) => {
    try {
      const body = await c.req.json();
      const {
        name,
        description,
        type,
        systemPrompt,
        promptTemplate,
        inputSchema,
        model,
        maxTokens,
        temperature,
        maxIterations,
      } = body;

      if (!name || typeof name !== 'string') {
        return c.json({ error: 'name is required' }, 400);
      }
      if (name.length > 100) {
        return c.json({ error: 'name must be 100 characters or fewer' }, 400);
      }
      if (type && type !== 'prompt' && type !== 'agent') {
        return c.json({ error: 'type must be "prompt" or "agent"' }, 400);
      }
      if (maxTokens !== undefined && (typeof maxTokens !== 'number' || maxTokens < 1 || maxTokens > 100000)) {
        return c.json({ error: 'maxTokens must be between 1 and 100000' }, 400);
      }
      if (temperature !== undefined && (typeof temperature !== 'number' || temperature < 0 || temperature > 2)) {
        return c.json({ error: 'temperature must be between 0 and 2' }, 400);
      }
      if (systemPrompt && typeof systemPrompt === 'string' && systemPrompt.length > 50000) {
        return c.json({ error: 'systemPrompt must be 50000 characters or fewer' }, 400);
      }
      if (promptTemplate && typeof promptTemplate === 'string' && promptTemplate.length > 50000) {
        return c.json({ error: 'promptTemplate must be 50000 characters or fewer' }, 400);
      }

      let handler: any;

      if (type === 'agent') {
        if (!systemPrompt) {
          return c.json({ error: 'systemPrompt is required for agent flows' }, 400);
        }
        handler = createAgentHandler({
          systemPrompt,
          maxIterations: maxIterations ?? 5,
          ...(model && { model }),
        });
      } else {
        if (!promptTemplate) {
          return c.json({ error: 'promptTemplate is required for prompt flows' }, 400);
        }
        handler = async (ctx: any) => {
          const input = ctx.input as Record<string, unknown>;

          const prompt = promptTemplate.replace(
            /\{\{(\w+)\}\}/g,
            (_: string, key: string) => String(input[key] ?? ''),
          );

          const response = await ctx.model.complete({
            prompt: systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt,
            ...(model && { model }),
            ...(maxTokens && { maxTokens }),
            ...(temperature !== undefined && { temperature }),
          });

          return {
            input,
            output: response.text,
            model: response.model,
            usage: {
              promptTokens: response.usage.promptTokens,
              completionTokens: response.usage.completionTokens,
            },
          };
        };
      }

      engine.register(name, handler, {
        description: description ?? name,
        inputSchema: inputSchema ?? { type: 'object' },
      });

      flowTypes.set(name, type ?? 'prompt');
      console.log(`[dashboard] Registered flow: ${name} (${type ?? 'prompt'})`);
      return c.json({ registered: name, type: type ?? 'prompt', description: description ?? name });
    } catch (err: any) {
      console.error('[dashboard] /api/register error:', err);
      const message = err?.code === 'DUPLICATE_FLOW' ? 'Flow already registered' : 'Registration failed';
      return c.json({ error: message }, 400);
    }
  });

  // DELETE /api/register/:flowName — unregister a flow
  app.delete('/api/register/:flowName', (c) => {
    try {
      const flowName = c.req.param('flowName');
      engine.unregister(flowName);
      flowTypes.delete(flowName);
      console.log(`[dashboard] Unregistered flow: ${flowName}`);
      return c.json({ unregistered: flowName });
    } catch (err: any) {
      console.error('[dashboard] /api/unregister error:', err);
      return c.json({ error: 'Unregistration failed' }, 400);
    }
  });

  // POST /api/trigger/:flowName — convenience trigger endpoint
  app.post('/api/trigger/:flowName', async (c) => {
    try {
      let body: Record<string, unknown> = {};
      try { body = await c.req.json(); } catch { /* empty body ok */ }

      const userId = (body.userId as string) || 'dashboard-user';
      delete body.userId;
      const execution = await engine.trigger(c.req.param('flowName'), {
        idempotencyKey: `dashboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        input: body,
        userId,
      });
      return c.json({ executionId: execution.id, state: execution.state });
    } catch (err: any) {
      console.error('[dashboard] /api/trigger error:', err);
      const message = err?.code === 'FLOW_NOT_FOUND' ? `Flow "${c.req.param('flowName')}" not found` : 'Trigger failed';
      return c.json({ error: message }, 400);
    }
  });

  const PORT = parseInt(process.env.PORT ?? process.env.DASHBOARD_PORT ?? '3000', 10);
  const hasRealKeys = !!(anthropicKey || openaiKey || googleKey);
  serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
    console.log('');
    console.log('  \u{1F680} Runcor Demo Server');
    console.log('');
    console.log(`  Dashboard:  http://localhost:${PORT}/`);
    console.log(`  Health:     http://localhost:${PORT}/v1/health`);
    console.log(`  API:        http://localhost:${PORT}/v1/`);
    console.log(`  Providers:  ${providerNames}${hasRealKeys ? '' : ' (mock mode)'}`);
    console.log('');
    console.log('  Register flows: POST /api/register');
    console.log('  Trigger flows:  POST /api/trigger/:flowName');
    console.log('');
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[dashboard] Shutting down...');
    for (const t of simTimers) clearTimeout(t);
    sseMgr.shutdown();
    await engine.shutdown();
    process.exit(0);
  });

  // ── Demo simulation (opt-in via DEMO_MODE=true) ───────────────────────────
  if (isDemoMode) {
    startDemoSimulation(engine, createAgentHandler, simTimers, mockProvidersRef);
  }
}

boot().catch((err) => {
  console.error('[dashboard] Fatal error during startup:');
  console.error(err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('[dashboard] Uncaught exception:', err);
  process.exit(1);
});
