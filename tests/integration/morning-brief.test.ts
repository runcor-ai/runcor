// Integration test for Morning Brief demo
import { describe, it, expect } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { MockProvider } from '../../src/model/mock.js';

describe('Morning Brief Demo', () => {
  it('should register and complete the Morning Brief flow', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    // Import and register the morning brief flow
    const { registerMorningBrief } = await import('../../examples/morning-brief.js');
    registerMorningBrief(engine);

    const completionPromise = new Promise<any>((resolve) => {
      engine.on('execution:complete', resolve);
    });

    const exec = await engine.trigger('morning-brief', {
      idempotencyKey: 'mb-test-1',
    });

    const event = await completionPromise;
    expect(event.state).toBe('complete');

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');
    expect(final!.result).toBeDefined();
    expect(typeof final!.result).toBe('string');

    await engine.shutdown();
  });

  it('should reference mock email data in output', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const { registerMorningBrief } = await import('../../examples/morning-brief.js');
    registerMorningBrief(engine);

    const exec = await engine.trigger('morning-brief', {
      idempotencyKey: 'mb-email-test',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', () => resolve());
    });

    const final = await engine.getExecution(exec.id);
    const result = final!.result as string;

    // MockProvider echoes the prompt, which should contain email data
    expect(result.toLowerCase()).toMatch(/email|inbox|message/i);

    await engine.shutdown();
  });

  it('should reference mock calendar data in output', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const { registerMorningBrief } = await import('../../examples/morning-brief.js');
    registerMorningBrief(engine);

    const exec = await engine.trigger('morning-brief', {
      idempotencyKey: 'mb-calendar-test',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', () => resolve());
    });

    const final = await engine.getExecution(exec.id);
    const result = final!.result as string;

    // MockProvider echoes the prompt, which should contain calendar data
    expect(result.toLowerCase()).toMatch(/calendar|meeting|event/i);

    await engine.shutdown();
  });

  it('should reference mock task data in output', async () => {
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const { registerMorningBrief } = await import('../../examples/morning-brief.js');
    registerMorningBrief(engine);

    const exec = await engine.trigger('morning-brief', {
      idempotencyKey: 'mb-task-test',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', () => resolve());
    });

    const final = await engine.getExecution(exec.id);
    const result = final!.result as string;

    // MockProvider echoes the prompt, which should contain task data
    expect(result.toLowerCase()).toMatch(/task|todo|priority/i);

    await engine.shutdown();
  });

  it('should work with MockProvider (no API key needed, US4-AS3)', async () => {
    // No ANTHROPIC_API_KEY needed — MockProvider works out of the box
    const engine = await createEngine({
      model: { provider: new MockProvider() },
    });

    const { registerMorningBrief } = await import('../../examples/morning-brief.js');
    registerMorningBrief(engine);

    const exec = await engine.trigger('morning-brief', {
      idempotencyKey: 'mb-mock-test',
    });

    await new Promise<void>((resolve) => {
      engine.on('execution:complete', () => resolve());
    });

    const final = await engine.getExecution(exec.id);
    expect(final!.state).toBe('complete');

    await engine.shutdown();
  });
});
