// runcor status — list executions from state store

import type { CommandDef } from '../index.js';
import { connect } from '../connection.js';
import { formatTable, formatJson, formatError, relativeTime, dim } from '../output.js';
import type { Execution } from '../../execution.js';
import type { ExecutionState } from '../../types.js';

const VALID_STATES: ExecutionState[] = ['queued', 'running', 'waiting', 'retrying', 'complete', 'failed'];

export const statusCommand: CommandDef = {
  name: 'status',
  description: 'List executions from the state store',
  usage: 'runcor status [--state <state>] [--flow <name>] [--limit <n>] [--json]',
  options: {
    state: { type: 'string', short: 's', description: 'Filter by state' },
    flow: { type: 'string', short: 'f', description: 'Filter by flow name' },
    limit: { type: 'string', short: 'l', default: '20', description: 'Max rows to display' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
  },
  handler: async ({ values }) => {
    const stateFilter = values['state'] as string | undefined;
    const flowFilter = values['flow'] as string | undefined;
    const limit = parseInt((values['limit'] as string) ?? '20', 10);
    const jsonOutput = values['json'] === true;

    // Validate state filter
    if (stateFilter && !VALID_STATES.includes(stateFilter as ExecutionState)) {
      console.error(formatError('INVALID_STATE', `Invalid state "${stateFilter}". Valid states: ${VALID_STATES.join(', ')}`));
      process.exit(1);
    }

    const configPath = values['config'] as string | undefined;
    const conn = await connect(configPath);

    try {
      let executions: Execution[];

      if (conn.mode === 'http') {
        // HTTP mode — GET /v1/executions with query params
        const params = new URLSearchParams();
        if (stateFilter) params.set('state', stateFilter);
        if (flowFilter) params.set('flowName', flowFilter);
        const qs = params.toString();
        const url = `${conn.httpBaseUrl}/executions${qs ? `?${qs}` : ''}`;
        const res = await fetch(url);

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: { code: 'UNKNOWN', message: res.statusText } }));
          const err = body.error ?? { code: 'UNKNOWN', message: res.statusText };
          console.error(formatError(err.code, err.message));
          process.exit(1);
        }

        const body = await res.json();
        executions = (body.executions ?? body ?? []).map((e: Record<string, unknown>) => {
          const ts = e.timestamps as Record<string, unknown> | undefined;
          return {
            ...e,
            timestamps: {
              queued: new Date((e.createdAt as string) ?? (ts?.queued as string)),
              completed: e.completedAt ? new Date(e.completedAt as string) : ts?.completed ? new Date(ts.completed as string) : null,
            },
          };
        }) as Execution[];
      } else {
        // Engine mode — direct call
        const engine = conn.engine!;
        const filter: { state?: ExecutionState; flowName?: string } = {};
        if (stateFilter) filter.state = stateFilter as ExecutionState;
        if (flowFilter) filter.flowName = flowFilter;
        executions = await engine.list(Object.keys(filter).length > 0 ? filter : undefined);
      }

      // Apply limit
      const limited = executions.slice(0, limit);

      if (jsonOutput) {
        const output = limited.map(e => ({
          id: e.id,
          flowName: e.flowName,
          state: e.state,
          result: e.result ?? null,
          error: e.error ?? null,
          createdAt: e.timestamps.queued instanceof Date ? e.timestamps.queued.toISOString() : e.timestamps.queued,
          completedAt: e.timestamps.completed instanceof Date ? e.timestamps.completed?.toISOString() : e.timestamps.completed ?? null,
        }));
        console.log(formatJson({ executions: output }));
        process.exit(0);
      }

      // Empty state
      if (limited.length === 0) {
        console.log('No executions found.');
        process.exit(0);
      }

      // Table output
      const rows = limited.map(e => ({
        id: e.id.slice(0, 12),
        flow: e.flowName,
        state: e.state,
        age: e.timestamps.queued ? relativeTime(e.timestamps.queued instanceof Date ? e.timestamps.queued : new Date(e.timestamps.queued as unknown as string)) : '',
      }));

      const table = formatTable(rows, [
        { key: 'id', label: 'ID', width: 12 },
        { key: 'flow', label: 'FLOW', width: 20 },
        { key: 'state', label: 'STATE', width: 10 },
        { key: 'age', label: 'AGE', width: 12 },
      ]);
      console.log(table);

      // Summary line
      const counts: Record<string, number> = {};
      for (const e of limited) {
        counts[e.state] = (counts[e.state] ?? 0) + 1;
      }
      const parts = Object.entries(counts).map(([s, n]) => `${n} ${s}`);
      console.log('');
      console.log(dim(`${limited.length} execution${limited.length !== 1 ? 's' : ''} (${parts.join(', ')})`));
      if (executions.length > limit) {
        console.log(dim(`Showing first ${limit} of ${executions.length}. Use --limit to see more.`));
      }

      process.exit(0);
    } finally {
      await conn.cleanup();
    }
  },
};
