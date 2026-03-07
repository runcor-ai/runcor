// Evaluator runner — executes evaluators with timeout and error isolation

import type {
  Evaluator,
  EvalContext,
  EvalResult,
  EvaluatorResultEntry,
  EvalErrorEntry,
} from '../types.js';

/** Result of running all evaluators on an execution */
export interface RunResult {
  results: EvaluatorResultEntry[];
  errors: EvalErrorEntry[];
}

/**
 * Run all evaluators concurrently with per-evaluator timeout and error isolation.
 * Uses Promise.allSettled for parallel execution — one evaluator's failure
 * does not affect others.
 */
export async function runEvaluators(
  evaluators: Evaluator[],
  context: EvalContext,
  defaultTimeoutMs: number,
): Promise<RunResult> {
  if (evaluators.length === 0) {
    return { results: [], errors: [] };
  }

  const promises = evaluators.map((evaluator) =>
    runSingleEvaluator(evaluator, context, defaultTimeoutMs),
  );

  const settled = await Promise.allSettled(promises);

  const results: EvaluatorResultEntry[] = [];
  const errors: EvalErrorEntry[] = [];

  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      if (outcome.value.type === 'success') {
        results.push(outcome.value.entry);
      } else {
        errors.push(outcome.value.entry);
      }
    }
    // rejected should not happen due to our catch, but handle gracefully
  }

  return { results, errors };
}

type SingleResult =
  | { type: 'success'; entry: EvaluatorResultEntry }
  | { type: 'error'; entry: EvalErrorEntry };

async function runSingleEvaluator(
  evaluator: Evaluator,
  context: EvalContext,
  defaultTimeoutMs: number,
): Promise<SingleResult> {
  const timeoutMs = evaluator.timeoutMs ?? defaultTimeoutMs;
  const startTime = Date.now();
  const timeout = createTimeout(timeoutMs, evaluator.name);

  try {
    const result = await Promise.race([
      Promise.resolve(evaluator.evaluate(context)),
      timeout.promise,
    ]);

    timeout.clear();
    const durationMs = Date.now() - startTime;
    const evalResult = result as EvalResult;

    return {
      type: 'success',
      entry: {
        evaluatorName: evaluator.name,
        scores: evalResult.scores,
        labels: evalResult.labels ?? [],
        feedback: evalResult.feedback ?? null,
        confidence: 'high', // Placeholder — scorer will compute real confidence
        durationMs,
      },
    };
  } catch (err: unknown) {
    timeout.clear();
    const isTimeout = err instanceof Error && err.message.includes('timed out');
    const message = err instanceof Error ? err.message : String(err);

    return {
      type: 'error',
      entry: {
        evaluatorName: evaluator.name,
        error: message,
        timedOut: isTimeout,
      },
    };
  }
}

function createTimeout(ms: number, evaluatorName: string): { promise: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Evaluator "${evaluatorName}" timed out after ${ms}ms`));
    }, ms);
  });
  return { promise, clear: () => clearTimeout(timer!) };
}
