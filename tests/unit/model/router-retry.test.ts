// Unit tests for ModelRouter intra-provider retry on transient errors (v2-002 FR-017).
//
// Verifies:
//   - 3 attempts on transient errors with exponential backoff timing
//   - NO retry on 4xx (other than 429) or auth failures
//   - Circuit breaker records failure ONLY after retry exhaustion (not after attempt 1)
//   - Successful retry on attempt 2 records breaker success
//   - Provider fallback still works after intra-provider retry exhaustion
//   - isTransient classifier behavior

import { describe, it, expect, vi } from 'vitest';
import { ModelRouter, isTransient } from '../../../src/model/router.js';
import type { ProviderRegistration } from '../../../src/types.js';
import type { ModelRequest, ModelResponse } from '../../../src/model/provider.js';

function makeRegistration(
  name: string,
  priority: number,
  completeFn: (req: ModelRequest) => Promise<ModelResponse>,
): ProviderRegistration {
  return {
    name,
    provider: { name, complete: completeFn },
    priority,
    costPerToken: null,
    models: null,
  };
}

function transientError(status?: number, code?: string): Error {
  const e = new Error(`Transient ${status ?? code ?? 'failure'}`);
  if (status !== undefined) (e as Error & { statusCode?: number }).statusCode = status;
  if (code !== undefined) (e as Error & { code?: string }).code = code;
  return e;
}

function nonTransientError(status: number): Error {
  const e = new Error(`Non-transient ${status}`);
  (e as Error & { statusCode?: number }).statusCode = status;
  return e;
}

const okResponse = (provider: string): ModelResponse => ({
  text: `Response from ${provider}`,
  model: 'test',
  provider,
  usage: { promptTokens: 1, completionTokens: 1 },
});

describe('isTransient', () => {
  it('classifies 429 as transient', () => {
    expect(isTransient(transientError(429))).toBe(true);
  });

  it('classifies 5xx as transient', () => {
    expect(isTransient(transientError(500))).toBe(true);
    expect(isTransient(transientError(503))).toBe(true);
    expect(isTransient(transientError(599))).toBe(true);
  });

  it('classifies 4xx (other than 429) as non-transient', () => {
    expect(isTransient(transientError(400))).toBe(false);
    expect(isTransient(transientError(401))).toBe(false);
    expect(isTransient(transientError(403))).toBe(false);
    expect(isTransient(transientError(404))).toBe(false);
  });

  it('classifies network error codes as transient', () => {
    expect(isTransient(transientError(undefined, 'ETIMEDOUT'))).toBe(true);
    expect(isTransient(transientError(undefined, 'ECONNRESET'))).toBe(true);
    expect(isTransient(transientError(undefined, 'ENOTFOUND'))).toBe(true);
    expect(isTransient(transientError(undefined, 'ECONNREFUSED'))).toBe(true);
  });

  it('classifies unknown errors as non-transient (conservative)', () => {
    expect(isTransient(new Error('Random failure'))).toBe(false);
    expect(isTransient('not even an error')).toBe(false);
    expect(isTransient(null)).toBe(false);
  });
});

describe('ModelRouter intra-provider retry (v2-002 FR-017)', () => {
  it('retries on 429 and succeeds on attempt 2', async () => {
    let calls = 0;
    const router = new ModelRouter({
      providers: [
        makeRegistration('p1', 1, async (req) => {
          calls++;
          if (calls === 1) throw transientError(429);
          return okResponse('p1');
        }),
      ],
    });

    const response = await router.complete({ prompt: 'test' });
    expect(response.provider).toBe('p1');
    expect(calls).toBe(2);
    router.shutdown();
  });

  it('retries 3 times on persistent transient error then falls through to next provider', async () => {
    let p1Calls = 0;
    let p2Calls = 0;
    const router = new ModelRouter({
      providers: [
        makeRegistration('p1', 1, async () => {
          p1Calls++;
          throw transientError(503);
        }),
        makeRegistration('p2', 2, async () => {
          p2Calls++;
          return okResponse('p2');
        }),
      ],
    });

    const response = await router.complete({ prompt: 'test' });
    expect(response.provider).toBe('p2');
    expect(p1Calls).toBe(3); // retried 3 times before fallback
    expect(p2Calls).toBe(1);
    router.shutdown();
  });

  it('does NOT retry on 4xx (non-transient)', async () => {
    let p1Calls = 0;
    let p2Calls = 0;
    const router = new ModelRouter({
      providers: [
        makeRegistration('p1', 1, async () => {
          p1Calls++;
          throw nonTransientError(401);
        }),
        makeRegistration('p2', 2, async () => {
          p2Calls++;
          return okResponse('p2');
        }),
      ],
    });

    const response = await router.complete({ prompt: 'test' });
    expect(response.provider).toBe('p2');
    expect(p1Calls).toBe(1); // NO retry on 401
    expect(p2Calls).toBe(1);
    router.shutdown();
  });

  it('exponential backoff timing — last retry takes >= base × (2^0 + 2^1) = 600ms', async () => {
    // Base is 200ms, so attempts are at t=0, t=200, t=600 (cumulative).
    // After 3 attempts (2 backoffs of 200 + 400 = 600ms minimum elapsed).
    const start = Date.now();
    const router = new ModelRouter({
      providers: [
        makeRegistration('p1', 1, async () => {
          throw transientError(503);
        }),
      ],
    });

    try {
      await router.complete({ prompt: 'test' });
    } catch {
      // Expected — all providers fail
    }
    const elapsed = Date.now() - start;
    // 200ms + 400ms = 600ms minimum. Allow some scheduling slack.
    expect(elapsed).toBeGreaterThanOrEqual(550);
    router.shutdown();
  });

  it('retry does NOT pollute circuit breaker on intermediate transient failures', async () => {
    // Provider succeeds on attempt 2. Breaker should record SUCCESS, not failure.
    let calls = 0;
    const router = new ModelRouter({
      providers: [
        makeRegistration('p1', 1, async () => {
          calls++;
          if (calls === 1) throw transientError(503);
          return okResponse('p1');
        }),
      ],
      failureThreshold: 1, // breaker opens after 1 failure
    });

    // Multiple successive calls — if intermediate transients polluted the breaker, the second
    // call would see the breaker open and fail with NO_HEALTHY_PROVIDERS. Reset call counter.
    await router.complete({ prompt: 'a' });
    calls = 0;
    const response = await router.complete({ prompt: 'b' });
    expect(response.provider).toBe('p1');
    expect(calls).toBe(2); // again, attempt 1 fails transiently, attempt 2 succeeds
    router.shutdown();
  });

  it('records breaker failure ONLY after retry exhaustion', async () => {
    // 3 transient failures in a row — breaker should record one failure (after retries exhaust).
    const router = new ModelRouter({
      providers: [
        makeRegistration('p1', 1, async () => {
          throw transientError(503);
        }),
      ],
      failureThreshold: 1,
      cooldownMs: 60_000,
    });

    try {
      await router.complete({ prompt: 'test' });
    } catch {
      // Expected
    }

    // Breaker is now open; second call should fail with NO_HEALTHY_PROVIDERS (not retry+exhaust).
    await expect(router.complete({ prompt: 'test2' })).rejects.toThrow(
      /No healthy providers/,
    );
    router.shutdown();
  });

  it('non-transient error fails immediately without consuming retry budget', async () => {
    let calls = 0;
    const start = Date.now();
    const router = new ModelRouter({
      providers: [
        makeRegistration('p1', 1, async () => {
          calls++;
          throw nonTransientError(400);
        }),
      ],
    });

    try {
      await router.complete({ prompt: 'test' });
    } catch {
      // Expected
    }
    const elapsed = Date.now() - start;
    expect(calls).toBe(1); // single attempt
    expect(elapsed).toBeLessThan(150); // no backoff delay
    router.shutdown();
  });

  it('mixed: transient on first provider exhausts retries, then provider fallback succeeds', async () => {
    let p1Calls = 0;
    let p2Calls = 0;
    const router = new ModelRouter({
      providers: [
        makeRegistration('p1', 1, async () => {
          p1Calls++;
          throw transientError(429);
        }),
        makeRegistration('p2', 2, async () => {
          p2Calls++;
          return okResponse('p2');
        }),
      ],
    });

    const response = await router.complete({ prompt: 'test' });
    expect(response.provider).toBe('p2');
    expect(p1Calls).toBe(3);
    expect(p2Calls).toBe(1);
    router.shutdown();
  });
});
