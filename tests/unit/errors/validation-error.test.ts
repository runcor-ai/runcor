// Unit tests for ValidationError class
import { describe, it, expect } from 'vitest';
import { ValidationError, EngineError } from '../../../src/errors.js';

describe('ValidationError', () => {
  it('should have code VALIDATION_FAILED', () => {
    const err = new ValidationError(
      [{ path: '/name', message: 'must be string', keyword: 'type' }],
      '{"name":123}',
    );
    expect(err.code).toBe('VALIDATION_FAILED');
  });

  it('should preserve errors array', () => {
    const errors = [
      { path: '/name', message: 'must be string', keyword: 'type' },
      { path: '', message: "must have required property 'age'", keyword: 'required' },
    ];
    const err = new ValidationError(errors, '{}');
    expect(err.errors).toEqual(errors);
    expect(err.errors).toHaveLength(2);
  });

  it('should preserve rawText', () => {
    const rawText = '{"invalid": true}';
    const err = new ValidationError(
      [{ path: '', message: 'test error', keyword: 'type' }],
      rawText,
    );
    expect(err.rawText).toBe(rawText);
  });

  it('should extend EngineError', () => {
    const err = new ValidationError(
      [{ path: '', message: 'test', keyword: 'type' }],
      '',
    );
    expect(err).toBeInstanceOf(EngineError);
    expect(err).toBeInstanceOf(Error);
  });

  it('should have name ValidationError', () => {
    const err = new ValidationError([], '');
    expect(err.name).toBe('ValidationError');
  });

  it('should include error messages in the Error message', () => {
    const err = new ValidationError(
      [{ path: '', message: 'must be object', keyword: 'type' }],
      '',
    );
    expect(err.message).toContain('must be object');
  });

  it('should handle empty errors array', () => {
    const err = new ValidationError([], 'raw');
    expect(err.errors).toEqual([]);
    expect(err.rawText).toBe('raw');
    expect(err.code).toBe('VALIDATION_FAILED');
  });
});
