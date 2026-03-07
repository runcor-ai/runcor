import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, type Runcor } from '../../../src/engine.js';
import { formatEventLog } from '../../../src/cli/output.js';
import { watchFiles } from '../../../src/cli/watcher.js';
import { extractHttpServerConfig } from '../../../src/config/mapper.js';
import type { RuncorConfigFile } from '../../../src/config/schema.js';

describe('CLI — runcor dev', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'runcor-dev-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('engine starts from config with mock provider', async () => {
    writeFileSync(join(tempDir, 'runcor.yaml'), 'providers:\n  - type: mock\n', 'utf-8');

    const engine = await createEngine({ configPath: join(tempDir, 'runcor.yaml') });
    expect(engine.getStatus()).toBe('ready');
    await engine.shutdown();
  });

  it('formatEventLog produces correct format for execution:state_change', () => {
    const line = formatEventLog('execution:state_change', {
      executionId: 'abc-123456789',
      from: 'queued',
      to: 'running',
      flowName: 'hello',
    });

    expect(line).toContain('[execution]');
    expect(line).toContain('hello');
    expect(line).toContain('queued');
    expect(line).toContain('running');
    expect(line).toContain('(abc-12345678)'); // truncated to 12
  });

  it('formatEventLog handles cost:request event', () => {
    const line = formatEventLog('cost:request', {
      executionId: 'abc-123',
      flowName: 'hello',
      cost: 0.0023,
      model: 'gpt-4o',
    });

    expect(line).toContain('[cost]');
    expect(line).toContain('$0.0023');
    expect(line).toContain('gpt-4o');
  });

  it('extractHttpServerConfig returns defaults when no httpServer section', () => {
    const yaml: RuncorConfigFile = {};
    const config = extractHttpServerConfig(yaml);
    expect(config.enabled).toBe(false);
    expect(config.port).toBe(3000);
    expect(config.hostname).toBe('127.0.0.1');
    expect(config.cors).toBe(true);
  });

  it('extractHttpServerConfig extracts explicit values', () => {
    const yaml: RuncorConfigFile = {
      httpServer: { enabled: true, port: 8080, hostname: '127.0.0.1', cors: false },
    };
    const config = extractHttpServerConfig(yaml);
    expect(config.enabled).toBe(true);
    expect(config.port).toBe(8080);
    expect(config.hostname).toBe('127.0.0.1');
    expect(config.cors).toBe(false);
  });

  it('missing config shows error guidance', async () => {
    // Attempting createEngine without a config file should throw
    await expect(createEngine({ configPath: join(tempDir, 'nonexistent.yaml') }))
      .rejects.toThrow(/not found/i);
  });

  it('watchFiles returns cleanup function that closes watchers', () => {
    const configPath = join(tempDir, 'runcor.yaml');
    writeFileSync(configPath, 'providers:\n  - type: mock\n', 'utf-8');

    const cleanup = watchFiles(
      { configPath, flowPaths: [] },
      () => {},
    );

    // Should not throw
    cleanup();
  });

  it('watchFiles debounces file change events', async () => {
    const configPath = join(tempDir, 'runcor.yaml');
    writeFileSync(configPath, 'providers:\n  - type: mock\n', 'utf-8');

    const events: string[] = [];
    const cleanup = watchFiles(
      { configPath, flowPaths: [] },
      (event) => { events.push(event.type); },
    );

    // Rapid writes should be debounced to a single event
    writeFileSync(configPath, 'providers:\n  - type: mock\n# v2\n', 'utf-8');
    writeFileSync(configPath, 'providers:\n  - type: mock\n# v3\n', 'utf-8');

    await new Promise(r => setTimeout(r, 400));

    // Should have at most 1 event due to debouncing
    expect(events.length).toBeLessThanOrEqual(1);

    cleanup();
  });
});
