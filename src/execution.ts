// Execution type with state machine transitions

import type { ExecutionState, ExecutionTimestamps, ExecutionError, WaitContext } from './types.js';
import { EngineError } from './errors.js';

/** A single invocation of a flow */
export interface Execution {
  readonly id: string;
  readonly flowName: string;
  readonly idempotencyKey: string;
  state: ExecutionState;
  readonly input: unknown;
  result: unknown | null;
  error: ExecutionError | null;
  retryCount: number;
  timestamps: ExecutionTimestamps;
  /** Wait metadata — set when entering waiting state, null otherwise */
  waitContext: WaitContext | null;
  /** Data provided by external caller on resume */
  resumeData: unknown | null;
  /** Original execution ID if this is a replay */
  replayOf: string | null;
  /** User who triggered the execution */
  userId: string | null;
}

/** Valid state transitions per data-model.md */
const VALID_TRANSITIONS: ReadonlyMap<ExecutionState, ReadonlySet<ExecutionState>> = new Map([
  ['queued', new Set<ExecutionState>(['running', 'failed'])],
  ['running', new Set<ExecutionState>(['complete', 'waiting', 'retrying', 'failed'])],
  ['waiting', new Set<ExecutionState>(['running', 'failed'])],
  ['retrying', new Set<ExecutionState>(['running', 'failed'])],
  ['complete', new Set<ExecutionState>([])],
  ['failed', new Set<ExecutionState>([])],
]);

/** Validate a state transition. Throws EngineError if invalid. */
export function validateTransition(from: ExecutionState, to: ExecutionState): void {
  const allowed = VALID_TRANSITIONS.get(from);
  if (!allowed || !allowed.has(to)) {
    throw new EngineError(
      `Invalid state transition: ${from} → ${to}`,
      'INVALID_TRANSITION',
    );
  }
}

/** Create a new execution in "queued" state */
export function createExecution(
  flowName: string,
  idempotencyKey: string,
  input: unknown,
  userId?: string | null,
): Execution {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    flowName,
    idempotencyKey,
    state: 'queued',
    input,
    result: null,
    error: null,
    retryCount: 0,
    timestamps: {
      queued: now,
      started: null,
      completed: null,
      transitions: [],
    },
    waitContext: null,
    resumeData: null,
    replayOf: null,
    userId: userId ?? null,
  };
}

/** Transition an execution to a new state, recording timestamps */
export function transitionExecution(execution: Execution, newState: ExecutionState): void {
  validateTransition(execution.state, newState);

  const now = new Date();
  execution.timestamps.transitions.push({
    from: execution.state,
    to: newState,
    at: now,
  });

  execution.state = newState;

  if (newState === 'running' && execution.timestamps.started === null) {
    execution.timestamps.started = now;
  }

  if (newState === 'complete' || newState === 'failed') {
    execution.timestamps.completed = now;
  }
}
