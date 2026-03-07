// Hybrid connection model: probe HTTP health endpoint, fall back to temporary engine

import { createEngine, type Runcor } from '../engine.js';
import type { CreateEngineOptions } from '../engine.js';

export interface ConnectionResult {
  mode: 'http' | 'engine';
  httpBaseUrl?: string;
  engine?: Runcor;
  cleanup: () => Promise<void>;
}

const PROBE_TIMEOUT_MS = 500;

/**
 * Connect to a running dev server via HTTP, or fall back to a temporary engine.
 * @param configPath - Optional explicit path to runcor.yaml
 * @param port - Port to probe (default: 3000)
 */
export async function connect(configPath?: string, port = 3000): Promise<ConnectionResult> {
  // Try HTTP probe first
  const baseUrl = `http://localhost:${port}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(`${baseUrl}/v1/health`, { signal: controller.signal });
    clearTimeout(timer);

    if (res.ok) {
      return {
        mode: 'http',
        httpBaseUrl: `${baseUrl}/v1`,
        cleanup: async () => {},
      };
    }
  } catch {
    // Connection refused, timeout, or any other error → fall back to engine
  }

  // Fall back to temporary engine
  const options: CreateEngineOptions = {};
  if (configPath) options.configPath = configPath;
  const engine = await createEngine(options);

  return {
    mode: 'engine',
    engine,
    cleanup: async () => {
      await engine.shutdown();
    },
  };
}
