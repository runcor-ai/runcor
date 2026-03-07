// Agent handler factory — createAgentHandler()

import type { ExecutionContext, FlowHandler, ToolsAccessor, AdapterToolInfo } from '../types.js';
import type {
  AgentConfig,
  AgentResult,
  AgentIteration,
  ToolCallRecord,
  ToolDefinition,
  ToolCallRequest,
  StopReason,
  ConversationMessage,
} from './types.js';
import { validateAgentConfig, DEFAULT_MAX_ITERATIONS } from './types.js';
import {
  buildInitialMessages,
  appendAssistantMessage,
  appendToolResults,
  truncateHistory,
} from './conversation.js';
import type { ModelResponse } from '../model/provider.js';
import { BudgetExceededError, ValidationError } from '../errors.js';
import { validateResponse, buildRetryHint } from '../model/validation.js';

/** Translate AdapterToolInfo to ToolDefinition for ModelRequest */
function translateTools(
  toolsAccessor: ToolsAccessor,
  configuredTools: string[],
): ToolDefinition[] {
  const allTools = toolsAccessor.listTools();
  const toolMap = new Map(allTools.map((t) => [t.qualifiedName, t]));

  return configuredTools
    .filter((name) => toolMap.has(name))
    .map((name) => {
      const info = toolMap.get(name)!;
      return {
        name: info.qualifiedName,
        description: info.description ?? '',
        inputSchema: info.inputSchema,
      };
    });
}

/** Build the system prompt, optionally appending output schema instructions */
function buildSystemPrompt(config: AgentConfig): string {
  let prompt = config.systemPrompt;
  if (config.outputSchema) {
    prompt += `\n\nYour final answer must conform to this JSON schema:\n${JSON.stringify(config.outputSchema, null, 2)}`;
  }
  return prompt;
}

/** Execute all tool calls from a model response, returning records and tool result messages */
async function executeToolCalls(
  toolCalls: ToolCallRequest[],
  toolsAccessor: ToolsAccessor | undefined,
): Promise<{ records: ToolCallRecord[]; results: Array<{ toolCallId: string; toolName: string; result: import('../types.js').ToolCallResult }> }> {
  const records: ToolCallRecord[] = [];
  const results: Array<{ toolCallId: string; toolName: string; result: import('../types.js').ToolCallResult }> = [];

  for (const tc of toolCalls) {
    const start = Date.now();
    let result: import('../types.js').ToolCallResult;

    try {
      if (!toolsAccessor) {
        // No adapters available
        result = {
          content: [{ type: 'text', text: `Error: Tools are unavailable. No adapters configured.` }],
          isError: true,
        };
      } else {
        result = await toolsAccessor.callTool(tc.name, tc.arguments);
      }
    } catch (error) {
      // Tool call errors fed back to model
      const message = error instanceof Error ? error.message : String(error);
      result = {
        content: [{ type: 'text', text: `Error executing tool ${tc.name}: ${message}` }],
        isError: true,
      };
    }

    const durationMs = Date.now() - start;
    records.push({
      toolName: tc.name,
      arguments: tc.arguments,
      result,
      durationMs,
      isError: result.isError,
    });
    results.push({ toolCallId: tc.id, toolName: tc.name, result });
  }

  return { records, results };
}

/** Best-effort parse of raw text for hard-stop paths (max_iterations, budget, timeout) */
function parseAnswerText(text: string, hasOutputSchema: boolean): unknown {
  if (!hasOutputSchema) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Extract the final answer from a ModelResponse, using response.parsed when available */
function parseAnswer(response: ModelResponse, hasOutputSchema: boolean): unknown {
  if (!hasOutputSchema) return response.text;
  // Prefer response.parsed from engine validation wrapper (set when responseFormat was on request)
  if (response.parsed !== undefined) return response.parsed;
  // Fallback: try JSON.parse
  try {
    return JSON.parse(response.text);
  } catch {
    return response.text;
  }
}

/** Build the AgentResult from accumulated state */
function buildResult(
  answer: unknown,
  stopReason: StopReason,
  iterations: AgentIteration[],
  messages: ConversationMessage[],
): AgentResult {
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const iter of iterations) {
    totalCost += iter.cost;
    totalInputTokens += iter.tokens.input;
    totalOutputTokens += iter.tokens.output;
  }

  return {
    answer,
    stopReason,
    iterations,
    totalCost,
    totalTokens: { input: totalInputTokens, output: totalOutputTokens },
    conversationLength: messages.length,
  };
}

/**
 * Factory that produces a standard FlowHandler implementing the agent loop.
 */
export function createAgentHandler(config: AgentConfig): FlowHandler {
  validateAgentConfig(config);

  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const configuredTools = config.tools ?? [];
  const hasOutputSchema = !!config.outputSchema;

  const handler: FlowHandler = async (ctx: ExecutionContext): Promise<AgentResult> => {
    // Check for resume state (wait/resume)
    let messages: ConversationMessage[];
    let iterationCount: number;
    let iterations: AgentIteration[];
    let cumulativeCost: number;
    let cumulativeInputTokens: number;
    let cumulativeOutputTokens: number;

    if (ctx.resumeData !== undefined) {
      // Restore state from memory
      const savedState = await ctx.memory.tool.get<{
        messages: ConversationMessage[];
        iterationCount: number;
        iterations: AgentIteration[];
        cumulativeCost: number;
        cumulativeInputTokens: number;
        cumulativeOutputTokens: number;
      }>('__agent_state');

      if (savedState) {
        messages = savedState.messages;
        iterationCount = savedState.iterationCount;
        iterations = savedState.iterations;
        cumulativeCost = savedState.cumulativeCost;
        cumulativeInputTokens = savedState.cumulativeInputTokens;
        cumulativeOutputTokens = savedState.cumulativeOutputTokens;
      } else {
        // Fallback: start fresh if state not found
        const systemPrompt = buildSystemPrompt(config);
        messages = buildInitialMessages(systemPrompt, ctx.input);
        iterationCount = 0;
        iterations = [];
        cumulativeCost = 0;
        cumulativeInputTokens = 0;
        cumulativeOutputTokens = 0;
      }
    } else {
      // Fresh start
      const systemPrompt = buildSystemPrompt(config);
      messages = buildInitialMessages(systemPrompt, ctx.input);
      iterationCount = 0;
      iterations = [];
      cumulativeCost = 0;
      cumulativeInputTokens = 0;
      cumulativeOutputTokens = 0;
    }

    // Translate adapter tools to ToolDefinitions
    const toolDefinitions: ToolDefinition[] =
      configuredTools.length > 0 && ctx.tools
        ? translateTools(ctx.tools, configuredTools)
        : [];

    const startTime = Date.now();

    // Agent loop
    while (true) {
      // Pre-iteration hard stop checks

      // Check max iterations
      if (iterationCount >= maxIterations) {
        const answer = iterations.length > 0
          ? parseAnswerText(messages.filter((m) => m.role === 'assistant').pop()?.content ?? '', hasOutputSchema)
          : undefined;
        return buildResult(answer, 'max_iterations', iterations, messages);
      }

      // Check iteration budget
      if (config.iterationBudget !== undefined && cumulativeCost >= config.iterationBudget) {
        const answer = iterations.length > 0
          ? parseAnswerText(messages.filter((m) => m.role === 'assistant').pop()?.content ?? '', hasOutputSchema)
          : undefined;
        return buildResult(answer, 'budget_exhausted', iterations, messages);
      }

      // Check timeout
      if (config.timeoutMs !== undefined && (Date.now() - startTime) >= config.timeoutMs) {
        const answer = iterations.length > 0
          ? parseAnswerText(messages.filter((m) => m.role === 'assistant').pop()?.content ?? '', hasOutputSchema)
          : undefined;
        return buildResult(answer, 'timeout', iterations, messages);
      }

      // Truncate history if configured
      messages = truncateHistory(messages, config.maxHistoryMessages);

      iterationCount++;
      const iterStart = Date.now();

      // Per-iteration telemetry span
      const iterationResult = await ctx.telemetry.startSpan(
        'agent.iteration',
        async (iterSpan) => {
          iterSpan.setAttribute('agent.iteration', iterationCount);
          iterSpan.setAttribute('agent.tool_count', toolDefinitions.length);

          // Call model
          // Include responseFormat when outputSchema is set and no tools
          // When tools are present, responseFormat is omitted to avoid interfering with tool selection
          // (e.g., Anthropic's tool_choice:forced for __structured_output would block real tool calls)
          let response: ModelResponse;
          try {
            response = await ctx.model.complete({
              prompt: '', // messages takes precedence
              messages,
              tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
              responseFormat: (hasOutputSchema && toolDefinitions.length === 0)
                ? config.outputSchema
                : undefined,
            });
          } catch (error) {
            // Check for budget exceeded from engine-level budget
            if (error instanceof BudgetExceededError) {
              const answer = iterations.length > 0
                ? parseAnswerText(messages.filter((m) => m.role === 'assistant').pop()?.content ?? '', hasOutputSchema)
                : undefined;
              return { done: true as const, result: buildResult(answer, 'budget_exhausted', iterations, messages) };
            }

            // Check for context overflow
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.toLowerCase().includes('context') && errorMessage.toLowerCase().includes('length')) {
              if (config.maxHistoryMessages === undefined) {
                const answer = iterations.length > 0
                  ? parseAnswerText(messages.filter((m) => m.role === 'assistant').pop()?.content ?? '', hasOutputSchema)
                  : undefined;
                return { done: true as const, result: buildResult(answer, 'context_overflow', iterations, messages) };
              }
            }

            throw error;
          }

          iterSpan.setAttribute('agent.model', response.model);

          const costBefore = cumulativeCost;
          const iterCost = ctx.cost.executionTotal - costBefore;
          cumulativeCost = ctx.cost.executionTotal;

          // Check for tool calls
          const hasToolCalls = response.toolCalls && response.toolCalls.length > 0;

          // Detect __structured_output tool call from Anthropic provider
          // When outputSchema is set and model returns __structured_output, treat as final answer
          if (hasToolCalls && hasOutputSchema) {
            const soToolCall = response.toolCalls!.find(tc => tc.name === '__structured_output');
            if (soToolCall) {
              messages = appendAssistantMessage(messages, response.text, response.toolCalls);
              const iteration: AgentIteration = {
                iteration: iterationCount,
                toolCalls: [],
                model: response.model,
                tokens: { input: response.usage.promptTokens, output: response.usage.completionTokens },
                cost: iterCost,
                durationMs: Date.now() - iterStart,
              };
              iterations.push(iteration);
              cumulativeInputTokens += response.usage.promptTokens;
              cumulativeOutputTokens += response.usage.completionTokens;

              // Extract arguments as the structured output answer
              const answer = soToolCall.arguments;
              return { done: true as const, result: buildResult(answer, 'completed', iterations, messages) };
            }
          }

          if (!hasToolCalls) {
            // Natural completion — no tool calls
            messages = appendAssistantMessage(messages, response.text, undefined);

            const iteration: AgentIteration = {
              iteration: iterationCount,
              toolCalls: [],
              model: response.model,
              tokens: { input: response.usage.promptTokens, output: response.usage.completionTokens },
              cost: iterCost,
              durationMs: Date.now() - iterStart,
            };
            iterations.push(iteration);
            cumulativeInputTokens += response.usage.promptTokens;
            cumulativeOutputTokens += response.usage.completionTokens;

            // Validate answer against outputSchema
            if (hasOutputSchema) {
              // Use response.parsed from engine validation wrapper if available
              // (set when responseFormat was included in the request — no-tools case)
              if (response.parsed !== undefined) {
                return { done: true as const, result: buildResult(response.parsed, 'completed', iterations, messages) };
              }

              // Local validation for when tools were present (responseFormat not on request)
              try {
                const parsed = validateResponse(response.text, config.outputSchema!);
                return { done: true as const, result: buildResult(parsed, 'completed', iterations, messages) };
              } catch (err) {
                if (err instanceof ValidationError) {
                  // Retry: append validation hint and continue agent loop
                  const hint = buildRetryHint(err.errors);
                  messages.push({ role: 'user' as const, content: hint });
                  return { done: false as const };
                }
                throw err;
              }
            }

            const answer = parseAnswer(response, hasOutputSchema);
            return { done: true as const, result: buildResult(answer, 'completed', iterations, messages) };
          }

          // Has tool calls — execute them all
          iterSpan.setAttribute('agent.tool_calls', response.toolCalls!.length);
          messages = appendAssistantMessage(messages, response.text, response.toolCalls);

          // Execute tool calls with child spans
          const { records, results } = await executeToolCalls(response.toolCalls!, ctx.tools);
          messages = appendToolResults(messages, results);

          const iterDuration = Date.now() - iterStart;
          const iteration: AgentIteration = {
            iteration: iterationCount,
            toolCalls: records,
            model: response.model,
            tokens: { input: response.usage.promptTokens, output: response.usage.completionTokens },
            cost: iterCost,
            durationMs: iterDuration,
          };
          iterations.push(iteration);
          cumulativeInputTokens += response.usage.promptTokens;
          cumulativeOutputTokens += response.usage.completionTokens;

          return { done: false as const };
        },
      );

      // Check if the iteration completed the agent
      if (iterationResult.done) {
        return iterationResult.result;
      }
    }
  };

  return handler;
}
