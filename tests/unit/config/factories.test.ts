// Unit tests for factory registries
// Per spec: built-in provider/evaluator factories, merge behavior, type sets

import { describe, it, expect } from 'vitest';
import {
  mergeProviderFactories,
  mergeEvaluatorFactories,
  getProviderTypeSet,
  getEvaluatorTypeSet,
} from '../../../src/config/factories.js';
import type { ProviderFactory, EvaluatorFactory } from '../../../src/config/factories.js';
import { MockProvider } from '../../../src/model/mock.js';

// ── Provider factories ──

describe('mergeProviderFactories', () => {
  it('includes the built-in "mock" factory', () => {
    const factories = mergeProviderFactories();
    expect(factories).toHaveProperty('mock');
    expect(typeof factories.mock).toBe('function');
  });

  it('"mock" factory creates a MockProvider instance', () => {
    const factories = mergeProviderFactories();
    const provider = factories.mock({});
    expect(provider).toBeInstanceOf(MockProvider);
  });

  it('"mock" factory creates a provider with name "mock"', () => {
    const factories = mergeProviderFactories();
    const provider = factories.mock({});
    expect(provider.name).toBe('mock');
  });

  it('"mock" factory creates a provider with a complete method', () => {
    const factories = mergeProviderFactories();
    const provider = factories.mock({});
    expect(typeof provider.complete).toBe('function');
  });

  it('returns a copy of built-ins when undefined is passed', () => {
    const a = mergeProviderFactories(undefined);
    const b = mergeProviderFactories(undefined);
    expect(a).not.toBe(b); // distinct objects
    expect(Object.keys(a)).toEqual(Object.keys(b));
  });

  it('merges custom factories with built-ins', () => {
    const customFactory: ProviderFactory = () => ({
      name: 'custom-provider',
      complete: async () => ({
        text: '',
        model: 'custom',
        provider: 'custom',
        usage: { promptTokens: 0, completionTokens: 0 },
      }),
    });

    const factories = mergeProviderFactories({ 'my-custom': customFactory });
    expect(factories).toHaveProperty('mock');
    expect(factories).toHaveProperty('my-custom');
  });

  it('custom factory overrides built-in with the same key', () => {
    const overrideFactory: ProviderFactory = () => ({
      name: 'overridden-mock',
      complete: async () => ({
        text: 'overridden',
        model: 'overridden',
        provider: 'overridden',
        usage: { promptTokens: 0, completionTokens: 0 },
      }),
    });

    const factories = mergeProviderFactories({ mock: overrideFactory });
    const provider = factories.mock({});
    expect(provider.name).toBe('overridden-mock');
    expect(provider).not.toBeInstanceOf(MockProvider);
  });
});

// ── Provider type set ──

describe('getProviderTypeSet', () => {
  it('returns a set containing "mock"', () => {
    const typeSet = getProviderTypeSet();
    expect(typeSet).toBeInstanceOf(Set);
    expect(typeSet.has('mock')).toBe(true);
  });

  it('includes custom types when provided', () => {
    const customFactory: ProviderFactory = () => ({
      name: 'anthropic',
      complete: async () => ({
        text: '',
        model: 'claude',
        provider: 'anthropic',
        usage: { promptTokens: 0, completionTokens: 0 },
      }),
    });

    const typeSet = getProviderTypeSet({ anthropic: customFactory });
    expect(typeSet.has('mock')).toBe(true);
    expect(typeSet.has('anthropic')).toBe(true);
    expect(typeSet.size).toBe(4);
  });

  it('returns a ReadonlySet (cannot add to it at type level)', () => {
    const typeSet = getProviderTypeSet();
    // Structural check: it is a Set instance
    expect(typeSet).toBeInstanceOf(Set);
    expect(typeof typeSet.has).toBe('function');
  });
});

// ── Evaluator factories ──

describe('mergeEvaluatorFactories', () => {
  it('includes built-in "length", "format", and "keyword" factories', () => {
    const factories = mergeEvaluatorFactories();
    expect(factories).toHaveProperty('length');
    expect(factories).toHaveProperty('format');
    expect(factories).toHaveProperty('keyword');
    expect(typeof factories.length).toBe('function');
    expect(typeof factories.format).toBe('function');
    expect(typeof factories.keyword).toBe('function');
  });

  it('returns a copy of built-ins when undefined is passed', () => {
    const a = mergeEvaluatorFactories(undefined);
    const b = mergeEvaluatorFactories(undefined);
    expect(a).not.toBe(b);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });

  // ── Length evaluator factory ──

  describe('"length" factory', () => {
    it('creates an evaluator with default name "length"', () => {
      const factories = mergeEvaluatorFactories();
      const evaluator = factories.length({});
      expect(evaluator.name).toBe('length');
    });

    it('creates an evaluator with a custom name', () => {
      const factories = mergeEvaluatorFactories();
      const evaluator = factories.length({ name: 'my-length' });
      expect(evaluator.name).toBe('my-length');
    });

    it('creates an evaluator with an evaluate function', () => {
      const factories = mergeEvaluatorFactories();
      const evaluator = factories.length({});
      expect(typeof evaluator.evaluate).toBe('function');
    });

    it('creates an evaluator with a numeric priority', () => {
      const factories = mergeEvaluatorFactories();
      const evaluator = factories.length({});
      expect(typeof evaluator.priority).toBe('number');
    });

    it('passes config options through to the evaluator', () => {
      const factories = mergeEvaluatorFactories();
      const evaluator = factories.length({
        config: { minLength: 10, maxLength: 500, priority: 5 },
      });
      expect(evaluator.name).toBe('length');
      expect(evaluator.priority).toBe(5);
    });
  });

  // ── Format evaluator factory ──

  describe('"format" factory', () => {
    it('creates an evaluator with default name "format"', () => {
      const factories = mergeEvaluatorFactories();
      const evaluator = factories.format({});
      expect(evaluator.name).toBe('format');
    });

    it('creates an evaluator with an evaluate function', () => {
      const factories = mergeEvaluatorFactories();
      const evaluator = factories.format({});
      expect(typeof evaluator.evaluate).toBe('function');
    });

    it('maps "json" to "json-object" internally', async () => {
      const factories = mergeEvaluatorFactories();
      const evaluator = factories.format({
        config: { expectedFormat: 'json' },
      });
      // A plain object should score 1.0 for json-object format
      const result = await evaluator.evaluate({
        output: { key: 'value' },
        prompt: '',
        model: 'mock',
        provider: 'mock',
      });
      expect(result.scores.accuracy).toBe(1.0);
    });

    it('accepts "json-object" directly', async () => {
      const factories = mergeEvaluatorFactories();
      const evaluator = factories.format({
        config: { expectedFormat: 'json-object' },
      });
      const result = await evaluator.evaluate({
        output: { key: 'value' },
        prompt: '',
        model: 'mock',
        provider: 'mock',
      });
      expect(result.scores.accuracy).toBe(1.0);
    });

    it('defaults to "string" format when no config is provided', async () => {
      const factories = mergeEvaluatorFactories();
      const evaluator = factories.format({});
      // String should match the default 'string' format
      const result = await evaluator.evaluate({
        output: 'hello',
        prompt: '',
        model: 'mock',
        provider: 'mock',
      });
      expect(result.scores.accuracy).toBe(1.0);
    });
  });

  // ── Keyword evaluator factory ──

  describe('"keyword" factory', () => {
    it('creates an evaluator with default name "keyword"', () => {
      const factories = mergeEvaluatorFactories();
      const evaluator = factories.keyword({});
      expect(evaluator.name).toBe('keyword');
    });

    it('creates an evaluator with an evaluate function', () => {
      const factories = mergeEvaluatorFactories();
      const evaluator = factories.keyword({});
      expect(typeof evaluator.evaluate).toBe('function');
    });

    it('accepts required and forbidden keyword arrays via config', async () => {
      const factories = mergeEvaluatorFactories();
      const evaluator = factories.keyword({
        config: {
          requiredKeywords: ['hello', 'world'],
          forbiddenKeywords: ['bad'],
        },
      });
      expect(evaluator.name).toBe('keyword');
      // "hello world" contains both required and no forbidden keywords
      const result = await evaluator.evaluate({
        output: 'hello world',
        prompt: '',
        model: 'mock',
        provider: 'mock',
      });
      expect(result.scores.safety).toBe(1.0);
    });
  });

  // ── Custom evaluator merge ──

  it('merges custom evaluator factories with built-ins', () => {
    const customFactory: EvaluatorFactory = (cfg) => ({
      name: cfg.name ?? 'custom-eval',
      priority: 10,
      evaluate: async () => ({ scores: { custom: 1.0 } }),
    });

    const factories = mergeEvaluatorFactories({ sentiment: customFactory });
    expect(factories).toHaveProperty('length');
    expect(factories).toHaveProperty('format');
    expect(factories).toHaveProperty('keyword');
    expect(factories).toHaveProperty('sentiment');
    expect(Object.keys(factories)).toHaveLength(4);
  });

  it('custom evaluator factory overrides built-in with the same key', () => {
    const customFactory: EvaluatorFactory = () => ({
      name: 'custom-length',
      priority: 99,
      evaluate: async () => ({ scores: { relevance: 0.5 } }),
    });

    const factories = mergeEvaluatorFactories({ length: customFactory });
    const evaluator = factories.length({});
    expect(evaluator.name).toBe('custom-length');
    expect(evaluator.priority).toBe(99);
  });
});

// ── Evaluator type set ──

describe('getEvaluatorTypeSet', () => {
  it('returns a set containing "length", "format", and "keyword"', () => {
    const typeSet = getEvaluatorTypeSet();
    expect(typeSet).toBeInstanceOf(Set);
    expect(typeSet.has('length')).toBe(true);
    expect(typeSet.has('format')).toBe(true);
    expect(typeSet.has('keyword')).toBe(true);
    expect(typeSet.size).toBe(3);
  });

  it('includes custom types when provided', () => {
    const customFactory: EvaluatorFactory = () => ({
      name: 'toxicity',
      priority: 10,
      evaluate: async () => ({ scores: { safety: 1.0 } }),
    });

    const typeSet = getEvaluatorTypeSet({ toxicity: customFactory });
    expect(typeSet.has('length')).toBe(true);
    expect(typeSet.has('format')).toBe(true);
    expect(typeSet.has('keyword')).toBe(true);
    expect(typeSet.has('toxicity')).toBe(true);
    expect(typeSet.size).toBe(4);
  });

  it('does not include types not registered', () => {
    const typeSet = getEvaluatorTypeSet();
    expect(typeSet.has('nonexistent')).toBe(false);
  });
});
