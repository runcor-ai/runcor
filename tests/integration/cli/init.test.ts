import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initCommand } from '../../../src/cli/commands/init.js';

describe('CLI — runcor init', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'runcor-init-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates runcor.yaml and flows/hello.mjs in empty directory', async () => {
    await initCommand.handler({ values: {}, positionals: [] });

    expect(existsSync(join(tempDir, 'runcor.yaml'))).toBe(true);
    expect(existsSync(join(tempDir, 'flows', 'hello.mjs'))).toBe(true);
  });

  it('generated runcor.yaml contains mock provider and httpServer', async () => {
    await initCommand.handler({ values: {}, positionals: [] });

    const content = readFileSync(join(tempDir, 'runcor.yaml'), 'utf-8');
    expect(content).toContain('type: mock');
    expect(content).toContain('httpServer:');
    expect(content).toContain('enabled: true');
    expect(content).toContain('port: 3000');
  });

  it('refuses to overwrite existing runcor.yaml without --force', async () => {
    writeFileSync(join(tempDir, 'runcor.yaml'), 'existing: true', 'utf-8');

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    try {
      await initCommand.handler({ values: {}, positionals: [] });
    } catch (e) {
      expect((e as Error).message).toBe('EXIT');
    }
    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();

    // Original file should be unchanged
    const content = readFileSync(join(tempDir, 'runcor.yaml'), 'utf-8');
    expect(content).toBe('existing: true');
  });

  it('overwrites with --force', async () => {
    writeFileSync(join(tempDir, 'runcor.yaml'), 'existing: true', 'utf-8');

    await initCommand.handler({ values: { force: true }, positionals: [] });

    const content = readFileSync(join(tempDir, 'runcor.yaml'), 'utf-8');
    expect(content).toContain('type: mock');
  });

  it('--name substitutes project name in config', async () => {
    await initCommand.handler({ values: { name: 'my-cool-project' }, positionals: [] });

    const content = readFileSync(join(tempDir, 'runcor.yaml'), 'utf-8');
    expect(content).toContain('my-cool-project');
  });

  it('positional argument sets project name', async () => {
    await initCommand.handler({ values: {}, positionals: ['my-positional-project'] });

    const content = readFileSync(join(tempDir, 'runcor.yaml'), 'utf-8');
    expect(content).toContain('my-positional-project');
  });

  it('generated flow file contains handler function', async () => {
    await initCommand.handler({ values: {}, positionals: [] });

    const content = readFileSync(join(tempDir, 'flows', 'hello.mjs'), 'utf-8');
    expect(content).toContain('export default async function hello');
    expect(content).toContain('ctx.model.complete');
  });
});
