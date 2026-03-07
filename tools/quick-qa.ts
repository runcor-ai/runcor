// Quick Q&A Tool
// A simple tool that takes a question, sends it to the configured model provider,
// and returns the answer. Single model call, no subsystem opt-ins.
//
// Run: npx tsx tools/quick-qa.ts

import { createEngine } from '../src/index.js';
import type { FlowHandler } from '../src/index.js';

// ── Types ──

interface QuickQAInput {
  question: string;
}

interface QuickQAOutput {
  question: string;
  answer: string;
  model: string;
  tokens: { prompt: number; completion: number };
}

// ── Flow Handler ──

const quickQA: FlowHandler = async (ctx): Promise<QuickQAOutput> => {
  const input = ctx.input as QuickQAInput;

  const response = await ctx.model.complete({
    prompt: `Answer the following question concisely and accurately:\n\n${input.question}`,
  });

  return {
    question: input.question,
    answer: response.text,
    model: response.model,
    tokens: {
      prompt: response.usage.promptTokens,
      completion: response.usage.completionTokens,
    },
  };
};

// ── Engine Setup (loads runcor.yaml) ──

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const engine = await createEngine({ configPath: join(__dirname, 'runcor.yaml') });

engine.register('quick-qa', quickQA, {
  description: 'Ask a question, get an answer from the configured model provider',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask' },
    },
    required: ['question'],
  },
});

// ── Run ──

const execution = await engine.trigger('quick-qa', {
  idempotencyKey: crypto.randomUUID(),
  input: { question: 'What is the capital of France and why is it significant?' },
});

// Wait for the execution to complete
const result = await new Promise<QuickQAOutput>((resolve, reject) => {
  engine.on('execution:complete', (e) => {
    if (e.executionId === execution.id) {
      if (e.error) reject(e.error);
      else resolve(e.result as QuickQAOutput);
    }
  });
  // In case it already completed synchronously
  if (execution.state === 'complete') resolve(execution.result as QuickQAOutput);
  if (execution.state === 'failed') reject(execution.error);
});

console.log('Question:', result.question);
console.log('Answer:', result.answer);
console.log('Model:', result.model);
console.log('Tokens:', result.tokens);

await engine.shutdown();
