// Provider and evaluator factory registries

import type { ModelProvider } from '../model/provider.js';
import type { Evaluator } from '../types.js';
import { MockProvider } from '../model/mock.js';
import { OpenAIProvider } from '../model/openai.js';
import { GoogleProvider } from '../model/google.js';
import { AnthropicProvider } from '../model/anthropic.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createLengthEvaluator } from '../evaluation/built-in/length-evaluator.js';
import { createFormatEvaluator } from '../evaluation/built-in/format-evaluator.js';
import { createKeywordEvaluator } from '../evaluation/built-in/keyword-evaluator.js';

/** Factory function that creates a ModelProvider from YAML config fields */
export type ProviderFactory = (config: {
  apiKey?: string;
  baseUrl?: string;
  [key: string]: unknown;
}) => ModelProvider;

/** Factory function that creates an Evaluator from YAML config fields */
export type EvaluatorFactory = (config: {
  name?: string;
  weight?: number;
  config?: Record<string, unknown>;
}) => Evaluator;

/** Built-in provider factories keyed by type string */
const builtInProviderFactories: Record<string, ProviderFactory> = {
  mock: () => new MockProvider(),
  openai: (config) => {
    const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
    return new OpenAIProvider(client);
  },
  google: (config) => {
    const ai = new GoogleGenerativeAI(config.apiKey ?? '');
    return new GoogleProvider(ai);
  },
  anthropic: (config) => {
    const client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseUrl });
    return new AnthropicProvider(client);
  },
};

/** Built-in evaluator factories keyed by type string */
const builtInEvaluatorFactories: Record<string, EvaluatorFactory> = {
  length: (cfg) =>
    createLengthEvaluator({
      name: cfg.name ?? 'length',
      minLength: (cfg.config?.minLength as number) ?? undefined,
      maxLength: (cfg.config?.maxLength as number) ?? undefined,
      priority: (cfg.config?.priority as number) ?? undefined,
    }),
  format: (cfg) => {
    // Map YAML-friendly names to internal ExpectedFormat enum
    const formatMap: Record<string, string> = {
      json: 'json-object',
      'json-object': 'json-object',
      string: 'string',
      array: 'array',
    };
    const rawFormat = (cfg.config?.expectedFormat as string) ?? 'string';
    const mappedFormat = formatMap[rawFormat] ?? rawFormat;
    return createFormatEvaluator({
      name: cfg.name ?? 'format',
      expectedFormat: mappedFormat as import('../evaluation/built-in/format-evaluator.js').ExpectedFormat,
      priority: (cfg.config?.priority as number) ?? undefined,
    });
  },
  keyword: (cfg) =>
    createKeywordEvaluator({
      name: cfg.name ?? 'keyword',
      required: (cfg.config?.requiredKeywords as string[]) ?? [],
      forbidden: (cfg.config?.forbiddenKeywords as string[]) ?? [],
      caseSensitive: (cfg.config?.caseSensitive as boolean) ?? false,
      priority: (cfg.config?.priority as number) ?? undefined,
    }),
};

/** Merge custom factories with built-ins (custom overrides built-in) */
export function mergeProviderFactories(
  custom?: Record<string, ProviderFactory>,
): Record<string, ProviderFactory> {
  if (!custom) return { ...builtInProviderFactories };
  return { ...builtInProviderFactories, ...custom };
}

/** Merge custom evaluator factories with built-ins */
export function mergeEvaluatorFactories(
  custom?: Record<string, EvaluatorFactory>,
): Record<string, EvaluatorFactory> {
  if (!custom) return { ...builtInEvaluatorFactories };
  return { ...builtInEvaluatorFactories, ...custom };
}

/** Get the set of all known provider type strings (built-in + custom) */
export function getProviderTypeSet(
  custom?: Record<string, ProviderFactory>,
): ReadonlySet<string> {
  const merged = mergeProviderFactories(custom);
  return new Set(Object.keys(merged));
}

/** Get the set of all known evaluator type strings (built-in + custom) */
export function getEvaluatorTypeSet(
  custom?: Record<string, EvaluatorFactory>,
): ReadonlySet<string> {
  const merged = mergeEvaluatorFactories(custom);
  return new Set(Object.keys(merged));
}
