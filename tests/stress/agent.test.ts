// Stress test: Agent loop under pressure
import { describe, it, expect, afterEach } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { createAgentHandler } from '../../src/agent/handler.js';
import type { Runcor } from '../../src/engine.js';
import type { ModelProvider, ModelRequest, ModelResponse } from '../../src/model/provider.js';
import type { AgentResult } from '../../src/agent/types.js';

/** Provider that returns tool calls for N iterations, then a final answer */
class ToolCallingProvider implements ModelProvider {
  readonly name = 'tool-caller';
  private callCounts = new Map<string, number>();
  private readonly toolIterations: number;

  constructor(toolIterations: number) {
    this.toolIterations = toolIterations;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    // Track per-conversation call count using first user message as key
    const key = request.messages?.find((m) => m.role === 'user')?.content ?? 'default';
    const count = (this.callCounts.get(key) ?? 0) + 1;
    this.callCounts.set(key, count);

    const prompt = request.messages?.map((m) => m.content).join('\n') ?? request.prompt;

    if (count <= this.toolIterations) {
      // Return tool calls
      return {
        text: '',
        model: 'tool-caller',
        provider: 'tool-caller',
        usage: { promptTokens: prompt.length, completionTokens: 10 },
        toolCalls: [
          {
            id: `tc-${count}`,
            name: 'test.lookup',
            arguments: { query: `iteration-${count}` },
          },
        ],
      };
    }

    // Final answer — no tool calls
    return {
      text: `Final answer after ${count - 1} iterations`,
      model: 'tool-caller',
      provider: 'tool-caller',
      usage: { promptTokens: prompt.length, completionTokens: 30 },
    };
  }
}

/** Provider that always returns tool calls (never answers) — for max iteration testing */
class InfiniteToolProvider implements ModelProvider {
  readonly name = 'infinite-tool';

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const prompt = request.messages?.map((m) => m.content).join('\n') ?? request.prompt;
    return {
      text: '',
      model: 'infinite-tool',
      provider: 'infinite-tool',
      usage: { promptTokens: prompt.length, completionTokens: 10 },
      toolCalls: [
        { id: `tc-${Date.now()}`, name: 'test.action', arguments: {} },
      ],
    };
  }
}

describe('Stress: Agent', () => {
  let engine: Runcor;

  afterEach(async () => {
    await engine?.shutdown();
  });

  it('should hit 25 max iterations and return max_iterations stop reason', async () => {
    engine = await createEngine({
      model: { provider: new InfiniteToolProvider() },
      concurrency: 5,
    });

    // Mock tool accessor via adapter manager is complex; test via direct handler
    const handler = createAgentHandler({
      systemPrompt: 'You are a test agent.',
      maxIterations: 25,
    });

    engine.register('max-iter-agent', handler, { maxRetries: 0, timeout: 30000 });

    const exec = await engine.trigger('max-iter-agent', {
      idempotencyKey: 'max-iter-1',
      input: 'Run until stopped',
    });

    // Wait for completion
    await new Promise<void>((resolve) => {
      engine.on('execution:complete', ({ executionId }) => {
        if (executionId === exec.id) resolve();
      });
      engine.on('execution:state_change', ({ executionId, to }) => {
        if (executionId === exec.id && (to === 'complete' || to === 'failed')) resolve();
      });
    });

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');

    const result = final!.result as AgentResult;
    expect(result.stopReason).toBe('max_iterations');
    expect(result.iterations.length).toBe(25);
  }, 30000);

  it('should run 10 concurrent agent executions without cross-agent state leakage', async () => {
    engine = await createEngine({
      model: { provider: new ToolCallingProvider(3) },
      concurrency: 10,
    });

    const handler = createAgentHandler({
      systemPrompt: 'You are a test agent.',
      maxIterations: 10,
    });

    engine.register('concurrent-agent', handler, { maxRetries: 0, timeout: 15000 });

    const total = 10;
    let completed = 0;
    const allDone = new Promise<void>((resolve) => {
      engine.on('execution:complete', () => {
        completed++;
        if (completed >= total) resolve();
      });
    });

    const executions = [];
    for (let i = 0; i < total; i++) {
      const exec = await engine.trigger('concurrent-agent', {
        idempotencyKey: `ca-${i}`,
        input: `Agent query ${i}`,
      });
      executions.push(exec);
    }

    await allDone;
    await new Promise((r) => setTimeout(r, 200));

    // All should complete successfully
    for (const exec of executions) {
      const final = await engine.getExecution(exec.id);
      expect(final!.state).toBe('complete');

      const result = final!.result as AgentResult;
      expect(result.stopReason).toBe('completed');
      // Each agent should have its own iteration history (no leakage)
      expect(result.iterations.length).toBeGreaterThan(0);
    }
  }, 30000);

  it('should handle tool call failures in every iteration without crashing', async () => {
    // Provider that always asks for tools
    const provider: ModelProvider = {
      name: 'fail-tools',
      async complete(request: ModelRequest): Promise<ModelResponse> {
        const prompt = request.messages?.map((m) => m.content).join('\n') ?? request.prompt;
        // Check if we've seen error results — if so, give final answer
        const hasErrors = request.messages?.some(
          (m) => m.role === 'tool' && m.content.includes('Error'),
        );
        const toolMessages = request.messages?.filter((m) => m.role === 'tool') ?? [];

        if (toolMessages.length >= 3) {
          return {
            text: 'Done after errors',
            model: 'fail-tools',
            provider: 'fail-tools',
            usage: { promptTokens: prompt.length, completionTokens: 15 },
          };
        }

        return {
          text: '',
          model: 'fail-tools',
          provider: 'fail-tools',
          usage: { promptTokens: prompt.length, completionTokens: 10 },
          toolCalls: [
            { id: `tc-${Date.now()}`, name: 'broken.tool', arguments: {} },
          ],
        };
      },
    };

    engine = await createEngine({
      model: { provider },
      concurrency: 5,
    });

    const handler = createAgentHandler({
      systemPrompt: 'You are a test agent.',
      maxIterations: 10,
    });

    engine.register('error-agent', handler, { maxRetries: 0, timeout: 15000 });

    const exec = await engine.trigger('error-agent', {
      idempotencyKey: 'error-agent-1',
      input: 'Test with failing tools',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', ({ executionId }) => {
        if (executionId === exec.id) resolve();
      });
      engine.on('execution:state_change', ({ executionId, to }) => {
        if (executionId === exec.id && to === 'failed') resolve();
      });
    });

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');

    const result = final!.result as AgentResult;
    expect(result.stopReason).toBe('completed');
    // Tool errors should be accumulated in iterations
    for (const iter of result.iterations) {
      if (iter.toolCalls.length > 0) {
        expect(iter.toolCalls[0].isError).toBe(true);
      }
    }
  }, 30000);

  it('should stop agent on timeout mid-loop', async () => {
    // Provider with small latency per call so timeout hits before max iterations
    const slowInfiniteProvider: ModelProvider = {
      name: 'slow-infinite',
      async complete(request: ModelRequest): Promise<ModelResponse> {
        await new Promise((r) => setTimeout(r, 30)); // 30ms per iteration
        const prompt = request.messages?.map((m) => m.content).join('\n') ?? request.prompt;
        return {
          text: '',
          model: 'slow-infinite',
          provider: 'slow-infinite',
          usage: { promptTokens: prompt.length, completionTokens: 10 },
          toolCalls: [
            { id: `tc-${Date.now()}`, name: 'test.action', arguments: {} },
          ],
        };
      },
    };

    engine = await createEngine({
      model: { provider: slowInfiniteProvider },
      concurrency: 5,
    });

    const handler = createAgentHandler({
      systemPrompt: 'You are a test agent.',
      maxIterations: 1000, // Very high — timeout should hit first
      timeoutMs: 300, // 300ms timeout with 30ms/iteration = ~10 iterations before timeout
    });

    engine.register('timeout-agent', handler, { maxRetries: 0, timeout: 30000 });

    const exec = await engine.trigger('timeout-agent', {
      idempotencyKey: 'timeout-1',
      input: 'Run until timeout',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', ({ executionId }) => {
        if (executionId === exec.id) resolve();
      });
      engine.on('execution:state_change', ({ executionId, to }) => {
        if (executionId === exec.id && (to === 'complete' || to === 'failed')) resolve();
      });
    });

    await new Promise((r) => setTimeout(r, 100));

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');

    const result = final!.result as AgentResult;
    expect(result.stopReason).toBe('timeout');
    expect(result.iterations.length).toBeGreaterThan(0);
    expect(result.iterations.length).toBeLessThan(1000);
  }, 30000);
});
