// runcor resume <id> — resume a waiting execution

import type { CommandDef } from '../index.js';
import { connect } from '../connection.js';
import { formatError, formatJson, red } from '../output.js';
import type { Execution } from '../../execution.js';

export const resumeCommand: CommandDef = {
  name: 'resume',
  description: 'Resume a waiting execution',
  usage: 'runcor resume <id> [--data <json>] [--json]',
  positionals: [{ name: 'id', required: true, description: 'Execution ID to resume' }],
  options: {
    data: { type: 'string', short: 'd', description: 'JSON resume data' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
  },
  handler: async ({ values, positionals }) => {
    const executionId = positionals[0];
    if (!executionId) {
      console.error(formatError('MISSING_ARG', 'Execution ID is required. Usage: runcor resume <id>'));
      process.exit(1);
    }

    // Parse resume data JSON
    let data: unknown = undefined;
    if (values['data']) {
      try {
        data = JSON.parse(values['data'] as string);
      } catch (err) {
        console.error(formatError('INVALID_JSON', `Invalid --data JSON: ${(err as Error).message}`));
        process.exit(1);
      }
    }

    const jsonOutput = values['json'] === true;
    const configPath = values['config'] as string | undefined;
    const conn = await connect(configPath);

    try {
      let execution: Execution;

      if (conn.mode === 'http') {
        // HTTP mode — POST to /v1/executions/{id}/resume
        const res = await fetch(`${conn.httpBaseUrl}/executions/${encodeURIComponent(executionId)}/resume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: { code: 'UNKNOWN', message: res.statusText } }));
          const err = body.error ?? { code: 'UNKNOWN', message: res.statusText };
          if (res.status === 404) {
            console.error(red(`Error: Execution "${executionId}" not found.`));
            process.exit(1);
          }
          if (res.status === 409) {
            console.error(red(`Error: Execution "${executionId}" is not in a waiting state.`));
            process.exit(1);
          }
          console.error(formatError(err.code, err.message));
          process.exit(1);
        }

        const body = await res.json();
        execution = body.execution ?? body;
      } else {
        // Engine mode — direct call
        const engine = conn.engine!;
        try {
          execution = await engine.resume(executionId, data);
        } catch (err: unknown) {
          const code = (err as { code?: string }).code ?? 'ERROR';
          if (code === 'EXECUTION_NOT_FOUND') {
            console.error(red(`Error: Execution "${executionId}" not found.`));
            process.exit(1);
          }
          if (code === 'INVALID_TRANSITION' || code === 'INVALID_STATE') {
            console.error(red(`Error: Execution "${executionId}" is not in a waiting state.`));
            process.exit(1);
          }
          console.error(formatError(code, (err as Error).message));
          process.exit(1);
          return;
        }

        // Wait for completion
        if (execution.state !== 'complete' && execution.state !== 'failed') {
          execution = await waitForTerminal(engine, execution.id);
        }
      }

      // Output
      if (jsonOutput) {
        console.log(formatJson({
          execution: {
            id: execution.id,
            flowName: execution.flowName,
            state: execution.state,
            result: execution.result ?? null,
            error: execution.error ?? null,
            createdAt: execution.timestamps.queued instanceof Date ? execution.timestamps.queued.toISOString() : execution.timestamps.queued,
            completedAt: execution.timestamps.completed instanceof Date ? execution.timestamps.completed?.toISOString() : execution.timestamps.completed ?? null,
          },
        }));
      } else {
        console.log(`Resumed: ${execution.flowName} (${execution.id})`);
        console.log(`State:   ${execution.state}`);
        if (execution.state === 'failed' && execution.error) {
          const code = execution.error.code ?? 'ERROR';
          console.log(`Error:   ${code} \u2014 ${execution.error.message}`);
        } else if (execution.result !== undefined && execution.result !== null) {
          console.log(`Result:  ${JSON.stringify(execution.result)}`);
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
      setTimeout(check, 100);
    };
    check();
  });
}
