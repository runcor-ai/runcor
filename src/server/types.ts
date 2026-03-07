// MCP Server configuration types

/** Configuration for the MCP server */
export interface MCPServerConfig {
  /** Whether to start the MCP server. Default: false */
  enabled?: boolean;
  /** Server name reported in MCP handshake. Default: "runcor" */
  name?: string;
  /** Server version reported in MCP handshake. Default: engine package version */
  version?: string;
}
