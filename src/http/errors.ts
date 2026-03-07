// HTTP error mapping and response helpers

import { EngineError } from '../errors.js';
import type { ErrorResponse } from './types.js';

/** Map from EngineError code to HTTP status code */
const ERROR_STATUS_MAP: Record<string, number> = {
  FLOW_NOT_FOUND: 404,
  EXECUTION_NOT_FOUND: 404,
  ADAPTER_NOT_FOUND: 404,
  TOOL_NOT_FOUND: 404,
  RESOURCE_NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  INVALID_STATE: 409,
  DUPLICATE_FLOW: 409,
  DUPLICATE_ADAPTER: 409,
  ENGINE_SHUTTING_DOWN: 503,
  ENGINE_NOT_READY: 503,
  RATE_LIMITED: 429,
  POLICY_DENIED: 403,
  ACCESS_DENIED: 403,
  GUARDRAIL_BLOCKED: 422,
  BUDGET_EXCEEDED: 402,
};

/** Get the HTTP status code for an EngineError */
export function mapEngineError(err: EngineError): number {
  return ERROR_STATUS_MAP[err.code] ?? 500;
}

/** Create a standardized error response body */
export function createErrorResponse(
  code: string,
  message: string,
  details?: Record<string, unknown> | null,
): ErrorResponse {
  return {
    error: {
      code,
      message,
      details: details ?? null,
    },
  };
}
