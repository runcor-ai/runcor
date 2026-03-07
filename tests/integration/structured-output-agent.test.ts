// Integration tests for Agent outputSchema delegation
// Tests agent handler behavior when outputSchema is set — delegation to engine validation,
// local validation when tools are present, and __structured_output coexistence.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createEngine, Runcor } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';
import { createAgentHandler } from '../../src/agent/handler.js';
import type { AgentConfig, AgentResult } from '../../src/agent/types.js';
import type { ExecutionContext } from '../../src/types.js';
import type { ModelProvider, ModelRequest, ModelResponse } from '../../src/model/provider.js';

// ── Helpers ──

async function waitForCompletion(engine: Runcor, executionId: string, timeout = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for completion')), timeout);
    const check = async () => {
      const exec = await engine.getExecution(executionId);
      if (exec && (exec.state === 'complete' || exec.state === 'failed')) {
        clearTimeout(timer);
        resolve();
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });
}

const userSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number' },
  },
  required: ['name', 'age'],
};

/** Build a mock ExecutionContext with a custom model.complete and optional tools */
function buildMockContext(overrides: {
  executionId?: string;
  input?: unknown;
  complete: (request: ModelRequest) => Promise<ModelResponse>;
  tools?: ExecutionContext['tools'];
}): ExecutionContext {
  return {
    executionId: overrides.executionId ?? 'test-exec',
    input: overrides.input ?? 'test input',
    model: {
      complete: overrides.complete,
    },
    memory: {
      tool: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      },
      get user() { throw new Error('No user ID'); },
      get session() { throw new Error('No session ID'); },
    },
    cost: { executionTotal: 0, requestCount: 0 },
    telemetry: {
      startSpan: async (_name: string, fn: (span: any) => any) => fn({
        setAttribute: () => {},
        setStatus: () => {},
        recordException: () => {},
        end: () => {},
      }),
      addEvent: () => {},
      setAttribute: () => {},
    },
    tools: overrides.tools,
  };
}

/** Create a mock provider that returns responses in sequence */
function createSequenceProvider(name: string, responses: Array<{ text: string; toolCalls?: ModelResponse['toolCalls'] }>): {
  provider: ModelProvider;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  let callIndex = 0;
  const provider: ModelProvider = {
    name,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      requests.push({ ...request });
      const resp = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return {
        text: resp.text,
        model: `${name}-model`,
        provider: name,
        usage: { promptTokens: 10, completionTokens: resp.text.length },
        toolCalls: resp.toolCalls,
      };
    },
  };
  return { provider, requests };
}

// ── T039: Agent outputSchema delegation ──

describe('US4: Agent outputSchema delegation', () => {
  let engine: Runcor;

  afterEach(async () => {
    if (engine) await engine.shutdown();
  });

  it('should return parsed result when outputSchema set and valid JSON returned (no tools)', async () => {
    const provider = new MockProvider();
    provider.queueResponses([
      { text: '{"name":"John","age":30}' },
    ]);

    engine = await createEngine({
      model: { providers: [{ provider, priority: 1 }] },
    });

    const config: AgentConfig = {
      systemPrompt: 'Extract user info.',
      outputSchema: userSchema,
    };

    const handler = createAgentHandler(config);
    engine.register('agent-test', handler);

    const exec = await engine.trigger('agent-test', { idempotencyKey: 'a1', input: 'John is 30' });
    await waitForCompletion(engine, exec.id);

    const execution = await engine.getExecution(exec.id);
    expect(execution?.state).toBe('complete');

    const result = execution?.result as AgentResult;
    expect(result.stopReason).toBe('completed');
    expect(result.answer).toEqual({ name: 'John', age: 30 });
  });

  it('should return raw text when outputSchema is NOT set', async () => {
    const provider = new MockProvider();
    provider.queueResponses([
      { text: 'The answer is 42.' },
    ]);

    engine = await createEngine({
      model: { providers: [{ provider, priority: 1 }] },
    });

    const config: AgentConfig = {
      systemPrompt: 'Answer questions.',
      // No outputSchema
    };

    const handler = createAgentHandler(config);
    engine.register('agent-test', handler);

    const exec = await engine.trigger('agent-test', { idempotencyKey: 'a2', input: 'What is the answer?' });
    await waitForCompletion(engine, exec.id);

    const execution = await engine.getExecution(exec.id);
    expect(execution?.state).toBe('complete');

    const result = execution?.result as AgentResult;
    expect(result.answer).toBe('The answer is 42.');
  });

  it('should validate final answer locally when tools are present', async () => {
    // Build a mock provider that returns tool calls then a valid JSON answer
    const { provider, requests } = createSequenceProvider('mock', [
      {
        text: 'Let me look that up.',
        toolCalls: [{ id: 'tc1', name: 'lookup.data', arguments: { query: 'test' } }],
      },
      { text: '{"name":"Jane","age":25}' },
    ]);

    const config: AgentConfig = {
      systemPrompt: 'Extract user info using tools.',
      outputSchema: userSchema,
      tools: ['lookup.data'],
    };
    const handler = createAgentHandler(config);

    const toolsAccessor = {
      listTools: () => [{
        qualifiedName: 'lookup.data',
        adapterName: 'lookup',
        toolName: 'data',
        description: 'Look up data',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      }],
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: '{"name":"Jane","age":25}' }],
        isError: false,
      }),
    };

    const ctx = buildMockContext({
      complete: (req) => provider.complete(req),
      tools: toolsAccessor,
    });

    const result = await handler(ctx) as AgentResult;

    expect(result.stopReason).toBe('completed');
    expect(result.answer).toEqual({ name: 'Jane', age: 25 });
    expect(result.iterations).toHaveLength(2);
    // First request (tool iteration) should NOT have responseFormat
    expect(requests[0].responseFormat).toBeUndefined();
    // Tool was called
    expect(toolsAccessor.callTool).toHaveBeenCalledWith('lookup.data', { query: 'test' });
  });

  it('should retry within agent loop when final answer fails validation (tools present)', async () => {
    // First final answer is invalid (missing age), second is valid
    const { provider } = createSequenceProvider('mock', [
      { text: '{"name":"John"}' },        // Invalid — missing 'age'
      { text: '{"name":"John","age":30}' }, // Valid after retry hint
    ]);

    const config: AgentConfig = {
      systemPrompt: 'Extract user info.',
      outputSchema: userSchema,
      tools: ['lookup.data'],
      maxIterations: 10,
    };
    const handler = createAgentHandler(config);

    const toolsAccessor = {
      listTools: () => [{
        qualifiedName: 'lookup.data',
        adapterName: 'lookup',
        toolName: 'data',
        description: 'Look up data',
        inputSchema: { type: 'object' },
      }],
      callTool: vi.fn(),
    };

    const ctx = buildMockContext({
      complete: (req) => provider.complete(req),
      tools: toolsAccessor,
    });

    const result = await handler(ctx) as AgentResult;

    expect(result.stopReason).toBe('completed');
    expect(result.answer).toEqual({ name: 'John', age: 30 });
    // 2 iterations: first fails validation and retries, second succeeds
    expect(result.iterations).toHaveLength(2);
  });

  it('should use response.parsed when available from engine validation wrapper', async () => {
    // Simulate engine wrapper setting response.parsed
    const config: AgentConfig = {
      systemPrompt: 'Extract user info.',
      outputSchema: userSchema,
    };
    const handler = createAgentHandler(config);

    const ctx = buildMockContext({
      complete: async () => ({
        text: '{"name":"Alice","age":28}',
        model: 'test',
        provider: 'test',
        usage: { promptTokens: 10, completionTokens: 20 },
        parsed: { name: 'Alice', age: 28 }, // Set by engine validation wrapper
      }),
    });

    const result = await handler(ctx) as AgentResult;

    expect(result.stopReason).toBe('completed');
    expect(result.answer).toEqual({ name: 'Alice', age: 28 });
  });
});

// ── T040: Anthropic __structured_output coexistence ──

describe('US4: __structured_output coexistence', () => {
  it('should treat __structured_output tool call as final answer', async () => {
    // Provider returns a __structured_output tool call
    const { provider } = createSequenceProvider('mock', [
      {
        text: '',
        toolCalls: [{
          id: 'so-1',
          name: '__structured_output',
          arguments: { name: 'Bob', age: 42 },
        }],
      },
    ]);

    const config: AgentConfig = {
      systemPrompt: 'Extract user info.',
      outputSchema: userSchema,
      tools: ['lookup.data'],
    };
    const handler = createAgentHandler(config);

    const toolsAccessor = {
      listTools: () => [{
        qualifiedName: 'lookup.data',
        adapterName: 'lookup',
        toolName: 'data',
        description: 'Look up data',
        inputSchema: { type: 'object' },
      }],
      callTool: vi.fn(),
    };

    const ctx = buildMockContext({
      complete: (req) => provider.complete(req),
      tools: toolsAccessor,
    });

    const result = await handler(ctx) as AgentResult;

    expect(result.stopReason).toBe('completed');
    expect(result.answer).toEqual({ name: 'Bob', age: 42 });
    // __structured_output should NOT be executed as a tool
    expect(toolsAccessor.callTool).not.toHaveBeenCalled();
  });

  it('should continue iteration on real tool call then stop on __structured_output', async () => {
    // Iteration 1: real tool call → continue
    // Iteration 2: __structured_output → final answer
    const { provider } = createSequenceProvider('mock', [
      {
        text: 'Let me look that up.',
        toolCalls: [{ id: 'tc1', name: 'lookup.data', arguments: { query: 'test' } }],
      },
      {
        text: '',
        toolCalls: [{
          id: 'so-1',
          name: '__structured_output',
          arguments: { name: 'Charlie', age: 35 },
        }],
      },
    ]);

    const config: AgentConfig = {
      systemPrompt: 'Extract user info.',
      outputSchema: userSchema,
      tools: ['lookup.data'],
    };
    const handler = createAgentHandler(config);

    const toolsAccessor = {
      listTools: () => [{
        qualifiedName: 'lookup.data',
        adapterName: 'lookup',
        toolName: 'data',
        description: 'Look up data',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      }],
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: '{"found":"Charlie, age 35"}' }],
        isError: false,
      }),
    };

    const ctx = buildMockContext({
      complete: (req) => provider.complete(req),
      tools: toolsAccessor,
    });

    const result = await handler(ctx) as AgentResult;

    expect(result.stopReason).toBe('completed');
    expect(result.answer).toEqual({ name: 'Charlie', age: 35 });
    expect(result.iterations).toHaveLength(2);
    // Real tool was called in iteration 1
    expect(toolsAccessor.callTool).toHaveBeenCalledTimes(1);
    expect(toolsAccessor.callTool).toHaveBeenCalledWith('lookup.data', { query: 'test' });
  });
});
