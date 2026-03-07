// Provider error classification
// Maps SDK-specific errors to RetryableError or EngineError

import { RetryableError, EngineError } from '../errors.js';

/** Classify a provider SDK error and throw the appropriate Runcor error type */
export function classifyProviderError(providerName: string, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const status = getStatus(err);
  const errorString = message.toLowerCase();

  // Rate limit → retryable
  if (status === 429 || errorString.includes('rate_limit') || errorString.includes('rate limit')) {
    throw new RetryableError(`${providerName} rate limited: ${message}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }

  // Server errors → retryable
  if (status !== undefined && status >= 500) {
    throw new RetryableError(`${providerName} server error (${status}): ${message}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }

  // Connection/timeout errors → retryable
  if (isConnectionError(err) || errorString.includes('timeout') || errorString.includes('econnrefused') || errorString.includes('econnreset')) {
    throw new RetryableError(`${providerName} connection error: ${message}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }

  // Auth errors → non-retryable
  if (status === 401 || status === 403 || errorString.includes('authentication') || errorString.includes('unauthorized') || errorString.includes('api key')) {
    throw new EngineError(`${providerName} auth error: ${message}`, 'PROVIDER_AUTH_ERROR');
  }

  // Everything else → non-retryable provider error
  throw new EngineError(`${providerName} API error: ${message}`, 'PROVIDER_ERROR');
}

/** Extract HTTP status from SDK error objects */
function getStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as Record<string, unknown>).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/** Check if error is a connection-type error (SDK-specific classes) */
function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as Error).name ?? '';
  // Anthropic/OpenAI: APIConnectionError, APIConnectionTimeoutError
  // Google: GoogleGenerativeAIAbortError
  return name.includes('Connection') || name.includes('Abort') || name.includes('Timeout');
}
