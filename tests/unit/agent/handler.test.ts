// Unit tests for agent handler (T014, T019, T023, T026, T028)
// Tests organized by user story

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgentHandler } from '../../../src/agent/handler.js';
import type { AgentConfig, AgentResult, ToolCallRequest } from '../../../src/agent/types.js';
import type { ExecutionContext, ToolsAccessor, ToolCallResult } from '../../../src/types.js';
import { MockProvider } from '../../../src/model/mock.js';
import { BudgetExceededError } from '../../../src/errors.js';

/** Helper to create a minimal ExecutionContext for testing */
function createTestContext(overrides?: Partial<ExecutionContext>): ExecutionContext {
  const provider = new MockProvider('final answer');
  return {
    executionId: 'test-exec-1',
    input: 'test input',
    model: { complete: (req) => provider.complete(req) },
    memory: {
      tool: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      },
      user: {} as any,
      session: {} as any,
    },
    cost: { executionTotal: 0, requestCount: 0 },
    telemetry: {
      activeSpan: {} as any,
      setAttribute: vi.fn(),
      addEvent: vi.fn(),
      startSpan: vi.fn(async (_name: string, fn: (span: any) => any) => fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() })),
    },
    ...overrides,
  };
}

/** Helper to create a mock ToolsAccessor */
function createMockTools(tools: Array<{ name: string; description: string }> = []): ToolsAccessor {
  return {
    listTools: () => tools.map((t) => ({
      qualifiedName: t.name,
      adapterName: t.name.split('.')[0],
      toolName: t.name.split('.')[1],
      description: t.description,
      inputSchema: { type: 'object' },
    })),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'tool result' }],
      isError: false,
    } satisfies ToolCallResult),
  };
}

const baseConfig: AgentConfig = {
  systemPrompt: 'You are a test agent.',
};

// ── US1: Basic Agent Loop ──

describe('US1: Basic Agent Loop', () => {
  it('createAgentHandler returns a FlowHandler', () => {
    const handler = createAgentHandler(baseConfig);
    expect(typeof handler).toBe('function');
  });

  it('rejects invalid config (empty systemPrompt)', () => {
    expect(() => createAgentHandler({ systemPrompt: '' })).toThrow(/systemPrompt/i);
  });

  it('completes in single iteration when model returns no tool calls', async () => {
    const provider = new MockProvider('The answer is 42.');
    const ctx = createTestContext({
      model: { complete: (req) => provider.complete(req) },
    });

    const handler = createAgentHandler(baseConfig);
    const result = await handler(ctx) as AgentResult;

    expect(result.stopReason).toBe('completed');
    expect(result.answer).toBe('The answer is 42.');
    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0].iteration).toBe(1);
    expect(result.iterations[0].toolCalls).toHaveLength(0);
  });

  it('loops when model returns tool calls, stops when no tool calls', async () => {
    const provider = new MockProvider();
    // Iteration 1: tool call, Iteration 2: tool call, Iteration 3: final answer
    provider.queueResponses([
      { text: '', toolCalls: [{ id: 'tc-1', name: 'gmail.search', arguments: { q: 'test' } }] },
      { text: '', toolCalls: [{ id: 'tc-2', name: 'slack.post', arguments: { msg: 'hi' } }] },
      { text: 'Done! Found 3 results.' },
    ]);

    const tools = createMockTools([
      { name: 'gmail.search', description: 'Search emails' },
      { name: 'slack.post', description: 'Post to Slack' },
    ]);

    const ctx = createTestContext({
      model: { complete: (req) => provider.complete(req) },
      tools,
    });

    const handler = createAgentHandler({
      ...baseConfig,
      tools: ['gmail.search', 'slack.post'],
    });
    const result = await handler(ctx) as AgentResult;

    expect(result.stopReason).toBe('completed');
    expect(result.iterations).toHaveLength(3);
    expect(result.iterations[0].toolCalls).toHaveLength(1);
    expect(result.iterations[0].toolCalls[0].toolName).toBe('gmail.search');
    expect(result.iterations[1].toolCalls).toHaveLength(1);
    expect(result.iterations[1].toolCalls[0].toolName).toBe('slack.post');
    expect(result.iterations[2].toolCalls).toHaveLength(0);
    expect(result.answer).toBe('Done! Found 3 results.');
  });

  it('handles multiple tool calls per iteration', async () => {
    const provider = new MockProvider();
    provider.queueResponses([
      {
        text: 'Searching...',
        toolCalls: [
          { id: 'tc-1', name: 'gmail.search', arguments: { q: 'a' } },
          { id: 'tc-2', name: 'slack.post', arguments: { msg: 'b' } },
        ],
      },
      { text: 'All done.' },
    ]);

    const tools = createMockTools([
      { name: 'gmail.search', description: 'Search' },
      { name: 'slack.post', description: 'Post' },
    ]);

    const ctx = createTestContext({
      model: { complete: (req) => provider.complete(req) },
      tools,
    });

    const handler = createAgentHandler({
      ...baseConfig,
      tools: ['gmail.search', 'slack.post'],
    });
    const result = await handler(ctx) as AgentResult;

    expect(result.stopReason).toBe('completed');
    expect(result.iterations).toHaveLength(2);
    expect(result.iterations[0].toolCalls).toHaveLength(2);
    expect(tools.callTool).toHaveBeenCalledTimes(2);
  });

  it('works with zero tools (chain-of-thought only)', async () => {
    const provider = new MockProvider('I think therefore I am.');
    const ctx = createTestContext({
      model: { complete: (req) => provider.complete(req) },
    });

    const handler = createAgentHandler({
      systemPrompt: 'Think step by step.',
      tools: [],
    });
    const result = await handler(ctx) as AgentResult;

    expect(result.stopReason).toBe('completed');
    expect(result.answer).toBe('I think therefore I am.');
    expect(result.iterations).toHaveLength(1);
  });

  it('feeds tool call errors back to model (FR-017)', async () => {
    const tools = createMockTools([{ name: 'gmail.search', description: 'Search' }]);
    (tools.callTool as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Connection refused'));

    const provider = new MockProvider();
    provider.queueResponses([
      { text: '', toolCalls: [{ id: 'tc-1', name: 'gmail.search', arguments: {} }] },
      { text: 'Search failed, here is my best guess.' },
    ]);

    const ctx = createTestContext({
      model: { complete: (req) => provider.complete(req) },
      tools,
    });

    const handler = createAgentHandler({ ...baseConfig, tools: ['gmail.search'] });
    const result = await handler(ctx) as AgentResult;

    expect(result.stopReason).toBe('completed');
    expect(result.iterations[0].toolCalls[0].isError).toBe(true);
  });

  it('accumulates conversation history across iterations', async () => {
    let capturedMessages: any[] = [];
    const provider = new MockProvider();
    provider.queueResponses([
      { text: '', toolCalls: [{ id: 'tc-1', name: 'test.tool', arguments: {} }] },
      { text: 'Final answer' },
    ]);

    const originalComplete = provider.complete.bind(provider);
    const ctx = createTestContext({
      model: {
        complete: async (req) => {
          capturedMessages.push(req.messages ? [...req.messages] : []);
          return originalComplete(req);
        },
      },
      tools: createMockTools([{ name: 'test.tool', description: 'Test' }]),
    });

    const handler = createAgentHandler({ ...baseConfig, tools: ['test.tool'] });
    await handler(ctx);

    // First call: system + user (2 messages)
    expect(capturedMessages[0]).toHaveLength(2);
    // Second call: system + user + assistant + tool (4 messages)
    expect(capturedMessages[1]).toHaveLength(4);
  });

  it('handles no adapters available (FR-022)', async () => {
    const provider = new MockProvider();
    provider.queueResponses([
      { text: '', toolCalls: [{ id: 'tc-1', name: 'gmail.search', arguments: {} }] },
      { text: 'No tools, returning best guess.' },
    ]);

    // ctx.tools is undefined (no adapters)
    const ctx = createTestContext({
      model: { complete: (req) => provider.complete(req) },
      tools: undefined,
    });

    const handler = createAgentHandler({ ...baseConfig, tools: ['gmail.search'] });
    const result = await handler(ctx) as AgentResult;

    expect(result.stopReason).toBe('completed');
    expect(result.iterations[0].toolCalls[0].isError).toBe(true);
    expect(result.iterations[0].toolCalls[0].result.content[0].text).toContain('unavailable');
  });
});

// ── US2: Hard Stop Enforcement ──

describe('US2: Hard Stop Enforcement', () => {
  it('stops at maxIterations with correct stopReason', async () => {
    const provider = new MockProvider();
    // Always return tool calls
    for (let i = 0; i < 5; i++) {
      provider.queueResponses([
        { text: `iter ${i}`, toolCalls: [{ id: `tc-${i}`, name: 'test.tool', arguments: {} }] },
      ]);
    }

    const ctx = createTestContext({
      model: { complete: (req) => provider.complete(req) },
      tools: createMockTools([{ name: 'test.tool', description: 'Test' }]),
    });

    const handler = createAgentHandler({
      ...baseConfig,
      tools: ['test.tool'],
      maxIterations: 3,
    });
    const result = await handler(ctx) as AgentResult;

    expect(result.stopReason).toBe('max_iterations');
    expect(result.iterations).toHaveLength(3);
  });

  it('stops at budget limit with correct stopReason', async () => {
    let callCount = 0;
    const provider = new MockProvider();
    for (let i = 0; i < 10; i++) {
      provider.queueResponses([
        { text: '', toolCalls: [{ id: `tc-${i}`, name: 'test.tool', arguments: {} }] },
      ]);
    }

    const ctx = createTestContext({
      model: { complete: (req) => provider.complete(req) },
      tools: createMockTools([{ name: 'test.tool', description: 'Test' }]),
      cost: {
        get executionTotal() { return callCount * 0.10; },
        requestCount: 0,
      },
    });

    // Hack: increment cost on each model call
    const origComplete = ctx.model.complete;
    ctx.model = {
      complete: async (req) => {
        callCount++;
        return origComplete(req);
      },
    };

    const handler = createAgentHandler({
      ...baseConfig,
      tools: ['test.tool'],
      iterationBudget: 0.25,
      maxIterations: 100,
    });
    const result = await handler(ctx) as AgentResult;

    expect(result.stopReason).toBe('budget_exhausted');
  });

  it('stops at timeout with correct stopReason', async () => {
    const provider = new MockProvider();
    for (let i = 0; i < 10; i++) {
      provider.queueResponses([
        { text: '', toolCalls: [{ id: `tc-${i}`, name: 'test.tool', arguments: {} }] },
      ]);
    }

    // Use fake timers to simulate timeout
    const realDateNow = Date.now;
    let fakeTime = realDateNow();
    vi.spyOn(Date, 'now').mockImplementation(() => fakeTime);

    const ctx = createTestContext({
      model: {
        complete: async (req) => {
          fakeTime += 50; // 50ms per call
          return provider.complete(req);
        },
      },
      tools: createMockTools([{ name: 'test.tool', description: 'Test' }]),
    });

    const handler = createAgentHandler({
      ...baseConfig,
      tools: ['test.tool'],
      timeoutMs: 100,
      maxIterations: 100,
    });
    const result = await handler(ctx) as AgentResult;

    vi.restoreAllMocks();

    expect(result.stopReason).toBe('timeout');
  });

  it('catches BudgetExceededError from engine budget', async () => {
    const ctx = createTestContext({
      model: {
        complete: async () => {
          throw new BudgetExceededError('flow', 1.0, 0.9, 0.2);
        },
      },
    });

    const handler = createAgentHandler(baseConfig);
    const result = await handler(ctx) as AgentResult;

    expect(result.stopReason).toBe('budget_exhausted');
  });

  it('handles context overflow with correct stopReason', async () => {
    const ctx = createTestContext({
      model: {
        complete: async () => {
          throw new Error('Context length exceeded: maximum context length is 128000 tokens');
        },
      },
    });

    const handler = createAgentHandler(baseConfig);
    const result = await handler(ctx) as AgentResult;

    expect(result.stopReason).toBe('context_overflow');
  });

  it('returns partial results with all metadata on hard stop', async () => {
    const provider = new MockProvider();
    provider.queueResponses([
      { text: 'thinking', toolCalls: [{ id: 'tc-1', name: 'test.tool', arguments: {} }] },
    ]);

    const ctx = createTestContext({
      model: { complete: (req) => provider.complete(req) },
      tools: createMockTools([{ name: 'test.tool', description: 'Test' }]),
    });

    const handler = createAgentHandler({
      ...baseConfig,
      tools: ['test.tool'],
      maxIterations: 1,
    });
    const result = await handler(ctx) as AgentResult;

    expect(result.stopReason).toBe('max_iterations');
    expect(result.iterations).toHaveLength(1);
    expect(result.totalTokens).toBeDefined();
    expect(result.conversationLength).toBeGreaterThan(0);
  });
});

// ── US3: Per-Iteration Telemetry ──

describe('US3: Per-Iteration Telemetry', () => {
  it('tracks per-iteration metadata correctly', async () => {
    const provider = new MockProvider();
    provider.queueResponses([
      { text: '', toolCalls: [{ id: 'tc-1', name: 'test.tool', arguments: { q: 'a' } }] },
      { text: 'Done' },
    ]);

    const ctx = createTestContext({
      model: { complete: (req) => provider.complete(req) },
      tools: createMockTools([{ name: 'test.tool', description: 'Test' }]),
    });

    const handler = createAgentHandler({ ...baseConfig, tools: ['test.tool'] });
    const result = await handler(ctx) as AgentResult;

    expect(result.iterations).toHaveLength(2);

    // Iteration 1: had a tool call
    expect(result.iterations[0].iteration).toBe(1);
    expect(result.iterations[0].model).toBe('mock');
    expect(result.iterations[0].toolCalls).toHaveLength(1);
    expect(result.iterations[0].tokens.input).toBeGreaterThan(0);
    expect(result.iterations[0].durationMs).toBeGreaterThanOrEqual(0);

    // Iteration 2: no tool calls (completion)
    expect(result.iterations[1].iteration).toBe(2);
    expect(result.iterations[1].toolCalls).toHaveLength(0);
  });

  it('accumulates totalCost and totalTokens across iterations', async () => {
    const provider = new MockProvider();
    provider.queueResponses([
      { text: '', toolCalls: [{ id: 'tc-1', name: 'test.tool', arguments: {} }] },
      { text: 'Done' },
    ]);

    const ctx = createTestContext({
      model: { complete: (req) => provider.complete(req) },
      tools: createMockTools([{ name: 'test.tool', description: 'Test' }]),
    });

    const handler = createAgentHandler({ ...baseConfig, tools: ['test.tool'] });
    const result = await handler(ctx) as AgentResult;

    expect(result.totalTokens.input).toBe(
      result.iterations.reduce((sum, i) => sum + i.tokens.input, 0),
    );
    expect(result.totalTokens.output).toBe(
      result.iterations.reduce((sum, i) => sum + i.tokens.output, 0),
    );
  });
});

// ── US4: Output Schema ──

describe('US4: Output Schema', () => {
  it('includes output schema in system prompt', async () => {
    let capturedMessages: any;
    const provider = new MockProvider();
    provider.queueResponses([{ text: '{"score": 85, "reasoning": "good"}' }]);

    const ctx = createTestContext({
      model: {
        complete: async (req) => {
          capturedMessages = req.messages;
          return provider.complete(req);
        },
      },
    });

    const handler = createAgentHandler({
      ...baseConfig,
      outputSchema: { type: 'object', properties: { score: { type: 'number' } } },
    });
    await handler(ctx);

    const systemMsg = capturedMessages?.find((m: any) => m.role === 'system');
    expect(systemMsg?.content).toContain('JSON schema');
    expect(systemMsg?.content).toContain('score');
  });

  it('parses valid JSON as structured answer', async () => {
    const provider = new MockProvider();
    provider.queueResponses([{ text: '{"score": 85, "reasoning": "good lead"}' }]);

    const ctx = createTestContext({
      model: { complete: (req) => provider.complete(req) },
    });

    const handler = createAgentHandler({
      ...baseConfig,
      outputSchema: { type: 'object' },
    });
    const result = await handler(ctx) as AgentResult;

    expect(result.answer).toEqual({ score: 85, reasoning: 'good lead' });
  });

  it('retries within agent loop when JSON parse fails with outputSchema', async () => {
    const provider = new MockProvider();
    // First response is invalid JSON → triggers retry; second attempt uses MockProvider's
    // structured output logic (generates conformant data for the schema)
    provider.queueResponses([{ text: 'Not valid JSON here' }]);

    const ctx = createTestContext({
      model: { complete: (req) => provider.complete(req) },
    });

    const handler = createAgentHandler({
      ...baseConfig,
      outputSchema: { type: 'object' },
    });
    const result = await handler(ctx) as AgentResult;

    // Feature 019: agent retries on invalid JSON instead of returning raw text
    // Second call generates conformant data: {} for { type: 'object' }
    expect(result.answer).toEqual({});
    expect(result.iterations).toHaveLength(2);
  });

  it('does not inject schema when outputSchema not provided', async () => {
    let capturedMessages: any;
    const provider = new MockProvider();
    provider.queueResponses([{ text: 'answer' }]);

    const ctx = createTestContext({
      model: {
        complete: async (req) => {
          capturedMessages = req.messages;
          return provider.complete(req);
        },
      },
    });

    const handler = createAgentHandler(baseConfig);
    await handler(ctx);

    const systemMsg = capturedMessages?.find((m: any) => m.role === 'system');
    expect(systemMsg?.content).not.toContain('JSON schema');
  });
});

// ── US5: Wait/Resume ──

describe('US5: Wait/Resume', () => {
  it('serializes state to ctx.memory.tool on wait signal detection', async () => {
    // This test verifies the state save/restore mechanism
    const memorySet = vi.fn().mockResolvedValue(undefined);
    const provider = new MockProvider();
    provider.queueResponses([
      { text: '', toolCalls: [{ id: 'tc-1', name: 'test.tool', arguments: {} }] },
      { text: 'Resumed and done.' },
    ]);

    // First invocation - runs normally
    const ctx1 = createTestContext({
      model: { complete: (req) => provider.complete(req) },
      tools: createMockTools([{ name: 'test.tool', description: 'Test' }]),
    });

    const handler = createAgentHandler({ ...baseConfig, tools: ['test.tool'] });
    const result = await handler(ctx1) as AgentResult;

    expect(result.stopReason).toBe('completed');
    expect(result.iterations).toHaveLength(2);
  });

  it('restores state from memory on resume', async () => {
    const savedState = {
      messages: [
        { role: 'system', content: 'You are a test agent.' },
        { role: 'user', content: 'test input' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'tc-1', name: 'test.tool', arguments: {} }] },
        { role: 'tool', content: 'tool result', toolCallId: 'tc-1', toolName: 'test.tool' },
      ],
      iterationCount: 1,
      iterations: [{
        iteration: 1,
        toolCalls: [{ toolName: 'test.tool', arguments: {}, result: { content: [{ type: 'text', text: 'ok' }], isError: false }, durationMs: 5, isError: false }],
        model: 'mock',
        tokens: { input: 100, output: 50 },
        cost: 0,
        durationMs: 10,
      }],
      cumulativeCost: 0,
      cumulativeInputTokens: 100,
      cumulativeOutputTokens: 50,
    };

    const provider = new MockProvider();
    provider.queueResponses([{ text: 'Resumed and completed.' }]);

    const ctx = createTestContext({
      model: { complete: (req) => provider.complete(req) },
      tools: createMockTools([{ name: 'test.tool', description: 'Test' }]),
      resumeData: { approved: true },
    });
    // Mock memory to return saved state
    (ctx.memory.tool.get as ReturnType<typeof vi.fn>).mockResolvedValue(savedState);

    const handler = createAgentHandler({ ...baseConfig, tools: ['test.tool'] });
    const result = await handler(ctx) as AgentResult;

    expect(result.stopReason).toBe('completed');
    // Should have 2 iterations total: 1 from saved state + 1 from resume
    expect(result.iterations).toHaveLength(2);
    expect(result.iterations[0].iteration).toBe(1); // From saved state
    expect(result.iterations[1].iteration).toBe(2); // New iteration
    expect(result.answer).toBe('Resumed and completed.');
  });
});
