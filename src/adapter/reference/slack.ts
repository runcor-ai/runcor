// Slack reference adapter configuration preset
import type { AdapterConfig, AdapterToolSchema } from '../../types.js';

/** Expected tool schemas for the Slack MCP adapter. */
export const slackToolSchemas: AdapterToolSchema[] = [
  {
    name: 'send_message',
    description: 'Send a message to a Slack channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name or ID' },
        text: { type: 'string', description: 'Message text content' },
        threadTs: {
          type: 'string',
          description: 'Thread timestamp to reply in a thread',
        },
      },
      required: ['channel', 'text'],
    },
  },
  {
    name: 'list_channels',
    description: 'List available Slack channels',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of channels to return',
        },
        cursor: { type: 'string', description: 'Pagination cursor' },
        types: {
          type: 'string',
          description: 'Comma-separated channel types (e.g. public_channel,private_channel)',
        },
      },
    },
  },
  {
    name: 'read_messages',
    description: 'Read messages from a Slack channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name or ID' },
        limit: {
          type: 'number',
          description: 'Maximum number of messages to return',
        },
        oldest: {
          type: 'string',
          description: 'Only messages after this timestamp',
        },
        latest: {
          type: 'string',
          description: 'Only messages before this timestamp',
        },
      },
      required: ['channel'],
    },
  },
  {
    name: 'list_users',
    description: 'List users in the Slack workspace',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of users to return',
        },
        cursor: { type: 'string', description: 'Pagination cursor' },
      },
    },
  },
];

/**
 * Create an AdapterConfig for the Slack MCP adapter.
 * Callers can override any field via the `overrides` parameter.
 */
export function slackAdapterConfig(
  overrides?: Partial<AdapterConfig>,
): AdapterConfig {
  return {
    name: 'slack',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@anthropic/slack-mcp-server'],
    timeoutMs: 30_000,
    retryAttempts: 3,
    retryDelayMs: 1_000,
    healthCheckIntervalMs: 60_000,
    ...overrides,
  };
}
