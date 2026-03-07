import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../../../src/cli/connection.js';

describe('CLI connection module', () => {
  let tempDir: string;
  let configPath: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'runcor-conn-'));
    configPath = join(tempDir, 'runcor.yaml');
    writeFileSync(configPath, 'providers:\n  - type: mock\n', 'utf-8');
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('falls back to engine mode when no HTTP server running', async () => {
    const conn = await connect(configPath, 39999);
    expect(conn.mode).toBe('engine');
    expect(conn.engine).toBeDefined();
    await conn.cleanup();
  });

  it('cleanup function can be called multiple times safely', async () => {
    const conn = await connect(configPath, 39998);
    await conn.cleanup();
    // Second call should not throw
    await conn.cleanup();
  });

  it('engine mode provides working engine instance', async () => {
    const conn = await connect(configPath, 39997);
    expect(conn.mode).toBe('engine');
    expect(conn.engine).toBeDefined();
    expect(conn.engine!.getStatus()).toBe('ready');
    await conn.cleanup();
  });
});
