// Unit tests for AgentConfig validation (T003)
// TDD: Write tests FIRST, expect failures until T004 implements validation

import { describe, it, expect } from 'vitest';
import { validateAgentConfig, DEFAULT_MAX_ITERATIONS } from '../../../src/agent/types.js';
import type { AgentConfig } from '../../../src/agent/types.js';

describe('validateAgentConfig', () => {
  const validConfig: AgentConfig = {
    systemPrompt: 'You are a helpful assistant.',
    tools: ['gmail.searchEmails', 'slack.sendMessage'],
    maxIterations: 10,
  };

  it('accepts a valid config with all fields', () => {
    expect(() => validateAgentConfig(validConfig)).not.toThrow();
  });

  it('accepts a minimal config with only systemPrompt', () => {
    expect(() => validateAgentConfig({ systemPrompt: 'Hello' })).not.toThrow();
  });

  it('accepts config with optional fields set', () => {
    expect(() => validateAgentConfig({
      systemPrompt: 'Analyze data',
      tools: ['gmail.search'],
      maxIterations: 5,
      iterationBudget: 0.50,
      timeoutMs: 30000,
      outputSchema: { type: 'object', properties: { score: { type: 'number' } } },
      maxHistoryMessages: 10,
    })).not.toThrow();
  });

  // systemPrompt validation
  describe('systemPrompt', () => {
    it('rejects empty systemPrompt', () => {
      expect(() => validateAgentConfig({ ...validConfig, systemPrompt: '' }))
        .toThrow(/systemPrompt/i);
    });

    it('rejects whitespace-only systemPrompt', () => {
      expect(() => validateAgentConfig({ ...validConfig, systemPrompt: '   ' }))
        .toThrow(/systemPrompt/i);
    });
  });

  // maxIterations validation
  describe('maxIterations', () => {
    it('rejects maxIterations < 1', () => {
      expect(() => validateAgentConfig({ ...validConfig, maxIterations: 0 }))
        .toThrow(/maxIterations/i);
    });

    it('rejects negative maxIterations', () => {
      expect(() => validateAgentConfig({ ...validConfig, maxIterations: -1 }))
        .toThrow(/maxIterations/i);
    });

    it('accepts maxIterations = 1', () => {
      expect(() => validateAgentConfig({ ...validConfig, maxIterations: 1 }))
        .not.toThrow();
    });

    it('defaults maxIterations to 25 when not provided', () => {
      expect(DEFAULT_MAX_ITERATIONS).toBe(25);
    });
  });

  // iterationBudget validation
  describe('iterationBudget', () => {
    it('rejects iterationBudget <= 0', () => {
      expect(() => validateAgentConfig({ ...validConfig, iterationBudget: 0 }))
        .toThrow(/iterationBudget/i);
    });

    it('rejects negative iterationBudget', () => {
      expect(() => validateAgentConfig({ ...validConfig, iterationBudget: -1 }))
        .toThrow(/iterationBudget/i);
    });

    it('accepts positive iterationBudget', () => {
      expect(() => validateAgentConfig({ ...validConfig, iterationBudget: 0.01 }))
        .not.toThrow();
    });
  });

  // timeoutMs validation
  describe('timeoutMs', () => {
    it('rejects timeoutMs <= 0', () => {
      expect(() => validateAgentConfig({ ...validConfig, timeoutMs: 0 }))
        .toThrow(/timeoutMs/i);
    });

    it('rejects negative timeoutMs', () => {
      expect(() => validateAgentConfig({ ...validConfig, timeoutMs: -100 }))
        .toThrow(/timeoutMs/i);
    });

    it('accepts positive timeoutMs', () => {
      expect(() => validateAgentConfig({ ...validConfig, timeoutMs: 1000 }))
        .not.toThrow();
    });
  });

  // maxHistoryMessages validation
  describe('maxHistoryMessages', () => {
    it('rejects maxHistoryMessages < 2', () => {
      expect(() => validateAgentConfig({ ...validConfig, maxHistoryMessages: 1 }))
        .toThrow(/maxHistoryMessages/i);
    });

    it('rejects maxHistoryMessages = 0', () => {
      expect(() => validateAgentConfig({ ...validConfig, maxHistoryMessages: 0 }))
        .toThrow(/maxHistoryMessages/i);
    });

    it('accepts maxHistoryMessages = 2', () => {
      expect(() => validateAgentConfig({ ...validConfig, maxHistoryMessages: 2 }))
        .not.toThrow();
    });
  });

  // tools qualified name validation
  describe('tools qualified names', () => {
    it('rejects tool name without dot separator', () => {
      expect(() => validateAgentConfig({ ...validConfig, tools: ['invalidtool'] }))
        .toThrow(/tool/i);
    });

    it('rejects tool name with multiple dots', () => {
      expect(() => validateAgentConfig({ ...validConfig, tools: ['a.b.c'] }))
        .toThrow(/tool/i);
    });

    it('rejects empty tool name', () => {
      expect(() => validateAgentConfig({ ...validConfig, tools: [''] }))
        .toThrow(/tool/i);
    });

    it('rejects tool name with dot at start', () => {
      expect(() => validateAgentConfig({ ...validConfig, tools: ['.toolName'] }))
        .toThrow(/tool/i);
    });

    it('rejects tool name with dot at end', () => {
      expect(() => validateAgentConfig({ ...validConfig, tools: ['adapter.'] }))
        .toThrow(/tool/i);
    });

    it('accepts valid qualified tool names', () => {
      expect(() => validateAgentConfig({
        ...validConfig,
        tools: ['gmail.searchEmails', 'slack.sendMessage', 'calendar.listEvents'],
      })).not.toThrow();
    });

    it('accepts empty tools array', () => {
      expect(() => validateAgentConfig({ ...validConfig, tools: [] }))
        .not.toThrow();
    });
  });
});
