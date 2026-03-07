// runcor dev — start engine with file watching and event log

import { existsSync, readdirSync } from 'node:fs';
import { resolve, basename, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { CommandDef } from '../index.js';
import { createEngine, type Runcor } from '../../engine.js';
import { createServer } from '../../http/server.js';
import type { RuncorServer } from '../../http/types.js';
import { extractHttpServerConfig } from '../../config/mapper.js';
import type { RuncorConfigFile } from '../../config/schema.js';
import { formatEventLog, formatError, bold, dim, cyan } from '../output.js';
import { watchFiles } from '../watcher.js';
import type { FlowHandler } from '../../types.js';

async function loadRawYaml(configPath: string): Promise<RuncorConfigFile> {
  const raw = await readFile(configPath, 'utf-8');
  return parseYaml(raw) as RuncorConfigFile ?? {};
}

async function discoverFlows(flowDir: string): Promise<Map<string, string>> {
  const flows = new Map<string, string>();
  if (!existsSync(flowDir)) return flows;

  const files = readdirSync(flowDir).filter(f => {
    const ext = extname(f);
    return ext === '.ts' || ext === '.js' || ext === '.mts' || ext === '.mjs';
  });

  for (const file of files) {
    const name = basename(file, extname(file));
    flows.set(name, resolve(flowDir, file));
  }
  return flows;
}

async function importFlow(filePath: string): Promise<FlowHandler> {
  // Use cache-busting query for hot-reload
  const url = `file://${filePath.replace(/\\/g, '/')}?t=${Date.now()}`;
  const mod = await import(url);
  return mod.default ?? mod.handler ?? Object.values(mod)[0] as FlowHandler;
}

export const devCommand: CommandDef = {
  name: 'dev',
  description: 'Start the engine in development mode',
  usage: 'runcor dev [--config <path>] [--port <number>]',
  options: {
    port: { type: 'string', short: 'p', description: 'HTTP server port (overrides config)' },
  },
  handler: async ({ values }) => {
    const configPath = (values['config'] as string) ?? resolve(process.cwd(), 'runcor.yaml');
    if (!existsSync(configPath)) {
      console.error(formatError('CONFIG_NOT_FOUND', 'No runcor.yaml found. Run `runcor init` to create one.'));
      process.exit(1);
    }

    // Load raw YAML for httpServer config and flow discovery
    const rawYaml = await loadRawYaml(configPath);
    const httpConfig = extractHttpServerConfig(rawYaml);
    const portOverride = values['port'] ? parseInt(values['port'] as string, 10) : undefined;
    const port = portOverride ?? httpConfig.port;

    // Create engine from config
    let engine: Runcor;
    try {
      engine = await createEngine({ configPath });
    } catch (err) {
      console.error(formatError('ENGINE_ERROR', (err as Error).message));
      process.exit(1);
      return;
    }

    // Discover and register flows from flows/ directory
    const flowDir = resolve(process.cwd(), 'flows');
    const flowMap = await discoverFlows(flowDir);
    const flowPaths: string[] = [];

    for (const [name, filePath] of flowMap) {
      try {
        const handler = await importFlow(filePath);
        engine.register(name, handler);
        flowPaths.push(filePath);
      } catch (err) {
        console.error(formatError('FLOW_LOAD', `Failed to load flow "${name}": ${(err as Error).message}`));
      }
    }

    // Subscribe to engine events for event log
    const eventNames = [
      'execution:state_change', 'execution:complete',
      'cost:request', 'cost:budget_warning', 'cost:budget_exceeded',
      'policy:violation', 'policy:warning', 'policy:rate_limited',
      'eval:score', 'eval:complete', 'eval:flagged',
      'adapter:connected', 'adapter:disconnected', 'adapter:error',
      'adapter:tools_discovered', 'adapter:tool_call',
      'flow:registered', 'flow:unregistered',
      'scheduler:trigger', 'scheduler:skip', 'scheduler:registered', 'scheduler:removed',
      'provider:health_change',
    ] as const;

    for (const eventName of eventNames) {
      (engine as import('node:events').EventEmitter).on(eventName, (data: unknown) => {
        console.log(formatEventLog(eventName, (data ?? {}) as Record<string, unknown>));
      });
    }

    // Start HTTP server if enabled (or always in dev mode)
    let server: RuncorServer | undefined;
    const shouldStartHttp = httpConfig.enabled || portOverride !== undefined;
    if (shouldStartHttp) {
      server = createServer(engine, {
        port,
        hostname: httpConfig.hostname,
        cors: httpConfig.cors,
        signal: false, // We handle signals ourselves
      });
      await server.start();
    }

    // Start file watcher
    const stopWatching = watchFiles(
      { configPath, flowPaths },
      async (event) => {
        if (event.type === 'flow') {
          const name = basename(event.path, extname(event.path));
          try {
            const handler = await importFlow(event.path);
            try { engine.unregister(name); } catch { /* may not exist */ }
            engine.register(name, handler);
            console.log(formatEventLog('flow:registered', { name }));
          } catch (err) {
            console.error(formatError('FLOW_RELOAD', `Failed to reload flow "${name}": ${(err as Error).message}`));
          }
        } else {
          console.log(dim('  Config changed — restart `runcor dev` to apply.'));
        }
      },
    );

    // Print startup banner
    const flows = engine.listFlows();
    console.log(bold(`runcor dev v0.1.0`));
    console.log('');
    console.log(`  Flows:    ${flows.length} registered`);
    console.log(`  Adapters: 0 connected`);
    if (server) {
      const addr = server.address();
      console.log(`  HTTP:     ${cyan(`http://localhost:${addr.port}`)}`);
    }
    console.log(`  Watching: runcor.yaml, flows/`);
    console.log('');
    console.log('Ready. Press Ctrl+C to stop.');
    console.log('');

    // Graceful shutdown handler
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('');
      console.log(dim('Shutting down...'));
      stopWatching();
      if (server) await server.stop();
      await engine.shutdown();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep process alive
    await new Promise(() => {});
  },
};
