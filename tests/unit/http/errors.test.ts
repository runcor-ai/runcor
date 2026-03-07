// Unit tests for HTTP error mapping
// Per tasks.md T003: mapEngineError maps each EngineError code to correct HTTP status

import { describe, it, expect } from 'vitest';
import { EngineError, BudgetExceededError } from '../../../src/errors.js';
import { mapEngineError, createErrorResponse } from '../../../src/http/errors.js';

describe('HTTP Error Mapping', () => {
  describe('mapEngineError', () => {
    const cases: Array<[string, number]> = [
      ['FLOW_NOT_FOUND', 404],
      ['EXECUTION_NOT_FOUND', 404],
      ['ADAPTER_NOT_FOUND', 404],
      ['TOOL_NOT_FOUND', 404],
      ['INVALID_TRANSITION', 409],
      ['INVALID_STATE', 409],
      ['DUPLICATE_FLOW', 409],
      ['ENGINE_SHUTTING_DOWN', 503],
      ['ENGINE_NOT_READY', 503],
      ['RATE_LIMITED', 429],
      ['POLICY_DENIED', 403],
      ['ACCESS_DENIED', 403],
      ['GUARDRAIL_BLOCKED', 422],
      ['BUDGET_EXCEEDED', 402],
    ];

    for (const [code, expectedStatus] of cases) {
      it(`maps ${code} to ${expectedStatus}`, () => {
        const err = new EngineError(`Test: ${code}`, code);
        expect(mapEngineError(err)).toBe(expectedStatus);
      });
    }

    it('maps unknown EngineError codes to 500', () => {
      const err = new EngineError('Something unexpected', 'UNKNOWN_CODE');
      expect(mapEngineError(err)).toBe(500);
    });
  });

  describe('createErrorResponse', () => {
    it('returns correct JSON shape with code, message, and null details', () => {
      const body = createErrorResponse('FLOW_NOT_FOUND', 'Flow not found');
      expect(body).toEqual({
        error: {
          code: 'FLOW_NOT_FOUND',
          message: 'Flow not found',
          details: null,
        },
      });
    });

    it('includes details when provided', () => {
      const details = { field: 'idempotencyKey', reason: 'required' };
      const body = createErrorResponse('VALIDATION_ERROR', 'Missing required field', details);
      expect(body).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Missing required field',
          details,
        },
      });
    });
  });
});
