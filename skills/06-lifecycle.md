# Execution Lifecycle

> **Purpose**: Documents the execution state machine so tools handle state transitions correctly.
> **When to use**: When Claude needs to understand what happens after `engine.trigger()` — how executions move through states, how retries work, and how wait/resume functions.

## State Machine

```text
                          ┌──────────────┐
                          │   queued     │
                          └──────┬───────┘
                                 │ engine dispatches
                                 v
                ┌───────── running ──────────┐
                │           │    │           │
                │    success │    │ wait      │ retryable error
                │           │    │ signal    │
                v           │    v           v
          ┌──────────┐     │  ┌─────────┐  ┌──────────┐
          │ complete  │     │  │ waiting │  │ retrying │
          └──────────┘     │  └────┬────┘  └─────┬────┘
                           │       │             │
                           │  resume│        retry │
                           │       │     dispatch │
                           │       v             │
                           │    running <────────┘
                           │
                           │  non-retryable error,
                           │  max retries, timeout,
                           v  cancel
                      ┌──────────┐
                      │  failed  │
                      └──────────┘
```

## States

| State | Description | How it enters | How it exits |
|-------|-------------|---------------|--------------|
| **queued** | Execution created, waiting for dispatch | `engine.trigger()` called | Engine dispatches to flow handler |
| **running** | Flow handler is executing | Dispatched from queued, retrying, or waiting (on resume) | Handler returns (→ complete), throws RetryableError (→ retrying), returns WaitSignal (→ waiting), throws non-retryable error (→ failed) |
| **waiting** | Paused, waiting for external input | Flow handler returned a `WaitSignal` | `engine.resume(executionId, data)` called (→ running), wait timeout expires (→ failed), `engine.cancel()` (→ failed) |
| **retrying** | Waiting for retry backoff to expire | Flow handler threw `RetryableError` and retries remain | Backoff timer expires (→ running), `engine.cancel()` (→ failed) |
| **complete** | Terminal. Handler returned successfully | Flow handler returned a value (not a WaitSignal) | None — terminal state |
| **failed** | Terminal. Execution could not complete | Non-retryable error, max retries exhausted, timeout, cancel, wait timeout | None — terminal state |

## Valid Transitions

```text
queued    → running, failed
running   → complete, waiting, retrying, failed
waiting   → running, failed
retrying  → running, failed
complete  → (none — terminal)
failed    → (none — terminal)
```

## Retry Behavior

When a flow handler throws `RetryableError`, the engine retries automatically:

1. Execution transitions to **retrying**
2. Engine waits for a backoff delay
3. Execution transitions back to **running** and the handler is called again
4. `ctx.resumeData` is **not** set on retries (it's only set on resume from waiting)

**Backoff formula**: `min(baseRetryDelay * 2^retryCount, maxRetryDelay)`

| Retry | Delay (defaults) |
|-------|-----------------|
| 1st | 1,000 ms |
| 2nd | 2,000 ms |
| 3rd | 4,000 ms (capped at maxRetryDelay = 30,000 ms) |

**Default limits**: `maxRetries = 3`, `baseRetryDelay = 1000 ms`, `maxRetryDelay = 30000 ms`

Override per flow:

```typescript
engine.register('my-flow', handler, {
  maxRetries: 5,
  baseRetryDelay: 500,
  maxRetryDelay: 10000,
});
```

## Timeout Behavior

Each execution has a timeout (default: 30,000 ms). If the flow handler doesn't return within this window:

1. The execution transitions to **failed**
2. Error code: `'EXECUTION_TIMEOUT'`
3. The timeout covers total execution time including retries

Override per flow:

```typescript
engine.register('long-running', handler, {
  timeout: 120000, // 2 minutes
});
```

Or per trigger:

```typescript
await engine.trigger('long-running', {
  idempotencyKey: 'key-1',
  timeout: 60000, // 1 minute for this execution only
});
```

## Wait/Resume

A flow can pause execution to wait for external input (human approval, webhook, etc.):

```typescript
import { createWaitSignal } from 'runcor';

const handler: FlowHandler = async (ctx) => {
  if (!ctx.resumeData) {
    // First run — pause and wait for approval
    return createWaitSignal({
      reason: 'Awaiting manager approval',
      expectedResumeBy: new Date(Date.now() + 86400000), // 24 hours
      data: { requestId: ctx.executionId },
    });
  }

  // Resumed — process the approval
  const approval = ctx.resumeData as { approved: boolean };
  if (approval.approved) {
    return { status: 'approved' };
  }
  throw new Error('Request denied');
};
```

Resume from outside:

```typescript
await engine.resume(executionId, { approved: true });
```

**Wait timeout**: If configured, the execution fails automatically after the timeout:

```typescript
engine.register('approval', handler, {
  waitTimeout: 86400000, // Fail after 24 hours if not resumed
});
```

Default `waitTimeout` is `0` (wait indefinitely).

## Cancellation

Any non-terminal execution can be cancelled:

```typescript
await engine.cancel(executionId, 'No longer needed');
```

The execution transitions to **failed** with error code `'CANCELLED'`.

## Replay

A completed or failed execution can be replayed:

```typescript
const newExecution = await engine.replay(originalExecutionId);
```

This creates a **new** execution with the same flow name and input. The new execution has `replayOf` set to the original execution ID.

## Events

The engine emits events for state transitions:

```typescript
engine.on('execution:state_change', (event) => {
  console.log(`${event.executionId}: ${event.from} → ${event.to}`);
});

engine.on('execution:complete', (event) => {
  console.log(`${event.executionId} finished: ${event.state}`);
});
```

## See Also

- `01-contract.md` — The Lifecycle/State row in the responsibility matrix
- `04-api-reference.md` — `ExecutionState`, `ExecutionContext`, and related types
- `05-subsystems.md` — Wait/resume subsystem guide (Section 8)
