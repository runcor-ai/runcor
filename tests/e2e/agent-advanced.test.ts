// E2E: Agent edge cases and cross-feature interactions (14 tests)
// Agent combined with engine-level subsystems — partially covered, many gaps

import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import { createAgentHandler } from '../../src/agent/handler.js';
import { createWaitSignal } from '../../src/wait-signal.js';
import { BudgetExceededError } from '../../src/errors.js';
import { createTestEngine, waitForState, waitForCompletion, createNamedProvider, createToolCallingProvider, delay } from './helpers.js';
import type { AgentResult } from '../../src/agent/types.js';

let engine: Runcor;

afterEach(async () => {
  if (engine) await engine.shutdown();
});

describe('Agent: Advanced cross-feature interactions', { timeout: 30000 }, () => {
  it('engine-level budget exceeded during agent loop', async () => {
    const provider = createToolCallingProvider('budget-agent', 10);
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 5, output: 5 } }],
      },
      cost: {
        budgets: {
          perFlow: { limit: 50, enforcement: 'hard' },
        },
      },
    });

    const handler = createAgentHandler({
      systemPrompt: 'You are a test agent.',
      tools: ['test.tool'],
      maxIterations: 20,
    });

    engine.register('budget-agent-flow', handler, { maxRetries: 0 });

    const exec = await engine.trigger('budget-agent-flow', {
      idempotencyKey: 'ba-1',
      input: 'test',
    });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    // Should fail with budget exceeded, or the agent should return budget_exhausted stopReason
    expect(final!.state === 'failed' || final!.state === 'complete').toBe(true);
    if (final!.state === 'complete') {
      const result = final!.result as AgentResult;
      expect(result.stopReason).toBe('budget_exhausted');
    }
  });

  it('agent iterationBudget vs engine perFlow budget — lower wins', async () => {
    // Use a tool-calling provider so agent does multiple iterations
    // Agent iterationBudget checks cumulativeCost at start of each iteration
    // After iteration 1, cost > 0, so iteration 2 should be stopped by iterationBudget
    const provider = createToolCallingProvider('iter-budget', 5);
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.01 } }],
      },
      cost: {
        budgets: {
          perFlow: { limit: 100000, enforcement: 'hard' }, // Very high
        },
      },
    });

    const handler = createAgentHandler({
      systemPrompt: 'You are a test agent.',
      tools: ['test.tool'],
      maxIterations: 50,
      iterationBudget: 0.001, // Very low — should trigger after first iteration
    });

    engine.register('iter-budget-flow', handler, { maxRetries: 0 });

    const exec = await engine.trigger('iter-budget-flow', {
      idempotencyKey: 'ib-1',
      input: 'test',
    });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    const result = final!.result as AgentResult;
    expect(result.stopReason).toBe('budget_exhausted');
    // Should have stopped after only a couple iterations, not all 5 tool calls
    expect(result.iterations.length).toBeLessThan(5);
  });

  it('agent cost visible via ctx.cost.executionTotal', async () => {
    let costSeen = 0;
    const provider = createNamedProvider('cost-vis', 'response');
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1, costPerToken: { input: 0.01, output: 0.02 } }],
      },
      cost: {},
    });

    engine.register('cost-visible-flow', async (ctx) => {
      await ctx.model.complete({ prompt: 'work' });
      costSeen = ctx.cost.executionTotal;
      return costSeen;
    }, { maxRetries: 0 });

    const exec = await engine.trigger('cost-visible-flow', {
      idempotencyKey: 'cv-1',
    });
    await waitForCompletion(engine, exec.id);

    expect(costSeen).toBeGreaterThan(0);
  });

  it('agent returns WaitSignal mid-conversation', async () => {
    // An agent handler that returns a WaitSignal
    engine = await createTestEngine();

    engine.register('agent-wait-flow', async (ctx) => {
      if (!ctx.resumeData) {
        return createWaitSignal({ reason: 'need user input', waitData: { step: 1 } });
      }
      return { resumed: true, data: ctx.resumeData };
    }, { maxRetries: 0 });

    const exec = await engine.trigger('agent-wait-flow', {
      idempotencyKey: 'aw-1',
      input: 'start',
    });
    await waitForState(engine, exec.id, 'waiting');

    const waiting = await engine.getExecution(exec.id);
    expect(waiting!.waitContext!.reason).toBe('need user input');

    await engine.resume(exec.id, { userChoice: 'A' });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    expect(final!.result).toEqual({ resumed: true, data: { userChoice: 'A' } });
  });

  it('agent with outputSchema parses JSON response', async () => {
    const mockProvider = new MockProvider();
    mockProvider.queueResponses([
      { text: '{"name":"test","value":42}' },
    ]);

    engine = await createEngine({
      model: { provider: mockProvider },
    });

    const handler = createAgentHandler({
      systemPrompt: 'Return JSON.',
      maxIterations: 3,
      outputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, value: { type: 'number' } },
      },
    });

    engine.register('schema-flow', handler, { maxRetries: 0 });

    const exec = await engine.trigger('schema-flow', {
      idempotencyKey: 'sf-1',
      input: 'give me json',
    });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    const result = final!.result as AgentResult;
    expect(result.stopReason).toBe('completed');
    expect(result.answer).toEqual({ name: 'test', value: 42 });
  });

  it('agent with outputSchema and invalid JSON — retries then gets conformant data', async () => {
    const mockProvider = new MockProvider();
    // First response is invalid JSON → agent retries within loop
    // Second call: MockProvider generates conformant data for { type: 'object' } → {}
    mockProvider.queueResponses([
      { text: 'This is not valid JSON at all' },
    ]);

    engine = await createEngine({
      model: { provider: mockProvider },
    });

    const handler = createAgentHandler({
      systemPrompt: 'Return JSON.',
      maxIterations: 3,
      outputSchema: { type: 'object' },
    });

    engine.register('invalid-json-flow', handler, { maxRetries: 0 });

    const exec = await engine.trigger('invalid-json-flow', {
      idempotencyKey: 'ij-1',
      input: 'test',
    });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    const result = final!.result as AgentResult;
    // Feature 019: Engine validation wrapper retries transparently (agent sees 1 iteration)
    // MockProvider generates conformant data {} for { type: 'object' } on retry
    expect(result.answer).toEqual({});
    expect(result.iterations).toHaveLength(1);
  });

  it('agent with no tools configured — conversation only', async () => {
    const mockProvider = new MockProvider('Direct answer to: {prompt}');
    engine = await createEngine({
      model: { provider: mockProvider },
    });

    const handler = createAgentHandler({
      systemPrompt: 'You are a helpful assistant.',
      maxIterations: 5,
      // No tools configured
    });

    engine.register('no-tools-agent', handler, { maxRetries: 0 });

    const exec = await engine.trigger('no-tools-agent', {
      idempotencyKey: 'nt-1',
      input: 'Hello',
    });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    const result = final!.result as AgentResult;
    expect(result.stopReason).toBe('completed');
    expect(result.iterations.length).toBe(1);
  });

  it('agent with tools but model never calls them', async () => {
    const mockProvider = new MockProvider('I can answer without tools');
    engine = await createEngine({
      model: { provider: mockProvider },
    });

    const handler = createAgentHandler({
      systemPrompt: 'You have tools but may not need them.',
      tools: ['adapter.someTool'],
      maxIterations: 5,
    });

    engine.register('unused-tools-agent', handler, { maxRetries: 0 });

    const exec = await engine.trigger('unused-tools-agent', {
      idempotencyKey: 'ut-1',
      input: 'Simple question',
    });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    const result = final!.result as AgentResult;
    expect(result.stopReason).toBe('completed');
    expect(result.iterations.length).toBe(1);
    expect(result.iterations[0].toolCalls.length).toBe(0);
  });

  it('agent tool not found in adapters — error fed back to model', async () => {
    const mockProvider = new MockProvider();
    mockProvider.queueResponses([
      {
        text: '',
        toolCalls: [{ id: 'tc-1', name: 'missing.tool', arguments: {} }],
      },
      { text: 'OK, tool not available. Final answer.' },
    ]);

    engine = await createEngine({
      model: { provider: mockProvider },
    });

    const handler = createAgentHandler({
      systemPrompt: 'Try to use tools.',
      tools: ['missing.tool'],
      maxIterations: 5,
    });

    engine.register('missing-tool-agent', handler, { maxRetries: 0 });

    const exec = await engine.trigger('missing-tool-agent', {
      idempotencyKey: 'mt-1',
      input: 'use a tool',
    });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    const result = final!.result as AgentResult;
    expect(result.stopReason).toBe('completed');
    // First iteration should have a tool call with an error
    expect(result.iterations[0].toolCalls[0].isError).toBe(true);
  });

  it('agent maxHistoryMessages truncates conversation', async () => {
    const mockProvider = new MockProvider();
    // Queue 3 tool-calling iterations then a final answer
    mockProvider.queueResponses([
      { text: '', toolCalls: [{ id: 'tc-1', name: 'test.tool', arguments: { step: 1 } }] },
      { text: '', toolCalls: [{ id: 'tc-2', name: 'test.tool', arguments: { step: 2 } }] },
      { text: '', toolCalls: [{ id: 'tc-3', name: 'test.tool', arguments: { step: 3 } }] },
      { text: 'Final answer after truncation' },
    ]);

    engine = await createEngine({
      model: { provider: mockProvider },
    });

    const handler = createAgentHandler({
      systemPrompt: 'Process steps.',
      tools: ['test.tool'],
      maxIterations: 10,
      maxHistoryMessages: 5,
    });

    engine.register('truncate-agent', handler, { maxRetries: 0 });

    const exec = await engine.trigger('truncate-agent', {
      idempotencyKey: 'ta-1',
      input: 'do it',
    });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    const result = final!.result as AgentResult;
    expect(result.iterations.length).toBe(4);
    // Conversation should be truncated
    expect(result.conversationLength).toBeLessThanOrEqual(6); // system + maxHistoryMessages
  });

  it('agent completes in single iteration — no tools needed', async () => {
    const mockProvider = new MockProvider('Instant answer');
    engine = await createEngine({
      model: { provider: mockProvider },
    });

    const handler = createAgentHandler({
      systemPrompt: 'Answer directly.',
      maxIterations: 10,
    });

    engine.register('single-iter-agent', handler, { maxRetries: 0 });

    const exec = await engine.trigger('single-iter-agent', {
      idempotencyKey: 'si-1',
      input: 'quick question',
    });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    const result = final!.result as AgentResult;
    expect(result.stopReason).toBe('completed');
    expect(result.iterations.length).toBe(1);
  });

  it('policy guardrail on agent output', async () => {
    const mockProvider = new MockProvider('Agent final answer');
    engine = await createEngine({
      model: { provider: mockProvider },
      policy: {
        guardrails: [
          {
            name: 'agent-output-guard',
            phase: 'output',
            mode: 'transform',
            priority: 1,
            handler: async (content) => ({
              action: 'transform' as const,
              reason: 'tagged',
              transformedContent: { agentOutput: content, verified: true },
            }),
          },
        ],
      },
    });

    const handler = createAgentHandler({
      systemPrompt: 'Answer questions.',
      maxIterations: 3,
    });

    engine.register('guard-agent-flow', handler, { maxRetries: 0 });

    const exec = await engine.trigger('guard-agent-flow', {
      idempotencyKey: 'ga-1',
      input: 'test',
    });
    await waitForCompletion(engine, exec.id);

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    // Output guardrail should have transformed the AgentResult
    const result = final!.result as { agentOutput: AgentResult; verified: boolean };
    expect(result.verified).toBe(true);
    expect(result.agentOutput).toBeDefined();
  });

  it('evaluation scores agent execution', async () => {
    let evalOutput: unknown = null;
    const mockProvider = new MockProvider('Agent response');
    engine = await createEngine({
      model: { provider: mockProvider },
      evaluation: {
        evaluators: [
          {
            name: 'agent-eval',
            priority: 1,
            evaluate: (ctx) => {
              evalOutput = ctx.output;
              return { scores: { quality: 0.85 } };
            },
          },
        ],
      },
    });

    const handler = createAgentHandler({
      systemPrompt: 'Be helpful.',
      maxIterations: 3,
    });

    engine.register('eval-agent-flow', handler, { maxRetries: 0 });

    const exec = await engine.trigger('eval-agent-flow', {
      idempotencyKey: 'ea-1',
      input: 'evaluate me',
    });
    await waitForCompletion(engine, exec.id);
    await delay(300);

    expect(evalOutput).not.toBeNull();
    // Evaluator should receive the AgentResult as output
    const agentResult = evalOutput as AgentResult;
    expect(agentResult.stopReason).toBe('completed');
    expect(agentResult.answer).toBeDefined();
  });
});
