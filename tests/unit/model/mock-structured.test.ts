// Unit tests for MockProvider structured output
// Tests schema-conformant mock data generation and JSON mode

import { describe, it, expect } from 'vitest';
import { MockProvider } from '../../../src/model/mock.js';
import type { ModelRequest } from '../../../src/model/provider.js';

describe('MockProvider: Structured Output', () => {
  describe('schema mode', () => {
    it('should return conformant string defaults', async () => {
      const provider = new MockProvider();
      const response = await provider.complete({
        prompt: 'test',
        responseFormat: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      });
      const parsed = JSON.parse(response.text);
      expect(parsed.name).toBe('');
    });

    it('should return conformant number defaults', async () => {
      const provider = new MockProvider();
      const response = await provider.complete({
        prompt: 'test',
        responseFormat: {
          type: 'object',
          properties: { age: { type: 'number' } },
          required: ['age'],
        },
      });
      const parsed = JSON.parse(response.text);
      expect(parsed.age).toBe(0);
    });

    it('should return conformant boolean defaults', async () => {
      const provider = new MockProvider();
      const response = await provider.complete({
        prompt: 'test',
        responseFormat: {
          type: 'object',
          properties: { active: { type: 'boolean' } },
          required: ['active'],
        },
      });
      const parsed = JSON.parse(response.text);
      expect(parsed.active).toBe(false);
    });

    it('should return conformant array defaults', async () => {
      const provider = new MockProvider();
      const response = await provider.complete({
        prompt: 'test',
        responseFormat: {
          type: 'object',
          properties: { items: { type: 'array' } },
          required: ['items'],
        },
      });
      const parsed = JSON.parse(response.text);
      expect(parsed.items).toEqual([]);
    });

    it('should return conformant nested object defaults', async () => {
      const provider = new MockProvider();
      const response = await provider.complete({
        prompt: 'test',
        responseFormat: {
          type: 'object',
          properties: {
            user: {
              type: 'object',
              properties: { name: { type: 'string' }, age: { type: 'number' } },
            },
          },
          required: ['user'],
        },
      });
      const parsed = JSON.parse(response.text);
      expect(parsed.user).toEqual({ name: '', age: 0 });
    });

    it('should return first enum value for enum', async () => {
      const provider = new MockProvider();
      const response = await provider.complete({
        prompt: 'test',
        responseFormat: {
          type: 'object',
          properties: { status: { type: 'string', enum: ['active', 'inactive', 'pending'] } },
          required: ['status'],
        },
      });
      const parsed = JSON.parse(response.text);
      expect(parsed.status).toBe('active');
    });

    it('should return const value for const', async () => {
      const provider = new MockProvider();
      const response = await provider.complete({
        prompt: 'test',
        responseFormat: {
          type: 'object',
          properties: { version: { const: '1.0' } },
          required: ['version'],
        },
      });
      const parsed = JSON.parse(response.text);
      expect(parsed.version).toBe('1.0');
    });

    it('should handle empty object schema', async () => {
      const provider = new MockProvider();
      const response = await provider.complete({
        prompt: 'test',
        responseFormat: { type: 'object' },
      });
      const parsed = JSON.parse(response.text);
      expect(parsed).toEqual({});
    });

    it('should return integer default as 0', async () => {
      const provider = new MockProvider();
      const response = await provider.complete({
        prompt: 'test',
        responseFormat: {
          type: 'object',
          properties: { count: { type: 'integer' } },
          required: ['count'],
        },
      });
      const parsed = JSON.parse(response.text);
      expect(parsed.count).toBe(0);
    });
  });

  describe('json mode', () => {
    it('should return empty object for json mode', async () => {
      const provider = new MockProvider();
      const response = await provider.complete({
        prompt: 'test',
        responseFormat: 'json',
      });
      expect(response.text).toBe('{}');
    });
  });

  describe('text mode', () => {
    it('should return template response when responseFormat is text', async () => {
      const provider = new MockProvider('Reply: {prompt}');
      const response = await provider.complete({
        prompt: 'hello',
        responseFormat: 'text',
      });
      expect(response.text).toBe('Reply: hello');
    });

    it('should return template response when responseFormat is omitted', async () => {
      const provider = new MockProvider('Reply: {prompt}');
      const response = await provider.complete({
        prompt: 'hello',
      });
      expect(response.text).toBe('Reply: hello');
    });
  });

  describe('queued responses take precedence', () => {
    it('should use queued response even with schema responseFormat', async () => {
      const provider = new MockProvider();
      provider.queueResponses([{ text: '{"custom":"value"}' }]);
      const response = await provider.complete({
        prompt: 'test',
        responseFormat: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      });
      expect(response.text).toBe('{"custom":"value"}');
    });
  });
});
