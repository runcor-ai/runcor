// CLI entry point — parse argv, dispatch to command handler
// Uses Node.js built-in util.parseArgs() per research.md §1

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { disableColor, red } from './output.js';

// ── Command registry ──

export interface CommandDef {
  name: string;
  description: string;
  usage: string;
  options: Record<string, { type: 'string' | 'boolean'; short?: string; default?: string | boolean; description: string }>;
  positionals?: { name: string; required: boolean; description: string }[];
  handler: (args: { values: Record<string, unknown>; positionals: string[] }) => Promise<void>;
}

const commands = new Map<string, CommandDef>();

export function registerCommand(cmd: CommandDef): void {
  commands.set(cmd.name, cmd);
}

// ── Help output ──

function printVersion(): void {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pkgPath = resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    console.log(`runcor v${pkg.version}`);
  } catch {
    console.log('runcor v0.1.0');
  }
}

function printUsage(): void {
  console.log('Usage: runcor <command> [options]\n');
  console.log('Commands:');
  for (const [name, cmd] of commands) {
    console.log(`  ${name.padEnd(10)} ${cmd.description}`);
  }
  console.log('\nGlobal Options:');
  console.log('  --help, -h       Show help for a command');
  console.log('  --version, -v    Show package version');
  console.log('  --config, -c     Path to runcor.yaml');
  console.log('  --no-color       Disable color output');
  console.log('\nRun `runcor <command> --help` for command-specific options.');
}

function printCommandHelp(cmd: CommandDef): void {
  console.log(`Usage: ${cmd.usage}\n`);
  console.log(`${cmd.description}\n`);

  if (cmd.positionals && cmd.positionals.length > 0) {
    console.log('Arguments:');
    for (const p of cmd.positionals) {
      const req = p.required ? '(required)' : '(optional)';
      console.log(`  ${p.name.padEnd(14)} ${p.description} ${req}`);
    }
    console.log('');
  }

  const optEntries = Object.entries(cmd.options);
  if (optEntries.length > 0) {
    console.log('Options:');
    for (const [name, opt] of optEntries) {
      const flag = opt.short ? `--${name}, -${opt.short}` : `--${name}`;
      const def = opt.default !== undefined ? ` (default: ${opt.default})` : '';
      console.log(`  ${flag.padEnd(20)} ${opt.description}${def}`);
    }
    console.log('');
  }

  console.log('Global Options:');
  console.log('  --help, -h       Show this help');
  console.log('  --config, -c     Path to runcor.yaml');
  console.log('  --no-color       Disable color output');
}

// ── Main dispatch ──

async function main(): Promise<void> {
  // Lazy-load commands to avoid circular imports
  const { initCommand } = await import('./commands/init.js');
  const { devCommand } = await import('./commands/dev.js');
  const { triggerCommand } = await import('./commands/trigger.js');
  const { statusCommand } = await import('./commands/status.js');
  const { resumeCommand } = await import('./commands/resume.js');

  registerCommand(initCommand);
  registerCommand(devCommand);
  registerCommand(triggerCommand);
  registerCommand(statusCommand);
  registerCommand(resumeCommand);

  // First pass: extract command name and global flags
  const rawArgs = process.argv.slice(2);

  // Check for --no-color before anything else
  if (rawArgs.includes('--no-color') || process.env['NO_COLOR']) {
    disableColor();
  }

  // Check for --version at root level
  if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
    printVersion();
    process.exit(0);
  }

  // Check for root --help with no command
  if (rawArgs.length === 0 || (rawArgs.length === 1 && (rawArgs[0] === '--help' || rawArgs[0] === '-h'))) {
    printUsage();
    process.exit(0);
  }

  // Extract command name (first non-flag argument)
  const commandName = rawArgs[0];
  if (!commandName || commandName.startsWith('-')) {
    printUsage();
    process.exit(1);
  }

  const cmd = commands.get(commandName);
  if (!cmd) {
    console.error(red(`Error: Unknown command "${commandName}".`));
    console.error('');
    printUsage();
    process.exit(1);
  }

  // Build parseArgs config for this command
  const commandArgs = rawArgs.slice(1);

  // Check for command-level --help
  if (commandArgs.includes('--help') || commandArgs.includes('-h')) {
    printCommandHelp(cmd);
    process.exit(0);
  }

  // Parse command-specific args
  const parseConfig: Parameters<typeof parseArgs>[0] = {
    args: commandArgs,
    options: {
      ...cmd.options,
      config: { type: 'string' as const, short: 'c' },
      'no-color': { type: 'boolean' as const },
      help: { type: 'boolean' as const, short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  };

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(parseConfig);
  } catch (err) {
    console.error(red(`Error: ${(err as Error).message}`));
    process.exit(1);
    return;
  }

  try {
    await cmd.handler({
      values: parsed.values as Record<string, unknown>,
      positionals: parsed.positionals,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code;
    if (code) {
      console.error(red(`Error: ${message}`));
    } else {
      console.error(red(`Error: ${message}`));
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(red(`Fatal: ${(err as Error).message}`));
  process.exit(1);
});
