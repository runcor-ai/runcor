// Validation module for structured output

import AjvModule from 'ajv';
import type { ValidateFunction, ErrorObject } from 'ajv';

// ESM/CJS compat — Ajv may export as default or as module itself
const Ajv = (AjvModule as any).default ?? AjvModule;
import type { ResponseFormat, JsonSchema } from '../types.js';
import { ValidationError } from '../errors.js';
import type { ValidationErrorDetail } from '../errors.js';

// Module-level ajv instance: draft-07, allErrors: true
const ajv = new Ajv({ allErrors: true });

// Schema compilation cache keyed by JSON.stringify(schema) (R5: Caching Strategy)
const MAX_SCHEMA_CACHE_SIZE = 500;
const schemaCache = new Map<string, ValidateFunction>();

/**
 * Check if a schema object contains remote $ref URLs.
 * Recursively walks the schema tree looking for $ref values that start with http(s).
 */
export function hasRemoteRef(schema: JsonSchema): boolean {
  if (typeof schema !== 'object' || schema === null) return false;

  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' && typeof value === 'string') {
      if (value.startsWith('http://') || value.startsWith('https://')) {
        return true;
      }
    }
    if (typeof value === 'object' && value !== null) {
      if (hasRemoteRef(value as JsonSchema)) return true;
    }
  }
  return false;
}

/**
 * Compile and cache a JSON Schema validator.
 * Throws ValidationError for invalid schemas or schemas with remote $ref.
 */
export function compileSchema(schema: JsonSchema): ValidateFunction {
  const key = JSON.stringify(schema);

  const cached = schemaCache.get(key);
  if (cached) return cached;

  // Check for remote $ref before compilation
  if (hasRemoteRef(schema)) {
    throw new ValidationError(
      [{ path: '', message: 'Remote $ref URLs are not supported', keyword: '$ref' }],
      '',
    );
  }

  try {
    const validate = ajv.compile(schema);
    // Evict oldest entry if cache is full
    if (schemaCache.size >= MAX_SCHEMA_CACHE_SIZE) {
      const firstKey = schemaCache.keys().next().value;
      if (firstKey !== undefined) schemaCache.delete(firstKey);
    }
    schemaCache.set(key, validate);
    return validate;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(
      [{ path: '', message: `Invalid JSON Schema: ${message}`, keyword: 'schema' }],
      '',
    );
  }
}

/**
 * Strip common code fence wrapping before parsing.
 * Handles ```json\n...\n``` and ```\n...\n``` with optional whitespace.
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  // Match ```json or ``` at the start, and ``` at the end
  const match = trimmed.match(/^```(?:json|JSON)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  if (match) {
    return match[1];
  }
  return text;
}

/**
 * Format ajv ErrorObject[] into ValidationErrorDetail[].
 */
export function formatErrors(errors: ErrorObject[]): ValidationErrorDetail[] {
  return errors.map((err) => ({
    path: err.instancePath || '',
    message: err.message || 'Unknown validation error',
    keyword: err.keyword,
  }));
}

/**
 * Validate text against responseFormat.
 * Returns parsed value on success, throws ValidationError on failure.
 * Returns undefined for 'text' mode.
 */
export function validateResponse(text: string, format: ResponseFormat): unknown {
  // Text mode — no validation
  if (format === 'text') return undefined;

  // Strip code fences
  const stripped = stripCodeFences(text);

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new ValidationError(
      [{ path: '', message: 'Response is not valid JSON', keyword: 'json' }],
      text,
    );
  }

  // JSON mode — just parse, no schema validation
  if (format === 'json') return parsed;

  // Schema mode — validate against schema
  const validate = compileSchema(format);
  if (validate(parsed)) {
    return parsed;
  }

  // Validation failed
  const errors = formatErrors(validate.errors ?? []);
  throw new ValidationError(errors, text);
}

/**
 * Build retry hint message from validation errors (R6).
 */
export function buildRetryHint(errors: ValidationErrorDetail[]): string {
  const errorLines = errors.map((e) => {
    const prefix = e.path ? `${e.path}: ` : '';
    return `- ${prefix}${e.message}`;
  });

  if (errorLines.length === 0) {
    return 'Your previous response was not valid JSON. Please respond with valid JSON.';
  }

  return [
    'Your previous response was not valid JSON matching the required schema. Validation errors:',
    ...errorLines,
    'Please try again and respond with valid JSON conforming to the schema.',
  ].join('\n');
}

/**
 * Validate responseFormat at request time.
 * Throws ValidationError for invalid schemas. No-op for 'text', 'json', or undefined.
 */
export function validateRequestFormat(format: ResponseFormat | undefined): void {
  if (format === undefined || format === 'text' || format === 'json') return;

  // It's a schema object — compile it (which validates it and checks for remote $ref)
  compileSchema(format);
}
