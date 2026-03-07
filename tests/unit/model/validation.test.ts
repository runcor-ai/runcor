// Unit tests for validation module
import { describe, it, expect } from 'vitest';
import {
  compileSchema,
  validateResponse,
  stripCodeFences,
  buildRetryHint,
  validateRequestFormat,
} from '../../../src/model/validation.js';
import { ValidationError } from '../../../src/errors.js';

// ── T007: compileSchema() tests ──

describe('compileSchema()', () => {
  it('should compile a valid schema', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    const validate = compileSchema(schema);
    expect(validate).toBeTypeOf('function');
  });

  it('should throw ValidationError for invalid schema', () => {
    // ajv doesn't throw on { type: 'invalid-type-name' } during compile in draft-07
    // but a truly broken schema with invalid structure will fail
    const schema = { type: 'object', properties: { name: { type: 'not-a-type' } } };
    expect(() => compileSchema(schema)).toThrow(ValidationError);
  });

  it('should reject schemas with remote $ref', () => {
    const schema = { $ref: 'https://example.com/schema.json' };
    expect(() => compileSchema(schema)).toThrow(ValidationError);
    try {
      compileSchema(schema);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).errors[0].keyword).toBe('$ref');
    }
  });

  it('should support local $ref (#/$defs/...)', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { $ref: '#/$defs/nameType' },
      },
      $defs: {
        nameType: { type: 'string' },
      },
    };
    const validate = compileSchema(schema);
    expect(validate).toBeTypeOf('function');
  });

  it('should accept empty object {} as valid schema', () => {
    const validate = compileSchema({});
    expect(validate).toBeTypeOf('function');
  });

  it('should cache compiled schemas (same object returned for same schema)', () => {
    const schema = { type: 'object', properties: { age: { type: 'number' } } };
    const v1 = compileSchema(schema);
    const v2 = compileSchema(schema);
    expect(v1).toBe(v2); // Same reference = cache hit
  });

  it('should cache schemas by deep equality, not reference', () => {
    const schema1 = { type: 'object', properties: { x: { type: 'number' } } };
    const schema2 = { type: 'object', properties: { x: { type: 'number' } } };
    const v1 = compileSchema(schema1);
    const v2 = compileSchema(schema2);
    expect(v1).toBe(v2); // Different references, same structure
  });
});

// ── T008: validateResponse() tests ──

describe('validateResponse()', () => {
  it('should return parsed value for valid JSON + valid schema', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    const result = validateResponse('{"name":"John"}', schema);
    expect(result).toEqual({ name: 'John' });
  });

  it('should throw for invalid JSON text', () => {
    const schema = { type: 'object' };
    expect(() => validateResponse('not json', schema)).toThrow(ValidationError);
  });

  it('should throw for valid JSON but wrong schema', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    expect(() => validateResponse('{"age":30}', schema)).toThrow(ValidationError);
    try {
      validateResponse('{"age":30}', schema);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).rawText).toBe('{"age":30}');
    }
  });

  it('should accept any valid JSON type in json mode (object)', () => {
    const result = validateResponse('{"key":"value"}', 'json');
    expect(result).toEqual({ key: 'value' });
  });

  it('should accept any valid JSON type in json mode (array)', () => {
    const result = validateResponse('[1,2,3]', 'json');
    expect(result).toEqual([1, 2, 3]);
  });

  it('should accept any valid JSON type in json mode (string)', () => {
    const result = validateResponse('"hello"', 'json');
    expect(result).toBe('hello');
  });

  it('should accept any valid JSON type in json mode (number)', () => {
    const result = validateResponse('42', 'json');
    expect(result).toBe(42);
  });

  it('should accept any valid JSON type in json mode (boolean)', () => {
    const result = validateResponse('true', 'json');
    expect(result).toBe(true);
  });

  it('should accept any valid JSON type in json mode (null)', () => {
    const result = validateResponse('null', 'json');
    expect(result).toBeNull();
  });

  it('should return undefined for text mode', () => {
    const result = validateResponse('any text here', 'text');
    expect(result).toBeUndefined();
  });

  it('should strip code fences before parsing', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    const result = validateResponse('```json\n{"name":"John"}\n```', schema);
    expect(result).toEqual({ name: 'John' });
  });
});

// ── T009: stripCodeFences() tests ──

describe('stripCodeFences()', () => {
  it('should strip ```json\\n...\\n``` wrapping', () => {
    const result = stripCodeFences('```json\n{"name":"John"}\n```');
    expect(result).toBe('{"name":"John"}');
  });

  it('should strip with leading/trailing whitespace', () => {
    const result = stripCodeFences('  ```json\n{"name":"John"}\n```  ');
    expect(result).toBe('{"name":"John"}');
  });

  it('should be a no-op when no fences present', () => {
    const text = '{"name":"John"}';
    const result = stripCodeFences(text);
    expect(result).toBe(text);
  });

  it('should handle ``` without language tag', () => {
    const result = stripCodeFences('```\n{"name":"John"}\n```');
    expect(result).toBe('{"name":"John"}');
  });

  it('should handle multiline JSON inside fences', () => {
    const input = '```json\n{\n  "name": "John",\n  "age": 30\n}\n```';
    const result = stripCodeFences(input);
    expect(result).toBe('{\n  "name": "John",\n  "age": 30\n}');
  });
});

// ── T010: buildRetryHint() tests ──

describe('buildRetryHint()', () => {
  it('should produce human-readable hint from errors', () => {
    const errors = [
      { path: '/name', message: 'must be string', keyword: 'type' },
      { path: '', message: "must have required property 'age'", keyword: 'required' },
    ];
    const hint = buildRetryHint(errors);
    expect(hint).toContain('must be string');
    expect(hint).toContain("must have required property 'age'");
    expect(hint).toContain('valid JSON');
  });

  it('should include all error messages', () => {
    const errors = [
      { path: '/a', message: 'error 1', keyword: 'type' },
      { path: '/b', message: 'error 2', keyword: 'required' },
      { path: '/c', message: 'error 3', keyword: 'minimum' },
    ];
    const hint = buildRetryHint(errors);
    expect(hint).toContain('error 1');
    expect(hint).toContain('error 2');
    expect(hint).toContain('error 3');
  });

  it('should handle empty errors array', () => {
    const hint = buildRetryHint([]);
    expect(hint).toContain('valid JSON');
  });
});

// ── T011: validateRequestFormat() tests ──

describe('validateRequestFormat()', () => {
  it('should pass for text mode', () => {
    expect(() => validateRequestFormat('text')).not.toThrow();
  });

  it('should pass for json mode', () => {
    expect(() => validateRequestFormat('json')).not.toThrow();
  });

  it('should pass for valid schema', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    expect(() => validateRequestFormat(schema)).not.toThrow();
  });

  it('should throw ValidationError for invalid schema', () => {
    const schema = { type: 'object', properties: { name: { type: 'not-a-type' } } };
    expect(() => validateRequestFormat(schema)).toThrow(ValidationError);
  });

  it('should throw ValidationError for remote $ref', () => {
    const schema = { $ref: 'https://example.com/schema.json' };
    expect(() => validateRequestFormat(schema)).toThrow(ValidationError);
  });

  it('should pass for undefined (defaults to text)', () => {
    expect(() => validateRequestFormat(undefined)).not.toThrow();
  });
});
