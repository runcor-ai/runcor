// ToolRouter — qualified-name routing for adapter tools
// Maps "adapterName.toolName" → adapter, enabling cross-adapter tool discovery.

import type { AdapterToolSchema, AdapterToolInfo } from '../types.js';
import { EngineError } from '../errors.js';

/** Tool names reserved by the engine — cannot be registered by user adapters */
const RESERVED_TOOL_NAMES = new Set(['__structured_output']);

/**
 * Routes tool calls to the correct adapter by maintaining a registry
 * of qualified tool names (adapterName.toolName).
 */
export class ToolRouter {
  /** Maps qualifiedName → adapterName that owns the tool */
  private readonly toolIndex = new Map<string, string>();

  /** Maps qualifiedName → the original AdapterToolSchema */
  private readonly toolSchemas = new Map<string, AdapterToolSchema>();

  /**
   * Register tools from an adapter. Each tool gets a qualified name
   * of the form "adapterName.toolName".
   *
   * @throws EngineError with code DUPLICATE_TOOL if a qualified name
   *         already exists from a different adapter.
   */
  register(adapterName: string, tools: AdapterToolSchema[]): void {
    for (const tool of tools) {
      // Reject reserved tool names
      if (RESERVED_TOOL_NAMES.has(tool.name)) {
        throw new EngineError(
          `Tool name "${tool.name}" is reserved by the engine and cannot be registered by adapter "${adapterName}".`,
          'RESERVED_TOOL_NAME',
        );
      }

      const qualifiedName = `${adapterName}.${tool.name}`;
      const existing = this.toolIndex.get(qualifiedName);

      if (existing !== undefined && existing !== adapterName) {
        throw new EngineError(
          `Tool "${qualifiedName}" is already registered by adapter "${existing}"`,
          'DUPLICATE_TOOL',
        );
      }

      this.toolIndex.set(qualifiedName, adapterName);
      this.toolSchemas.set(qualifiedName, tool);
    }
  }

  /**
   * Remove all tools belonging to the specified adapter.
   */
  unregister(adapterName: string): void {
    for (const [qualifiedName, owner] of this.toolIndex) {
      if (owner === adapterName) {
        this.toolIndex.delete(qualifiedName);
        this.toolSchemas.delete(qualifiedName);
      }
    }
  }

  /**
   * Resolve a qualified tool name to the adapter that owns it.
   * Returns null if the tool is not registered.
   */
  resolve(qualifiedName: string): string | null {
    return this.toolIndex.get(qualifiedName) ?? null;
  }

  /**
   * List all registered tools, optionally filtered by adapter name.
   */
  list(filter?: { adapter?: string }): AdapterToolInfo[] {
    const result: AdapterToolInfo[] = [];

    for (const [qualifiedName, adapterName] of this.toolIndex) {
      if (filter?.adapter !== undefined && adapterName !== filter.adapter) {
        continue;
      }

      const schema = this.toolSchemas.get(qualifiedName)!;
      result.push({
        qualifiedName,
        adapterName,
        toolName: schema.name,
        description: schema.description,
        inputSchema: schema.inputSchema,
      });
    }

    return result;
  }
}
