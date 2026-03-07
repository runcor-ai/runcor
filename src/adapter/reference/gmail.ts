// Gmail reference adapter configuration preset
import type { AdapterConfig, AdapterToolSchema } from '../../types.js';

/** Expected tool schemas for the Gmail MCP adapter. */
export const gmailToolSchemas: AdapterToolSchema[] = [
  {
    name: 'send_email',
    description: 'Send an email message',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body content' },
        cc: { type: 'string', description: 'CC recipient email address' },
        bcc: { type: 'string', description: 'BCC recipient email address' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'read_email',
    description: 'Read an email message by ID',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'Unique email message identifier' },
        format: {
          type: 'string',
          enum: ['full', 'metadata', 'minimal'],
          description: 'Response format level',
        },
      },
      required: ['messageId'],
    },
  },
  {
    name: 'search_emails',
    description: 'Search emails matching a query',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query string' },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results to return',
        },
        pageToken: { type: 'string', description: 'Token for pagination' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_labels',
    description: 'List all labels in the mailbox',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Create an AdapterConfig for the Gmail MCP adapter.
 * Callers can override any field via the `overrides` parameter.
 */
export function gmailAdapterConfig(
  overrides?: Partial<AdapterConfig>,
): AdapterConfig {
  return {
    name: 'gmail',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@anthropic/gmail-mcp-server'],
    timeoutMs: 30_000,
    retryAttempts: 3,
    retryDelayMs: 1_000,
    healthCheckIntervalMs: 60_000,
    ...overrides,
  };
}
