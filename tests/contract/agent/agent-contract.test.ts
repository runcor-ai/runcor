// Contract tests for agent execution pattern (T016, T030)
// Validates public API contracts

import { describe, it, expect, vi } from 'vitest';
import { createAgentHandler } from '../../../src/agent/handler.js';
import type { AgentConfig, AgentResult, ToolCallRequest } from '../../../src/agent/types.js';
import { validateAgentConfig } from '../../../src/agent/types.js';
import type { ExecutionContext, ToolsAccessor } from '../../../src/types.js';
import { MockProvider } from '../../../src/model/mock.js';
import type { ModelRequest, ModelResponse } from '../../../src/model/provider.js';

/**
 * T030: Agent as MCP Tool contract test.
 * Verifies that agents registered as flows appear identically to regular flows
 * from the MCP perspective — same registration, same invocation, same result shape.
 * The agent is just a flow whose handler loops internally.
 */
describe('T030: Agent as MCP Tool', () => {
  it('agent handler is a standard FlowHandler — no special MCP handling needed', () => {
    // An agent is just a flow handler. When registered with engine.register(),
    // it appears as an MCP tool exactly like any other flow.
    // This contract test verifies the type compatibility.
    const config: AgentConfig = {
      systemPrompt: 'You are a scoring agent.',
      tools: ['crm.lookup'],
      maxIterations: 5,
    };

    const handler = createAgentHandler(config);

    // FlowHandler signature: (ctx: ExecutionContext) => Promise<unknown>
    // Agent handler conforms to this — it returns Promise<AgentResult>
    // which is assignable to Promise<unknown>
    expect(typeof handler).toBe('function');
    expect(handler.length).toBe(1); // Single ctx parameter
  });

  it('agent result is serializable for MCP transport', async () => {
    const provider = new MockProvider();
    provider.queueResponses([{ text: '{"score": 85, "reasoning": "Good engagement"}' }]);
    const config: AgentConfig = {
      systemPrompt: 'You are a scoring agent.',
      outputSchema: { type: 'object', properties: { score: { type: 'number' } } },
    };
    const handler = createAgentHandler(config);

    const ctx: ExecutionContext = {
      executionId: 'mcp-contract-test',
      input: 'Score lead X',
      model: { complete: (req) => provider.complete(req) },
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
        startSpan: async (_name: string, fn: (span: any) => any) => fn({ setAttribute: () => {}, setStatus: () => {}, recordException: () => {}, end: () => {} }),
        addEvent: () => {},
        setAttribute: () => {},
      },
    };

    const result = await handler(ctx) as AgentResult;

    // AgentResult must be JSON-serializable for MCP transport
    const serialized = JSON.stringify(result);
    const parsed = JSON.parse(serialized);

    expect(parsed.stopReason).toBe('completed');
    expect(parsed.answer).toEqual({ score: 85, reasoning: 'Good engagement' });
    expect(parsed.iterations).toHaveLength(1);
    expect(typeof parsed.totalCost).toBe('number');
    expect(typeof parsed.conversationLength).toBe('number');
  });
});

describe('Agent Contract Tests', () => {
  describe('T016: createAgentHandler returns valid FlowHandler', () => {
    it('returns a function (FlowHandler signature)', () => {
      const config: AgentConfig = {
        systemPrompt: 'You are a test agent.',
      };
      const handler = createAgentHandler(config);

      expect(typeof handler).toBe('function');
      expect(handler.length).toBe(1); // Accepts one argument (ExecutionContext)
    });

    it('FlowHandler returns a Promise<AgentResult>', async () => {
      const provider = new MockProvider('test answer');
      const config: AgentConfig = {
        systemPrompt: 'You are a test agent.',
      };
      const handler = createAgentHandler(config);

      const ctx: ExecutionContext = {
        executionId: 'contract-test',
        input: 'hello',
        model: { complete: (req) => provider.complete(req) },
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
          startSpan: async (_name: string, fn: (span: any) => any) => fn({ setAttribute: () => {}, setStatus: () => {}, recordException: () => {}, end: () => {} }),
          addEvent: () => {},
          setAttribute: () => {},
        },
      };

      const resultPromise = handler(ctx);
      expect(resultPromise).toBeInstanceOf(Promise);

      const result = await resultPromise as AgentResult;

      // Verify AgentResult shape
      expect(result).toHaveProperty('answer');
      expect(result).toHaveProperty('stopReason');
      expect(result).toHaveProperty('iterations');
      expect(result).toHaveProperty('totalCost');
      expect(result).toHaveProperty('totalTokens');
      expect(result).toHaveProperty('conversationLength');
      expect(Array.isArray(result.iterations)).toBe(true);
      expect(typeof result.totalCost).toBe('number');
      expect(typeof result.totalTokens.input).toBe('number');
      expect(typeof result.totalTokens.output).toBe('number');
      expect(typeof result.conversationLength).toBe('number');
    });
  });

  describe('T016: Extended ModelRequest with messages accepted by MockProvider', () => {
    it('MockProvider handles messages array in ModelRequest', async () => {
      const provider = new MockProvider('response text');
      const request: ModelRequest = {
        prompt: '',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
        ],
      };

      const response = await provider.complete(request);

      expect(response.text).toBeDefined();
      expect(typeof response.text).toBe('string');
      expect(response.model).toBe('mock');
      expect(response.provider).toBe('mock');
      expect(response.usage.promptTokens).toBeGreaterThan(0);
    });

    it('MockProvider populates toolCalls in ModelResponse when queued', async () => {
      const provider = new MockProvider();
      const toolCalls: ToolCallRequest[] = [
        { id: 'tc1', name: 'test.tool', arguments: { key: 'value' } },
      ];
      provider.setToolCallResponses(toolCalls);

      const response = await provider.complete({ prompt: 'test' });

      expect(response.toolCalls).toBeDefined();
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0].id).toBe('tc1');
      expect(response.toolCalls![0].name).toBe('test.tool');
      expect(response.toolCalls![0].arguments).toEqual({ key: 'value' });
    });
  });

  describe('T016: ToolsAccessor on ExecutionContext', () => {
    it('ToolsAccessor.listTools() returns AdapterToolInfo[]', () => {
      const toolsAccessor: ToolsAccessor = {
        listTools: () => [
          {
            qualifiedName: 'adapter.tool',
            adapterName: 'adapter',
            toolName: 'tool',
            description: 'A tool',
            inputSchema: { type: 'object' },
          },
        ],
        callTool: vi.fn(),
      };

      const tools = toolsAccessor.listTools();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools[0]).toHaveProperty('qualifiedName');
      expect(tools[0]).toHaveProperty('adapterName');
      expect(tools[0]).toHaveProperty('toolName');
      expect(tools[0]).toHaveProperty('inputSchema');
    });

    it('ToolsAccessor.callTool() returns Promise<ToolCallResult>', async () => {
      const toolsAccessor: ToolsAccessor = {
        listTools: () => [],
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'result' }],
          isError: false,
        }),
      };

      const result = await toolsAccessor.callTool('adapter.tool', { key: 'value' });
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('isError');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]).toHaveProperty('type');
      expect(result.content[0]).toHaveProperty('text');
    });
  });

  describe('T016: AgentConfig validation contract', () => {
    it('accepts valid minimal config', () => {
      expect(() => validateAgentConfig({
        systemPrompt: 'You are a test agent.',
      })).not.toThrow();
    });

    it('accepts valid full config', () => {
      expect(() => validateAgentConfig({
        systemPrompt: 'You are a test agent.',
        tools: ['adapter.tool', 'other.helper'],
        maxIterations: 10,
        iterationBudget: 5.0,
        timeoutMs: 30000,
        outputSchema: { type: 'object', properties: { score: { type: 'number' } } },
        maxHistoryMessages: 20,
      })).not.toThrow();
    });

    it('rejects empty systemPrompt', () => {
      expect(() => validateAgentConfig({
        systemPrompt: '',
      })).toThrow(/systemPrompt/);
    });

    it('rejects invalid tool name format', () => {
      expect(() => validateAgentConfig({
        systemPrompt: 'Test',
        tools: ['no-dot-name'],
      })).toThrow(/qualified name/);
    });
  });
});
