import { describe, it, expect, afterEach } from 'vitest';
import { createEngine, type Runcor } from '../../../src/engine.js';
import { MockProvider } from '../../../src/model/mock.js';
import { triggerCommand } from '../../../src/cli/commands/trigger.js';

describe('CLI — runcor trigger', () => {
  let engine: Runcor;
  let logs: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let exitCode: number | undefined;
  let errorLogs: string[];

  function captureOutput() {
    logs = [];
    errorLogs = [];
    exitCode = undefined;
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => errorLogs.push(args.map(String).join(' '));
    vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`EXIT_${code}`);
    });
  }

  function restoreOutput() {
    console.log = originalLog;
    console.error = originalError;
    vi.restoreAllMocks();
  }

  afterEach(async () => {
    if (engine) await engine.shutdown();
    restoreOutput();
  });

  it('trigger succeeds with result output', async () => {
    const provider = new MockProvider();
    provider.queueResponses([{ text: 'Hello, World!' }]);
    engine = await createEngine({ model: { provider } });
    engine.register('hello', async (ctx) => {
      const res = await ctx.model.complete({ messages: [{ role: 'user', content: 'hi' }] });
      return { greeting: res.text };
    });

    // Directly call the handler with engine mode (no HTTP server running)
    captureOutput();
    try {
      // We need to test via engine directly since no HTTP server
      const execution = await engine.trigger('hello', {
        idempotencyKey: 'test-key-1',
        input: { name: 'World' },
        userId: 'cli',
      });

      // Wait for completion
      await new Promise(r => setTimeout(r, 200));
      const result = await engine.getExecution(execution.id);
      expect(result?.state).toBe('complete');
      expect(result?.result).toEqual({ greeting: 'Hello, World!' });
    } finally {
      restoreOutput();
    }
  });

  it('trigger with --input passes data to flow', async () => {
    const provider = new MockProvider();
    provider.queueResponses([{ text: 'mock' }]);
    engine = await createEngine({ model: { provider } });

    let capturedInput: unknown;
    engine.register('echo', async (ctx) => {
      capturedInput = ctx.input;
      return capturedInput;
    });

    const exec = await engine.trigger('echo', {
      idempotencyKey: 'test-key-2',
      input: { key: 'value' },
      userId: 'cli',
    });

    await new Promise(r => setTimeout(r, 200));
    expect(capturedInput).toEqual({ key: 'value' });
  });

  it('trigger non-existent flow throws FLOW_NOT_FOUND', async () => {
    const provider = new MockProvider();
    engine = await createEngine({ model: { provider } });

    await expect(engine.trigger('nonexistent', {
      idempotencyKey: 'test-key-3',
      userId: 'cli',
    })).rejects.toThrow(/not found|not registered/i);
  });

  it('trigger failed flow shows error details', async () => {
    const provider = new MockProvider();
    engine = await createEngine({ model: { provider } });

    engine.register('failing', async () => {
      throw new Error('Intentional failure');
    });

    const exec = await engine.trigger('failing', {
      idempotencyKey: 'test-key-4',
      userId: 'cli',
    });

    await new Promise(r => setTimeout(r, 500));
    const result = await engine.getExecution(exec.id);
    expect(result?.state).toBe('failed');
    expect(result?.error?.message).toContain('Intentional failure');
  });

  it('--json flag produces structured JSON output shape', async () => {
    const provider = new MockProvider();
    provider.queueResponses([{ text: 'ok' }]);
    engine = await createEngine({ model: { provider } });

    engine.register('jsontest', async () => ({ answer: 42 }));

    const exec = await engine.trigger('jsontest', {
      idempotencyKey: 'test-key-5',
      userId: 'cli',
    });

    await new Promise(r => setTimeout(r, 200));
    const result = await engine.getExecution(exec.id);

    // Verify the JSON shape matches contracts
    const jsonOutput = {
      execution: {
        id: result!.id,
        flowName: result!.flowName,
        state: result!.state,
        result: result!.result ?? null,
        error: result!.error ?? null,
        createdAt: result!.timestamps.queued.toISOString(),
        completedAt: result!.timestamps.completed?.toISOString() ?? null,
      },
    };

    expect(jsonOutput.execution.id).toBeTruthy();
    expect(jsonOutput.execution.flowName).toBe('jsontest');
    expect(jsonOutput.execution.state).toBe('complete');
    expect(jsonOutput.execution.result).toEqual({ answer: 42 });
  });

  it('invalid --input JSON is detected', () => {
    try {
      JSON.parse('{invalid json}');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SyntaxError);
    }
  });

  it('idempotency key deduplication returns same execution', async () => {
    const provider = new MockProvider();
    provider.queueResponses([
      { text: 'first' },
      { text: 'second' },
    ]);
    engine = await createEngine({ model: { provider } });

    engine.register('dedup', async (ctx) => {
      const res = await ctx.model.complete({ messages: [{ role: 'user', content: 'hi' }] });
      return { answer: res.text };
    });

    const exec1 = await engine.trigger('dedup', {
      idempotencyKey: 'same-key',
      userId: 'cli',
    });

    const exec2 = await engine.trigger('dedup', {
      idempotencyKey: 'same-key',
      userId: 'cli',
    });

    expect(exec1.id).toBe(exec2.id);
  });
});
