// Environment variable interpolation for runcor.yaml config files.
// Walks the parsed YAML object tree, replacing ${VAR} and ${VAR:-default}
// references in string values with their process.env counterparts.
// Collects all missing-var errors and reports them in a single throw.

import { EngineError } from '../errors.js';

/** Regex matching ${VAR} and ${VAR:-default} patterns */
const ENV_VAR_PATTERN = /\$\{([^}:]+)(?::-([^}]*))?\}/g;

/** A missing env var reference collected during interpolation */
interface MissingVar {
  /** The env var name (e.g., "API_KEY") */
  varName: string;
  /** The dot-notation field path (e.g., "providers[0].apiKey") */
  fieldPath: string;
}

/**
 * Recursively interpolates `${VAR}` and `${VAR:-default}` references
 * in all string values of the given object tree.
 *
 * - `${VAR}` — resolves to `process.env[VAR]`. If missing, collects an error.
 * - `${VAR:-default}` — resolves to `process.env[VAR]`, falling back to `default`.
 * - `${VAR:-}` — resolves to `process.env[VAR]`, falling back to empty string.
 *
 * Non-string values (numbers, booleans, null) pass through unchanged.
 *
 * @param obj - The parsed config object (or any value)
 * @returns The same structure with all string `${...}` references resolved
 * @throws {EngineError} code `CONFIG_INVALID` if any required vars are missing
 */
export function interpolateEnvVars(obj: unknown): unknown {
  const missing: MissingVar[] = [];
  const result = walk(obj, '', missing);

  if (missing.length > 0) {
    const lines = missing.map(
      (m) => `  - ${m.fieldPath}: required environment variable is not set`,
    );
    throw new EngineError(
      `Config file references ${missing.length} undefined environment variable${missing.length === 1 ? '' : 's'}:\n${lines.join('\n')}`,
      'CONFIG_INVALID',
    );
  }

  return result;
}

/**
 * Recursive walker that traverses the object tree, interpolating strings
 * and collecting missing-var errors.
 */
function walk(node: unknown, path: string, missing: MissingVar[]): unknown {
  // Null / undefined — pass through
  if (node === null || node === undefined) {
    return node;
  }

  // String — apply env var interpolation
  if (typeof node === 'string') {
    return interpolateString(node, path, missing);
  }

  // Array — recurse into each element with [index] path
  if (Array.isArray(node)) {
    return node.map((element, index) => {
      const elementPath = path ? `${path}[${index}]` : `[${index}]`;
      return walk(element, elementPath, missing);
    });
  }

  // Plain object — recurse into each value with .key path
  if (typeof node === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      result[key] = walk(value, childPath, missing);
    }
    return result;
  }

  // Numbers, booleans, etc. — pass through unchanged
  return node;
}

/**
 * Applies the env var pattern to a single string value.
 * Resolves ${VAR} and ${VAR:-default}. Collects errors for missing
 * required vars (those without a default).
 */
function interpolateString(
  value: string,
  path: string,
  missing: MissingVar[],
): string {
  return value.replace(ENV_VAR_PATTERN, (_match, varName: string, defaultValue?: string) => {
    const envValue = process.env[varName];

    if (envValue !== undefined) {
      return envValue;
    }

    // Has a default (including empty string) — use it
    if (defaultValue !== undefined) {
      return defaultValue;
    }

    // Required var is missing — collect error
    missing.push({ varName, fieldPath: path });
    // Return the original placeholder so the string stays parseable
    // (it will be discarded anyway since we throw after walking)
    return _match;
  });
}
