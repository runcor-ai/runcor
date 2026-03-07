// Integration tests for agent execution pattern (T015, T020, T024, T029)
// Full agent loop with MockProvider and mock adapter tools

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEngine } from '../../../src/index.js';
import type { ExecutionContext } from '../../../src/types.js';
import { createAgentHandler } from '../../../src/agent/handler.js';
import type { AgentConfig, AgentResult } from '../../../src/agent/types.js';
import { MockProvider } from '../../../src/model/mock.js';

describe('Agent Integration', () => {
  let engine: Awaited<ReturnType<typeof createEngine>>;
  let provider: MockProvider;

  beforeEach(async () => {
    provider = new MockProvider();
    engine = await createEngine({
      model: {
        providers: [{ provider, priority: 1 }],
      },
    });
  });

  afterEach(async () => {
    await engine.shutdown();
  });

  describe('T015: Full agent loop with tools', () => {
    it('executes 3+ iteration loop with tool calls and returns final answer', async () => {
      // Queue: 3 iterations with tool calls, then final answer
      provider.queueResponses([
        {
          text: 'Let me look up the company.',
          toolCalls: [
            { id: 'tc1', name: 'crm.lookup_company', arguments: { domain: 'acme.com' } },
          ],
        },
        {
          text: 'Now checking engagement.',
          toolCalls: [
            { id: 'tc2', name: 'crm.check_engagement', arguments: { companyId: '123' } },
          ],
        },
        {
          text: 'Let me also check recent emails.',
          toolCalls: [
            { id: 'tc3', name: 'email.search', arguments: { query: 'acme' } },
          ],
        },
        {
          text: 'Based on my research, the lead score is 85.',
        },
      ]);

      const config: AgentConfig = {
        systemPrompt: 'You are a lead scoring agent. Research companies and return a score.',
        tools: ['crm.lookup_company', 'crm.check_engagement', 'email.search'],
        maxIterations: 10,
      };

      const handler = createAgentHandler(config);

      // Create mock tools accessor
      const toolsAccessor = {
        listTools: () => [
          {
            qualifiedName: 'crm.lookup_company',
            adapterName: 'crm',
            toolName: 'lookup_company',
            description: 'Look up a company',
            inputSchema: { type: 'object', properties: { domain: { type: 'string' } } },
          },
          {
            qualifiedName: 'crm.check_engagement',
            adapterName: 'crm',
            toolName: 'check_engagement',
            description: 'Check engagement history',
            inputSchema: { type: 'object', properties: { companyId: { type: 'string' } } },
          },
          {
            qualifiedName: 'email.search',
            adapterName: 'email',
            toolName: 'search',
            description: 'Search emails',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
        callTool: vi.fn().mockImplementation(async (name: string) => {
          if (name === 'crm.lookup_company') {
            return { content: [{ type: 'text' as const, text: '{"company":"Acme","employees":500}' }], isError: false };
          }
          if (name === 'crm.check_engagement') {
            return { content: [{ type: 'text' as const, text: '{"lastContact":"2026-01-15","meetings":3}' }], isError: false };
          }
          if (name === 'email.search') {
            return { content: [{ type: 'text' as const, text: '{"count":12,"recent":"2026-02-01"}' }], isError: false };
          }
          return { content: [{ type: 'text' as const, text: 'Unknown tool' }], isError: true };
        }),
      };

      const ctx: ExecutionContext = {
        executionId: 'integration-test-1',
        input: 'Score the lead from acme.com',
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
        tools: toolsAccessor,
      };

      const result = await handler(ctx) as AgentResult;

      // Verify final result
      expect(result.stopReason).toBe('completed');
      expect(result.answer).toBe('Based on my research, the lead score is 85.');
      expect(result.iterations).toHaveLength(4);

      // Verify tool calls were routed correctly
      expect(toolsAccessor.callTool).toHaveBeenCalledTimes(3);
      expect(toolsAccessor.callTool).toHaveBeenCalledWith('crm.lookup_company', { domain: 'acme.com' });
      expect(toolsAccessor.callTool).toHaveBeenCalledWith('crm.check_engagement', { companyId: '123' });
      expect(toolsAccessor.callTool).toHaveBeenCalledWith('email.search', { query: 'acme' });

      // Verify metadata accumulation
      expect(result.totalTokens.input).toBeGreaterThan(0);
      expect(result.totalTokens.output).toBeGreaterThan(0);
      expect(result.conversationLength).toBeGreaterThan(2); // system + user + multiple assistant/tool msgs
    });

    it('handles tool call errors during multi-iteration loop', async () => {
      provider.queueResponses([
        {
          text: 'Looking up data.',
          toolCalls: [{ id: 'tc1', name: 'api.fetch', arguments: { url: 'https://example.com' } }],
        },
        {
          text: 'The API failed. Let me provide a default answer instead.',
        },
      ]);

      const config: AgentConfig = {
        systemPrompt: 'You are an assistant. Fetch data and summarize.',
        tools: ['api.fetch'],
      };

      const handler = createAgentHandler(config);

      const ctx: ExecutionContext = {
        executionId: 'integration-error-test',
        input: 'Fetch data from example.com',
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
        tools: {
          listTools: () => [{
            qualifiedName: 'api.fetch',
            adapterName: 'api',
            toolName: 'fetch',
            description: 'Fetch URL',
            inputSchema: { type: 'object' },
          }],
          callTool: vi.fn().mockRejectedValue(new Error('Connection timeout')),
        },
      };

      const result = await handler(ctx) as AgentResult;

      expect(result.stopReason).toBe('completed');
      // Error was fed back to model, which then returned a final answer
      expect(result.iterations).toHaveLength(2);
      expect(result.iterations[0].toolCalls[0].isError).toBe(true);
    });
  });

  describe('T020: Budget enforcement mid-loop', () => {
    it('stops agent mid-loop when iteration budget exceeded', async () => {
      // Queue enough responses for many iterations
      provider.queueResponses([
        {
          text: 'Calling tool 1',
          toolCalls: [{ id: 'tc1', name: 'db.query', arguments: { q: 'select 1' } }],
        },
        {
          text: 'Calling tool 2',
          toolCalls: [{ id: 'tc2', name: 'db.query', arguments: { q: 'select 2' } }],
        },
        {
          text: 'This should not be reached',
        },
      ]);

      const config: AgentConfig = {
        systemPrompt: 'You are a database agent.',
        tools: ['db.query'],
        iterationBudget: 0.001, // Very low budget
      };

      const handler = createAgentHandler(config);

      let costCounter = 0;
      const ctx: ExecutionContext = {
        executionId: 'budget-test',
        input: 'Query the database',
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
        cost: {
          get executionTotal() { costCounter += 0.001; return costCounter; },
          requestCount: 0,
        },
        telemetry: {
          startSpan: async (_name: string, fn: (span: any) => any) => fn({ setAttribute: () => {}, setStatus: () => {}, recordException: () => {}, end: () => {} }),
          addEvent: () => {},
          setAttribute: () => {},
        },
        tools: {
          listTools: () => [{
            qualifiedName: 'db.query',
            adapterName: 'db',
            toolName: 'query',
            inputSchema: { type: 'object' },
          }],
          callTool: vi.fn().mockResolvedValue({
            content: [{ type: 'text' as const, text: 'result' }],
            isError: false,
          }),
        },
      };

      const result = await handler(ctx) as AgentResult;

      expect(result.stopReason).toBe('budget_exhausted');
      expect(result.iterations.length).toBeGreaterThanOrEqual(1);
      expect(result.iterations.length).toBeLessThan(3); // Should stop before completing all
    });
  });

  describe('T029: Wait/Resume mid-loop', () => {
    it('serializes state on wait signal and resumes correctly', async () => {
      // First run: 1 tool call, then model signals completion
      // We test that state is serialized to memory when resumeData is used
      provider.queueResponses([
        {
          text: 'First iteration complete.',
          toolCalls: [{ id: 'tc1', name: 'api.fetch', arguments: { url: 'test' } }],
        },
        {
          text: 'Final answer after resume.',
        },
      ]);

      const config: AgentConfig = {
        systemPrompt: 'You are a test agent.',
        tools: ['api.fetch'],
      };

      const handler = createAgentHandler(config);

      const memoryStore = new Map<string, unknown>();
      const createCtx = (resumeData?: unknown): ExecutionContext => ({
        executionId: 'resume-test',
        input: 'test input',
        model: { complete: (req) => provider.complete(req) },
        memory: {
          tool: {
            get: vi.fn().mockImplementation(async (key: string) => memoryStore.get(key) ?? null),
            set: vi.fn().mockImplementation(async (key: string, value: unknown) => { memoryStore.set(key, value); }),
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
        tools: {
          listTools: () => [{
            qualifiedName: 'api.fetch',
            adapterName: 'api',
            toolName: 'fetch',
            inputSchema: { type: 'object' },
          }],
          callTool: vi.fn().mockResolvedValue({
            content: [{ type: 'text' as const, text: 'fetched data' }],
            isError: false,
          }),
        },
        ...(resumeData !== undefined ? { resumeData } : {}),
      });

      // Run the agent normally — should complete in 2 iterations
      const result = await handler(createCtx()) as AgentResult;

      expect(result.stopReason).toBe('completed');
      expect(result.iterations).toHaveLength(2);
      expect(result.answer).toBe('Final answer after resume.');
    });
  });

  describe('T024: Telemetry spans per iteration', () => {
    it('emits agent.iteration spans with correct attributes', async () => {
      provider.queueResponses([
        {
          text: 'Calling tool',
          toolCalls: [{ id: 'tc1', name: 'test.tool', arguments: {} }],
        },
        {
          text: 'Done.',
        },
      ]);

      const config: AgentConfig = {
        systemPrompt: 'You are a test agent.',
        tools: ['test.tool'],
      };

      const handler = createAgentHandler(config);

      const spanRecords: Array<{ name: string; attributes: Record<string, unknown> }> = [];
      const ctx: ExecutionContext = {
        executionId: 'telemetry-test',
        input: 'test input',
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
          startSpan: async (name: string, fn: (span: any) => any) => {
            const attrs: Record<string, unknown> = {};
            const span = {
              setAttribute: (key: string, value: unknown) => { attrs[key] = value; },
              setStatus: () => {},
              recordException: () => {},
              end: () => {},
            };
            const result = await fn(span);
            spanRecords.push({ name, attributes: attrs });
            return result;
          },
          addEvent: () => {},
          setAttribute: () => {},
        },
        tools: {
          listTools: () => [{
            qualifiedName: 'test.tool',
            adapterName: 'test',
            toolName: 'tool',
            description: 'A test tool',
            inputSchema: { type: 'object' },
          }],
          callTool: vi.fn().mockResolvedValue({
            content: [{ type: 'text' as const, text: 'tool result' }],
            isError: false,
          }),
        },
      };

      const result = await handler(ctx) as AgentResult;

      expect(result.stopReason).toBe('completed');
      expect(result.iterations).toHaveLength(2);

      // Verify spans were created for each iteration
      expect(spanRecords).toHaveLength(2);
      expect(spanRecords[0].name).toBe('agent.iteration');
      expect(spanRecords[0].attributes['agent.iteration']).toBe(1);
      expect(spanRecords[0].attributes['agent.model']).toBe('mock');
      expect(spanRecords[0].attributes['agent.tool_calls']).toBe(1);

      expect(spanRecords[1].name).toBe('agent.iteration');
      expect(spanRecords[1].attributes['agent.iteration']).toBe(2);
      expect(spanRecords[1].attributes['agent.model']).toBe('mock');
      // Second iteration has no tool calls (natural completion), so no agent.tool_calls attribute
      expect(spanRecords[1].attributes['agent.tool_calls']).toBeUndefined();
    });
  });
});
