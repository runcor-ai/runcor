// Gmail Morning Brief — demonstrates real MCP adapter integration
//
// This example connects to a Gmail MCP server, searches for today's unread
// emails, and uses an LLM to generate a prioritized morning brief.
//
// To run with real Gmail data:
//   1. Set up a Gmail MCP server (e.g., npx @anthropic/gmail-mcp-server)
//   2. Set GMAIL_MCP_URL in your environment (for SSE transport)
//      — or leave unset to use stdio transport with npx
//   3. Set ANTHROPIC_API_KEY or OPENAI_API_KEY for real model calls
//   4. Run: npx tsx examples/gmail-brief.ts
//
// Without a Gmail MCP server, the example uses mock email data to demonstrate
// the flow pattern.

import {
  createEngine,
  MockProvider,
  AnthropicProvider,
  OpenAIProvider,
} from '../src/index.js';
import type { Runcor, ExecutionContext, FlowHandler } from '../src/index.js';

// ── Provider setup ──────────────────────────────────────────────────────

async function buildProviders() {
  const providers: Array<{ provider: any; priority: number }> = [];

  if (process.env.ANTHROPIC_API_KEY) {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    providers.push({ provider: new AnthropicProvider(client), priority: 1 });
    console.log('  Provider: Anthropic (Claude)');
  }

  if (process.env.OPENAI_API_KEY) {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    providers.push({ provider: new OpenAIProvider(client), priority: providers.length + 1 });
    console.log('  Provider: OpenAI');
  }

  if (providers.length === 0) {
    providers.push({ provider: new MockProvider(), priority: 1 });
    console.log('  Provider: Mock (set ANTHROPIC_API_KEY or OPENAI_API_KEY for real model calls)');
  }

  return providers;
}

// ── Mock data (used when Gmail adapter is not available) ────────────────

const MOCK_EMAILS = [
  { from: 'alice@company.com', subject: 'Q1 Revenue Report — Action Required', snippet: 'The Q1 revenue numbers are in. We exceeded targets by 12%. Please review the attached deck before the board meeting Friday.' },
  { from: 'security@company.com', subject: 'Critical: SSL Certificate Expiring', snippet: 'The SSL certificate for api.company.com expires in 3 days. Renewal requires DevOps approval.' },
  { from: 'bob@team.io', subject: 'Sprint Retro Notes', snippet: 'Attached are the notes from yesterday\'s retro. Key action item: reduce PR review time from 48h to 24h.' },
  { from: 'ceo@company.com', subject: 'Company All-Hands This Friday', snippet: 'Join us at 2pm for the quarterly all-hands. Topic: 2026 roadmap and hiring plans.' },
  { from: 'noreply@github.com', subject: 'PR #387 approved', snippet: 'Your pull request "Add rate limiting to API gateway" has been approved by 2 reviewers.' },
  { from: 'support@vendor.io', subject: 'Your invoice is ready', snippet: 'Invoice #INV-2026-0142 for $2,340.00 is ready for payment. Due date: March 15, 2026.' },
];

// ── Flow handler ────────────────────────────────────────────────────────

const gmailBriefHandler: FlowHandler = async (ctx: ExecutionContext) => {
  let emailData: string;
  let source: 'gmail' | 'mock';

  // Try to use the real Gmail adapter
  const tools = ctx.tools?.listTools({ adapter: 'gmail' }) ?? [];
  const hasGmail = tools.some((t) => t.toolName === 'search_emails');

  if (hasGmail) {
    // Real Gmail adapter is connected — search for today's unread emails
    source = 'gmail';
    console.log('  Using live Gmail data via MCP adapter');

    const result = await ctx.tools!.callTool('gmail.search_emails', {
      query: 'is:unread newer_than:1d',
      maxResults: 20,
    });

    if (result.isError) {
      emailData = 'Error fetching emails: ' + (result.content[0]?.text ?? 'unknown error');
    } else {
      emailData = result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    }
  } else {
    // No Gmail adapter — use mock data
    source = 'mock';
    console.log('  No Gmail adapter connected — using mock email data');
    console.log('  To connect Gmail: set GMAIL_MCP_URL or configure a Gmail MCP server');

    emailData = MOCK_EMAILS.map((e, i) =>
      `${i + 1}. From: ${e.from}\n   Subject: ${e.subject}\n   Preview: ${e.snippet}`
    ).join('\n\n');
  }

  // Ask the model to prioritize and summarize
  const response = await ctx.model.complete({
    prompt: `You are an executive assistant. Analyze these emails and produce a morning brief.

For each email, determine:
- Priority (urgent / important / informational / low)
- Whether action is required and what that action is
- A one-line summary

Then provide an overall summary of the day's priorities.

Emails:
${emailData}

Format your response as a clear, scannable brief.`,
  });

  return {
    source,
    emailCount: source === 'gmail' ? 'live' : MOCK_EMAILS.length,
    brief: response.text,
    model: response.model,
    tokens: response.usage,
  };
};

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  Gmail Morning Brief Example');
  console.log('  ─────────────────────────────\n');

  const providers = await buildProviders();

  // Build engine config
  const config: any = {
    model: { providers },
    cost: {},
  };

  // Add Gmail adapter if URL is provided (SSE transport)
  // For stdio transport, the adapter connects via npx automatically
  if (process.env.GMAIL_MCP_URL) {
    config.adapters = {
      adapters: [{
        name: 'gmail',
        transport: 'sse' as const,
        url: process.env.GMAIL_MCP_URL,
        timeoutMs: 30_000,
        retryAttempts: 3,
        retryDelayMs: 1_000,
      }],
    };
    console.log(`  Gmail adapter: ${process.env.GMAIL_MCP_URL}`);
  } else {
    console.log('  Gmail adapter: not configured (set GMAIL_MCP_URL to connect)');
  }

  console.log('');

  const engine = await createEngine(config);

  engine.register('gmail-brief', gmailBriefHandler, {
    description: 'Generate a prioritized morning brief from Gmail',
    timeout: 60_000,
  });

  // Trigger the flow
  const execution = await engine.trigger('gmail-brief', {
    idempotencyKey: `gmail-brief-${new Date().toISOString().slice(0, 10)}`,
  });

  // Wait for completion
  const result = await new Promise<unknown>((resolve, reject) => {
    engine.on('execution:complete', (e) => {
      if (e.executionId === execution.id) {
        if (e.error) reject(e.error);
        else resolve(e.result);
      }
    });
  });

  const brief = result as { source: string; emailCount: unknown; brief: string; model: string; tokens: { promptTokens: number; completionTokens: number } };

  console.log('  ─── Morning Brief ───────────────────────────────\n');
  console.log(`  Source: ${brief.source === 'gmail' ? 'Live Gmail' : 'Mock data'}`);
  console.log(`  Model:  ${brief.model}`);
  console.log(`  Tokens: ${brief.tokens.promptTokens} prompt + ${brief.tokens.completionTokens} completion`);
  console.log('');
  console.log(brief.brief.split('\n').map((l: string) => '  ' + l).join('\n'));
  console.log('\n  ─────────────────────────────────────────────────\n');

  // Check cost
  const ledger = engine.getCostLedger();
  if (ledger) {
    const total = ledger.getTotal({});
    if (total > 0) {
      console.log(`  Cost: $${total.toFixed(6)}`);
    }
  }

  await engine.shutdown();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

// ── Expected output (with MockProvider, no Gmail adapter) ──────────────
//
//   Gmail Morning Brief Example
//   ─────────────────────────────
//
//   Provider: Mock (set ANTHROPIC_API_KEY or OPENAI_API_KEY for real model calls)
//   Gmail adapter: not configured (set GMAIL_MCP_URL to connect)
//
//   No Gmail adapter connected — using mock email data
//   To connect Gmail: set GMAIL_MCP_URL or configure a Gmail MCP server
//
//   ─── Morning Brief ───────────────────────────────
//
//   Source: Mock data
//   Model:  mock
//   Tokens: 10 prompt + 10 completion
//
//   [LLM-generated prioritized brief from mock emails]
//
//   ─────────────────────────────────────────────────
