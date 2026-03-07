// runcor trigger <flow> — trigger a flow execution

import { randomUUID } from 'node:crypto';
import type { CommandDef } from '../index.js';
import { connect } from '../connection.js';
import { formatError, formatJson, red } from '../output.js';
import type { Execution } from '../../execution.js';

export const triggerCommand: CommandDef = {
  name: 'trigger',
  description: 'Trigger a flow execution',
  usage: 'runcor trigger <flow> [--input <json>] [--user <userId>] [--no-wait] [--json]',
  positionals: [{ name: 'flow', required: true, description: 'Flow name to trigger' }],
  options: {
    input: { type: 'string', short: 'i', description: 'JSON input for the flow' },
    user: { type: 'string', short: 'u', default: 'cli', description: 'User ID for the execution' },
    'no-wait': { type: 'boolean', default: false, description: "Don't wait for completion" },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
  },
  handler: async ({ values, positionals }) => {
    const flowName = positionals[0];
    if (!flowName) {
      console.error(formatError('MISSING_ARG', 'Flow name is required. Usage: runcor trigger <flow>'));
      process.exit(1);
    }

    // Parse input JSON
    let input: unknown = null;
    if (values['input']) {
      try {
        input = JSON.parse(values['input'] as string);
      } catch (err) {
        console.error(formatError('INVALID_JSON', `Invalid --input JSON: ${(err as Error).message}`));
        process.exit(1);
      }
    }

    const userId = (values['user'] as string) ?? 'cli';
    const noWait = values['no-wait'] === true;
    const jsonOutput = values['json'] === true;
    const idempotencyKey = randomUUID();

    // Connect via hybrid model
    const configPath = values['config'] as string | undefined;
    const conn = await connect(configPath);

    try {
      let execution: Execution;

      if (conn.mode === 'http') {
        // HTTP mode — POST to /v1/flows/{name}/trigger
        const res = await fetch(`${conn.httpBaseUrl}/flows/${encodeURIComponent(flowName)}/trigger`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input, userId, idempotencyKey }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: { code: 'UNKNOWN', message: res.statusText } }));
          const err = body.error ?? { code: 'UNKNOWN', message: res.statusText };
          if (res.status === 404) {
            console.error(red(`Error: Flow "${flowName}" not found.`));
            // Try to list available flows
            try {
              const flowsRes = await fetch(`${conn.httpBaseUrl}/flows`);
              if (flowsRes.ok) {
                const flowsBody = await flowsRes.json();
                const names = (flowsBody.flows ?? []).map((f: { name: string }) => f.name);
                if (names.length > 0) {
                  console.error('');
                  console.error('Available flows:');
                  for (const n of names) console.error(`  - ${n}`);
                }
              }
            } catch { /* ignore */ }
            process.exit(2);
          }
          console.error(formatError(err.code, err.message));
          process.exit(1);
        }

        const body = await res.json();
        execution = body.execution ?? body;
      } else {
        // Engine mode — direct engine call
        const engine = conn.engine!;
        try {
          execution = await engine.trigger(flowName, {
            idempotencyKey,
            input,
            userId,
          });
        } catch (err: unknown) {
          const code = (err as { code?: string }).code ?? 'ERROR';
          if (code === 'FLOW_NOT_FOUND') {
            console.error(red(`Error: Flow "${flowName}" not found.`));
            const flows = engine.listFlows();
            if (flows.length > 0) {
              console.error('');
              console.error('Available flows:');
              for (const f of flows) console.error(`  - ${f.name}`);
            }
            process.exit(2);
          }
          console.error(formatError(code, (err as Error).message));
          process.exit(1);
          return;
        }

        // Wait for completion unless --no-wait
        if (!noWait && execution.state !== 'complete' && execution.state !== 'failed') {
          execution = await waitForTerminal(engine, execution.id);
        }
      }

      // Output
      if (noWait) {
        if (jsonOutput) {
          console.log(formatJson({ execution: { id: execution.id, flowName: execution.flowName, state: execution.state } }));
        } else {
          console.log(`Triggered: ${execution.flowName} (${execution.id})`);
        }
        process.exit(0);
      }

      if (jsonOutput) {
        console.log(formatJson({
          execution: {
            id: execution.id,
            flowName: execution.flowName,
            state: execution.state,
            result: execution.result ?? null,
            error: execution.error ?? null,
            createdAt: execution.timestamps.queued.toISOString(),
            completedAt: execution.timestamps.completed?.toISOString() ?? null,
          },
        }));
      } else {
        const duration = execution.timestamps.completed && execution.timestamps.queued
          ? `${execution.timestamps.completed.getTime() - execution.timestamps.queued.getTime()}ms`
          : '';
        console.log(`Triggered: ${execution.flowName} (${execution.id})`);
        console.log(`State:     ${execution.state}`);
        if (duration) console.log(`Duration:  ${duration}`);
        if (execution.state === 'failed' && execution.error) {
          const code = execution.error.code ?? 'ERROR';
          console.log(`Error:     ${code} \u2014 ${execution.error.message}`);
        } else if (execution.result !== undefined) {
          console.log(`Result:    ${JSON.stringify(execution.result)}`);
        }
      }

      process.exit(execution.state === 'failed' ? 1 : 0);
    } finally {
      await conn.cleanup();
    }
  },
};

async function waitForTerminal(engine: import('../../engine.js').Runcor, executionId: string): Promise<Execution> {
  return new Promise((resolve) => {
    const check = async () => {
      const exec = await engine.getExecution(executionId);
      if (exec && (exec.state === 'complete' || exec.state === 'failed')) {
        resolve(exec);
        return;
      }
      // Listen for state changes
      setTimeout(check, 100);
    };
    check();
  });
}
