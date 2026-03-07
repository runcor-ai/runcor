// Config file loader — discovers, parses, validates, and maps runcor.yaml

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { EngineConfig } from '../types.js';
import type { RuncorConfigFile } from './schema.js';
import { EngineError } from '../errors.js';
import type { ConfigValidationError } from '../errors.js';
import { interpolateEnvVars } from './interpolator.js';
import { validateConfig } from './validator.js';
import { mapToEngineConfig } from './mapper.js';
import {
  mergeProviderFactories,
  mergeEvaluatorFactories,
  getProviderTypeSet,
} from './factories.js';
import type { ProviderFactory, EvaluatorFactory } from './factories.js';

/** Options for loadConfig() */
export interface LoadConfigOptions {
  /** Path to config file. Default: auto-detect runcor.yaml/yml in CWD */
  path?: string;
  /** Base directory for file resolution. Default: process.cwd() */
  basePath?: string;
  /** Custom provider factories. Merged with built-in factories. */
  providerFactories?: Record<string, ProviderFactory>;
  /** Custom evaluator factories. Merged with built-in factories. */
  evaluatorFactories?: Record<string, EvaluatorFactory>;
}

/**
 * Load and validate a runcor.yaml file, returning a fully-resolved EngineConfig.
 *
 * Resolution order for file path:
 * 1. options.path (explicit)
 * 2. RUNCOR_CONFIG env var
 * 3. Auto-detect runcor.yaml or runcor.yml in basePath (default: CWD)
 *
 * Returns undefined if no config file is found (zero-config mode).
 * Throws EngineError(CONFIG_NOT_FOUND) if an explicit path doesn't exist.
 * Throws EngineError(CONFIG_INVALID) if validation fails.
 */
export async function loadConfig(
  options?: LoadConfigOptions,
): Promise<EngineConfig | undefined> {
  const basePath = options?.basePath ?? process.cwd();
  const providerFactories = mergeProviderFactories(options?.providerFactories);
  const evaluatorFactories = mergeEvaluatorFactories(options?.evaluatorFactories);
  const customProviderTypes = getProviderTypeSet(options?.providerFactories);

  // 1. Resolve config file path
  const filePath = resolveConfigPath(options?.path, basePath);
  if (!filePath) {
    return undefined; // No config file found — zero-config mode
  }

  // 2. Read file
  let rawContent: string;
  try {
    rawContent = await readFile(filePath, 'utf-8');
  } catch {
    throw new EngineError(
      `Config file not found or unreadable: ${filePath}`,
      'CONFIG_NOT_FOUND',
    );
  }

  // 3. Parse YAML
  let parsed: unknown;
  try {
    parsed = parseYaml(rawContent);
  } catch (err: unknown) {
    if (err instanceof Error) {
      throw new EngineError(
        `Config file syntax error in ${filePath}:\n  ${err.message}`,
        'CONFIG_INVALID',
      );
    }
    throw new EngineError(
      `Config file syntax error in ${filePath}`,
      'CONFIG_INVALID',
    );
  }

  // 4. Handle empty/comment-only YAML (parses as null)
  if (parsed === null || parsed === undefined) {
    return undefined;
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EngineError(
      `Config file must be a YAML mapping, received ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
      'CONFIG_INVALID',
    );
  }

  // 5. Interpolate env vars
  const interpolated = interpolateEnvVars(parsed) as Record<string, unknown>;

  // 6. Validate against schema
  const errors = validateConfig(interpolated, customProviderTypes);
  if (errors.length > 0) {
    const errorList = errors
      .map((e) => `  - ${e.path}: ${e.message}`)
      .join('\n');
    throw new EngineError(
      `Config validation failed (${errors.length} error${errors.length === 1 ? '' : 's'}):\n${errorList}`,
      'CONFIG_INVALID',
    );
  }

  // 7. Map to EngineConfig
  const yamlConfig = interpolated as unknown as RuncorConfigFile;
  return mapToEngineConfig(yamlConfig, providerFactories, evaluatorFactories);
}

/** Resolve config file path using precedence: option > env > auto-detect */
function resolveConfigPath(
  explicitPath: string | undefined,
  basePath: string,
): string | null {
  // 1. Explicit path option
  if (explicitPath) {
    const resolved = resolve(basePath, explicitPath);
    if (!existsSync(resolved)) {
      throw new EngineError(
        `Config file not found: ${resolved}`,
        'CONFIG_NOT_FOUND',
      );
    }
    return resolved;
  }

  // 2. RUNCOR_CONFIG env var
  const envPath = process.env.RUNCOR_CONFIG;
  if (envPath) {
    const resolved = resolve(basePath, envPath);
    // Prevent path traversal — resolved path must remain within basePath
    // Use case-insensitive comparison on Windows where filesystem is case-insensitive
    const normalizedBase = resolve(basePath);
    const isWindows = process.platform === 'win32';
    const resolvedCmp = isWindows ? resolved.toLowerCase() : resolved;
    const baseCmp = isWindows ? normalizedBase.toLowerCase() : normalizedBase;
    if (!resolvedCmp.startsWith(baseCmp)) {
      throw new EngineError(
        `Config path must be within the base directory`,
        'CONFIG_INVALID',
      );
    }
    if (!existsSync(resolved)) {
      throw new EngineError(
        `Config file not found: ${resolved}`,
        'CONFIG_NOT_FOUND',
      );
    }
    return resolved;
  }

  // 3. Auto-detect: runcor.yaml takes precedence over runcor.yml
  const yamlPath = resolve(basePath, 'runcor.yaml');
  if (existsSync(yamlPath)) {
    return yamlPath;
  }

  const ymlPath = resolve(basePath, 'runcor.yml');
  if (existsSync(ymlPath)) {
    return ymlPath;
  }

  // No config file found
  return null;
}
