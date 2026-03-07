// Morning Brief demo flow
// Proves engine works end-to-end: register → trigger → model call → result

import { createEngine, MockProvider } from '../src/index.js';
import type { Runcor, ExecutionContext } from '../src/index.js';

// ── Mock Data ────────────────────────────────────────────────────

const mockEmails = [
  { sender: 'alice@company.com', subject: 'Q1 Report Review', preview: 'Please review the attached Q1 financial report by EOD.' },
  { sender: 'bob@team.io', subject: 'Sprint Planning Tomorrow', preview: 'Reminder: sprint planning is at 10am tomorrow. Please update your tickets.' },
  { sender: 'ceo@company.com', subject: 'Company All-Hands Friday', preview: 'Join us for the quarterly all-hands meeting this Friday at 2pm.' },
];

const mockCalendar = [
  { time: '9:00 AM', title: 'Team Standup', attendees: ['Alice', 'Bob', 'Charlie'] },
  { time: '2:00 PM', title: 'Design Review Meeting', attendees: ['Alice', 'Diana'] },
];

const mockTasks = [
  { title: 'Review PR #142', priority: 'high', status: 'in-progress' },
  { title: 'Update API documentation', priority: 'medium', status: 'todo' },
  { title: 'Fix login timeout bug', priority: 'high', status: 'todo' },
  { title: 'Prepare demo for stakeholders', priority: 'low', status: 'todo' },
];

// ── Flow Handler ────────────────────────────────────────────────

async function morningBriefHandler(ctx: ExecutionContext): Promise<string> {
  const emailSummary = mockEmails
    .map((e) => `- From ${e.sender}: "${e.subject}" — ${e.preview}`)
    .join('\n');

  const calendarSummary = mockCalendar
    .map((e) => `- ${e.time}: ${e.title} (with ${e.attendees.join(', ')})`)
    .join('\n');

  const taskSummary = mockTasks
    .map((t) => `- [${t.priority}] ${t.title} (${t.status})`)
    .join('\n');

  const prompt = `Summarize today's priorities based on the following data:

EMAILS:
${emailSummary}

CALENDAR EVENTS:
${calendarSummary}

TASKS:
${taskSummary}

Provide a brief morning summary highlighting the most important items to focus on.`;

  const response = await ctx.model.complete({ prompt });
  return response.text;
}

/** Register the Morning Brief flow with an engine instance */
export function registerMorningBrief(engine: Runcor): void {
  engine.register('morning-brief', morningBriefHandler);
}

// ── Example Runner ──────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Starting Runcor...');

  const engine = await createEngine({
    model: { provider: new MockProvider() },
  });

  console.log('Engine ready. Registering Morning Brief flow...');
  registerMorningBrief(engine);

  engine.on('execution:state_change', (event) => {
    console.log(`  [${event.executionId.slice(0, 8)}] ${event.from} → ${event.to}`);
  });

  console.log('Triggering Morning Brief...\n');
  const exec = await engine.trigger('morning-brief', {
    idempotencyKey: `morning-brief-${Date.now()}`,
  });

  // Wait for completion
  await new Promise<void>((resolve) => {
    engine.on('execution:complete', (event) => {
      console.log('\n── Morning Brief Result ──────────────────────');
      console.log(event.result);
      console.log('──────────────────────────────────────────────\n');
      resolve();
    });
  });

  const final = await engine.getExecution(exec.id);
  console.log(`Execution state: ${final!.state}`);
  console.log(`Transitions: ${final!.timestamps.transitions.length}`);

  console.log('Shutting down...');
  await engine.shutdown();
  console.log('Done.');
}

// Only run if executed directly (not imported as a module by tests)
const isDirectExecution = process.argv[1]?.includes('morning-brief');
if (isDirectExecution) {
  main().catch(console.error);
}
