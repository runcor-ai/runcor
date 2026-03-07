// E2E test helpers — shared utilities for cross-feature integration tests
// Extracted common patterns from existing integration tests

import { createEngine, type Runcor } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import type { EngineConfig, ExecutionState } from '../../src/types.js';
import type { ModelProvider, ModelRequest, ModelResponse } from '../../src/model/provider.js';
import type { ToolCallRequest } from '../../src/agent/types.js';

/**
 * Create a test engine with MockProvider defaults and optional overrides.
 */
export async function createTestEngine(
  overrides?: Partial<EngineConfig>,
): Promise<Runcor> {
  const config: EngineConfig = {
    model: { provider: new MockProvider() },
    drainTimeout: 500,
    ...overrides,
  };
  return createEngine(config);
}

/**
 * Poll until an execution reaches the target state, or timeout.
 */
export async function waitForState(
  engine: Runcor,
  executionId: string,
  targetState: ExecutionState,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const exec = await engine.getExecution(executionId);
    if (exec && exec.state === targetState) return;
    // If we're waiting for a non-terminal state but hit a terminal, throw early
    if (
      exec &&
      (exec.state === 'complete' || exec.state === 'failed') &&
      targetState !== 'complete' &&
      targetState !== 'failed'
    ) {
      throw new Error(
        `Execution ${executionId} reached terminal state "${exec.state}" while waiting for "${targetState}". Error: ${exec.error?.message ?? 'none'}`,
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  const exec = await engine.getExecution(executionId);
  throw new Error(
    `Timed out waiting for state "${targetState}" on execution ${executionId}. Current state: "${exec?.state ?? 'not found'}"`,
  );
}

/**
 * Shorthand: wait for execution to complete or fail.
 */
export async function waitForCompletion(
  engine: Runcor,
  executionId: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const exec = await engine.getExecution(executionId);
    if (exec && (exec.state === 'complete' || exec.state === 'failed')) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  const exec = await engine.getExecution(executionId);
  throw new Error(
    `Timed out waiting for completion on ${executionId}. Current state: "${exec?.state ?? 'not found'}"`,
  );
}

/**
 * Wait for N occurrences of a specific event.
 */
export function waitForN(
  engine: Runcor,
  event: string,
  count: number,
  timeoutMs = 5000,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const collected: unknown[] = [];
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${count} "${event}" events (got ${collected.length})`));
    }, timeoutMs);

    const handler = (payload: unknown) => {
      collected.push(payload);
      if (collected.length >= count) {
        clearTimeout(timer);
        (engine as any).removeListener(event, handler);
        resolve(collected);
      }
    };
    (engine as any).on(event, handler);
  });
}

/**
 * Create a named mock provider with configurable response text.
 */
export function createNamedProvider(
  name: string,
  responseText = `Response from ${name}`,
): ModelProvider {
  return {
    name,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const promptLen = request.messages
        ? request.messages.map((m) => m.content).join('').length
        : (request.prompt?.length ?? 0);
      return {
        text: responseText,
        model: name,
        provider: name,
        usage: { promptTokens: promptLen || 10, completionTokens: responseText.length },
      };
    },
  };
}

/**
 * Create a provider that always throws.
 */
export function createFailingProvider(name: string): ModelProvider {
  return {
    name,
    async complete(): Promise<ModelResponse> {
      throw new Error(`${name} provider failure`);
    },
  };
}

/**
 * Create a provider with configurable latency.
 */
export function createSlowProvider(name: string, delayMs: number): ModelProvider {
  return {
    name,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      await new Promise((r) => setTimeout(r, delayMs));
      const promptLen = request.messages
        ? request.messages.map((m) => m.content).join('').length
        : (request.prompt?.length ?? 0);
      return {
        text: `Slow response from ${name}`,
        model: name,
        provider: name,
        usage: { promptTokens: promptLen || 10, completionTokens: 25 },
      };
    },
  };
}

/**
 * Create a provider that returns tool calls for N iterations, then a final text answer.
 */
export function createToolCallingProvider(
  name: string,
  iterations: number,
): ModelProvider {
  let callCount = 0;
  return {
    name,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      callCount++;
      const promptLen = request.messages
        ? request.messages.map((m) => m.content).join('').length
        : (request.prompt?.length ?? 0);
      if (callCount <= iterations) {
        return {
          text: '',
          model: name,
          provider: name,
          usage: { promptTokens: promptLen || 10, completionTokens: 5 },
          toolCalls: [
            {
              id: `tc-${callCount}`,
              name: 'test.tool',
              arguments: { step: callCount },
            },
          ],
        };
      }
      return {
        text: `Final answer after ${iterations} tool iterations`,
        model: name,
        provider: name,
        usage: { promptTokens: promptLen || 10, completionTokens: 40 },
      };
    },
  };
}

/** Small delay helper */
export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
