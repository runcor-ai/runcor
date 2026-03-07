// Small 5-flow test to verify dashboard shows cost, connections, and discernment.
// Run: npx tsx demo/test-dashboard.ts

import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import {
  createEngine,
  MockProvider,
} from '../src/index.js';
import type { AdapterConfig } from '../src/index.js';
import { ManagedAdapter } from '../src/adapter/managed-adapter.js';
import type { MCPClient, MCPTransport, MCPClientFactory } from '../src/adapter/managed-adapter.js';
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

// ── Named mock providers (show as Anthropic/OpenAI/Google in dashboard) ──────

function createNamedProvider(name: string, template: string): MockProvider {
  const p = new MockProvider(template);
  Object.defineProperty(p, 'name', { value: name, writable: false });
  return p;
}

// ── Mock adapter factory ─────────────────────────────────────────────────────

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

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  // Three providers that show realistic names in the dashboard
  const anthropic = createNamedProvider('anthropic', 'Claude response to: {prompt}');
  const openai = createNamedProvider('openai', 'GPT response to: {prompt}');
  const google = createNamedProvider('google', 'Gemini response to: {prompt}');

  const engine = await createEngine({
    model: {
      providers: [
        { provider: anthropic, priority: 1, costPerToken: { input: 0.000003, output: 0.000015 } },
        { provider: openai, priority: 2, costPerToken: { input: 0.0000025, output: 0.00001 } },
        { provider: google, priority: 3, costPerToken: { input: 0.0000001, output: 0.0000004 } },
      ],
      strategy: 'round-robin',
    },
    cost: {},
    concurrency: 20,
    server: { enabled: true, name: 'runcor-test' },
    discernment: {
      enabled: true,
      autonomy: 'recommend',
      schedule: 'daily',
      objectives: [
        { name: 'operational-visibility', description: 'Leadership has daily visibility into all business metrics' },
        { name: 'customer-retention', description: 'Reduce churn through proactive outreach and support' },
        { name: 'revenue-growth', description: 'Increase pipeline conversion and deal velocity' },
      ],
    },
  });

  // ── Register mock adapters (business connections) ─────────────────────────
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
  console.log(`[test] Registered ${adapterNames.length} mock adapters (${adapterNames.join(', ')})`);

  // ── Register 5 test flows ──────────────────────────────────────────────────

  engine.register('lead-qualifier', async (ctx) => {
    const input = ctx.input as Record<string, unknown>;
    const result = await ctx.model.complete({
      prompt: `Qualify this inbound lead using BANT criteria. Company: ${input.company}, Contact: ${input.contact}, Source: ${input.source}.`,
    });
    return { input, output: result.text };
  }, { description: 'Qualify inbound leads using BANT criteria', objective: 'revenue-growth' });

  engine.register('churn-detector', async (ctx) => {
    const input = ctx.input as Record<string, unknown>;
    const result = await ctx.model.complete({
      prompt: `Assess churn risk for ${input.customer} (${input.tier} tier, ARR: ${input.arr}). Usage: ${input.usage}. Tickets: ${input.tickets}.`,
    });
    return { input, output: result.text };
  }, { description: 'Detect early churn risk signals', objective: 'customer-retention' });

  engine.register('daily-brief', async (ctx) => {
    const result = await ctx.model.complete({
      prompt: 'Generate a morning briefing covering key meetings, metrics, and action items.',
    });
    return { brief: result.text, generatedAt: new Date().toISOString() };
  }, { description: 'Daily executive morning brief', objective: 'operational-visibility' });

  engine.register('pipeline-report', async (ctx) => {
    const input = ctx.input as Record<string, unknown>;
    const result = await ctx.model.complete({
      prompt: `Summarize pipeline for ${input.region}. Total: ${input.total} across ${input.dealCount} deals. Quota: ${input.quota}.`,
    });
    return { input, output: result.text };
  }, { description: 'Summarize sales pipeline and forecast', objective: 'revenue-growth' });

  engine.register('support-responder', async (ctx) => {
    const input = ctx.input as Record<string, unknown>;
    const result = await ctx.model.complete({
      prompt: `Draft a response for ticket ${input.ticketId} from ${input.customer}: "${input.issue}".`,
    });
    return { input, output: result.text };
  }, { description: 'Draft customer support responses', objective: 'customer-retention' });

  console.log('[test] Registered 5 test flows');

  // ── Start HTTP server FIRST (so you can open the dashboard before data arrives) ──

  const app = new Hono();
  const startTime = Date.now();
  const sseMgr = createSSEManager(engine);

  app.get('/', (c) => c.html(DASHBOARD_HTML));
  app.route('/v1', createHealthRoutes(engine, startTime));
  app.route('/v1', createFlowRoutes(engine));
  app.route('/v1', createExecutionRoutes(engine));
  app.route('/v1', createAdapterRoutes(engine));
  app.route('/v1', createEventRoutes(sseMgr));
  app.route('/v1', createProviderRoutes(engine));
  app.route('/v1', createCostRoutes(engine));
  app.route('/v1', createDiscernmentRoutes(engine));
  app.get('/v1/dashboard', (c) => c.html(DASHBOARD_HTML));

  const PORT = parseInt(process.env.PORT ?? '3001', 10);
  serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
    console.log('');
    console.log('  Dashboard ready: http://localhost:' + PORT + '/v1/dashboard');
    console.log('  Open it now — data will start flowing in 10 seconds...');
    console.log('');
  });

  // ── Wait 10 seconds so you can open the dashboard and watch it populate ──

  const initialFlows = [
    { flow: 'lead-qualifier', key: 'test-lq-1', input: { company: 'Acme Corp', contact: 'Sarah Chen', source: 'Webinar' }, user: 'bob' },
    { flow: 'lead-qualifier', key: 'test-lq-2', input: { company: 'TechVentures', contact: 'James Patel', source: 'Demo request' }, user: 'bob' },
    { flow: 'churn-detector', key: 'test-cd-1', input: { customer: 'Orion Health', tier: 'Enterprise', arr: '$200,000', usage: '35%', tickets: '12 in 30 days' }, user: 'grace' },
    { flow: 'churn-detector', key: 'test-cd-2', input: { customer: 'BluePeak Financial', tier: 'Pro', arr: '$45,000', usage: '85%', tickets: '2 in 30 days' }, user: 'grace' },
    { flow: 'daily-brief', key: 'test-db-1', input: undefined, user: 'alice' },
    { flow: 'daily-brief', key: 'test-db-2', input: undefined, user: 'henry' },
    { flow: 'pipeline-report', key: 'test-pr-1', input: { region: 'North America', total: '$4.2M', dealCount: 35, quota: '$2.5M' }, user: 'bob' },
    { flow: 'support-responder', key: 'test-sr-1', input: { ticketId: 'TKT-12345', customer: 'Apex Biotech', issue: 'Cannot export reports to PDF since last update' }, user: 'grace' },
    { flow: 'support-responder', key: 'test-sr-2', input: { ticketId: 'TKT-12346', customer: 'Helios Energy', issue: 'SSO login fails intermittently' }, user: 'carol' },
    { flow: 'support-responder', key: 'test-sr-3', input: { ticketId: 'TKT-12347', customer: 'Forge Aerospace', issue: 'Dashboard loading slowly' }, user: 'henry' },
  ];

  await new Promise(resolve => setTimeout(resolve, 10000));
  console.log('[test] Starting initial flow triggers (one every 2 seconds)...');

  for (const f of initialFlows) {
    await engine.trigger(f.flow, { idempotencyKey: f.key, input: f.input ?? undefined, userId: f.user });
    console.log(`[test]   triggered ${f.flow} (${f.user})`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  console.log('[test] Initial batch complete — 10 executions across 5 flows');

  // ── Check cost ─────────────────────────────────────────────────────────────

  const ledger = engine.getCostLedger();
  const totalCost = ledger ? ledger.getTotal({}) : 0;
  console.log(`[test] Total cost recorded: $${totalCost.toFixed(6)}`);

  // ── Run discernment ────────────────────────────────────────────────────────

  // Queue on ALL providers since round-robin may pick any of them for the discernment call
  const discernmentPayload = [{
    text: JSON.stringify({
      recommendations: [
        { target: 'support-responder', targetType: 'flow', action: 'optimize', confidence: 0.82, explanation: 'support-responder accounts for 25% of total cost and handles 30% of executions. Consider adding response templates to reduce token usage by an estimated 40%.', evidenceRefs: [] },
        { target: 'lead-qualifier', targetType: 'flow', action: 'keep', confidence: 0.91, explanation: 'lead-qualifier is well-utilized with strong alignment to revenue-growth objective. Cost per execution is reasonable at current volume.', evidenceRefs: [] },
        { target: 'churn-detector', targetType: 'flow', action: 'investigate', confidence: 0.67, explanation: 'churn-detector usage is low relative to its customer-retention objective. Verify that the output is being actioned by the customer success team.', evidenceRefs: [] },
        { target: 'daily-brief', targetType: 'flow', action: 'optimize', confidence: 0.74, explanation: 'daily-brief triggers twice daily for different users with similar output. Consider consolidating into a single execution with per-user distribution.', evidenceRefs: [] },
        { target: 'customer-retention', targetType: 'objective', action: 'escalate', confidence: 0.78, explanation: 'customer-retention objective has high support volume but churn detection is underutilized. Tighter integration between support-responder and churn-detector would improve outcomes.', evidenceRefs: [] },
      ],
    }),
  }];
  anthropic.queueResponses(discernmentPayload);
  openai.queueResponses(discernmentPayload);
  google.queueResponses(discernmentPayload);

  try {
    const report = await engine.runDiscernmentCycle();
    console.log(`[test] Discernment: ${report.signals.length} signals, ${report.recommendations.length} recommendations`);
    for (const r of report.recommendations) {
      console.log(`  ${r.action} → ${r.target} (${(r.confidence * 100).toFixed(0)}%)`);
    }
  } catch (err) {
    console.error('[test] Discernment error:', err);
  }

  // ── Live activity loop (triggers a random flow every 3-8 seconds) ────────

  const users = ['alice', 'bob', 'carol', 'grace', 'henry'];
  const flowInputs: Record<string, () => Record<string, unknown>> = {
    'lead-qualifier': () => ({
      company: ['Acme Corp', 'TechVentures', 'Pinnacle Systems', 'Atlas Cloud', 'Nexus Partners'][Math.floor(Math.random() * 5)],
      contact: ['Sarah Chen', 'James Patel', 'Maria Lopez', 'David Kim', 'Emily Watson'][Math.floor(Math.random() * 5)],
      source: ['Webinar', 'Demo request', 'Referral', 'Cold outbound', 'Inbound form'][Math.floor(Math.random() * 5)],
    }),
    'churn-detector': () => ({
      customer: ['Orion Health', 'BluePeak Financial', 'Quantum Retail', 'Helios Energy', 'Forge Aerospace'][Math.floor(Math.random() * 5)],
      tier: ['Enterprise', 'Pro', 'Starter'][Math.floor(Math.random() * 3)],
      arr: ['$200,000', '$85,000', '$45,000', '$15,000'][Math.floor(Math.random() * 4)],
      usage: ['-12%', '35%', '68%', '85%', '92%'][Math.floor(Math.random() * 5)],
      tickets: ['0 in 30 days', '2 in 30 days', '7 in 30 days', '12 in 30 days'][Math.floor(Math.random() * 4)],
    }),
    'daily-brief': () => ({}),
    'pipeline-report': () => ({
      region: ['North America', 'EMEA', 'APAC', 'LATAM'][Math.floor(Math.random() * 4)],
      total: ['$1.8M', '$3.5M', '$4.2M', '$6.1M'][Math.floor(Math.random() * 4)],
      dealCount: 10 + Math.floor(Math.random() * 50),
      quota: ['$2.0M', '$2.5M', '$3.0M', '$4.0M'][Math.floor(Math.random() * 4)],
    }),
    'support-responder': () => ({
      ticketId: `TKT-${10000 + Math.floor(Math.random() * 90000)}`,
      customer: ['Apex Biotech', 'Helios Energy', 'Forge Aerospace', 'Tidal Commerce', 'Catalyst Education'][Math.floor(Math.random() * 5)],
      issue: ['Cannot export reports to PDF', 'SSO login fails intermittently', 'Dashboard loading slowly', 'Billing discrepancy', 'API rate limit errors'][Math.floor(Math.random() * 5)],
    }),
  };
  const flowNames = Object.keys(flowInputs);
  let triggerCount = 0;

  function scheduleNext() {
    const delay = 3000 + Math.floor(Math.random() * 5000);
    setTimeout(async () => {
      const flow = flowNames[Math.floor(Math.random() * flowNames.length)];
      const user = users[Math.floor(Math.random() * users.length)];
      try {
        triggerCount++;
        await engine.trigger(flow, {
          idempotencyKey: `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          input: flowInputs[flow](),
          userId: user,
        });
      } catch { /* ignore */ }
      scheduleNext();
    }, delay);
  }

  scheduleNext();
  console.log('[test] Live activity loop started (random flow every 3-8s)');

  process.on('SIGINT', async () => {
    sseMgr.shutdown();
    await engine.shutdown();
    process.exit(0);
  });
}

boot().catch((err) => {
  console.error('[test] Fatal:', err);
  process.exit(1);
});
