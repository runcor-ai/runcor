// Calendar reference adapter configuration preset
import type { AdapterConfig, AdapterToolSchema } from '../../types.js';

/** Expected tool schemas for the Calendar MCP adapter. */
export const calendarToolSchemas: AdapterToolSchema[] = [
  {
    name: 'create_event',
    description: 'Create a new calendar event',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title' },
        startTime: {
          type: 'string',
          description: 'Event start time in ISO 8601 format',
        },
        endTime: {
          type: 'string',
          description: 'Event end time in ISO 8601 format',
        },
        description: { type: 'string', description: 'Event description' },
        location: { type: 'string', description: 'Event location' },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of attendee email addresses',
        },
      },
      required: ['title', 'startTime', 'endTime'],
    },
  },
  {
    name: 'list_events',
    description: 'List calendar events within a time range',
    inputSchema: {
      type: 'object',
      properties: {
        startTime: {
          type: 'string',
          description: 'Range start time in ISO 8601 format',
        },
        endTime: {
          type: 'string',
          description: 'Range end time in ISO 8601 format',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of events to return',
        },
        calendarId: {
          type: 'string',
          description: 'Calendar identifier (defaults to primary)',
        },
      },
    },
  },
  {
    name: 'update_event',
    description: 'Update an existing calendar event',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Unique event identifier' },
        title: { type: 'string', description: 'Updated event title' },
        startTime: {
          type: 'string',
          description: 'Updated start time in ISO 8601 format',
        },
        endTime: {
          type: 'string',
          description: 'Updated end time in ISO 8601 format',
        },
        description: { type: 'string', description: 'Updated event description' },
        location: { type: 'string', description: 'Updated event location' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'delete_event',
    description: 'Delete a calendar event',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Unique event identifier' },
        sendUpdates: {
          type: 'string',
          enum: ['all', 'externalOnly', 'none'],
          description: 'Whether to send cancellation notifications',
        },
      },
      required: ['eventId'],
    },
  },
];

/**
 * Create an AdapterConfig for the Calendar MCP adapter.
 * Callers can override any field via the `overrides` parameter.
 */
export function calendarAdapterConfig(
  overrides?: Partial<AdapterConfig>,
): AdapterConfig {
  return {
    name: 'calendar',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@anthropic/calendar-mcp-server'],
    timeoutMs: 30_000,
    retryAttempts: 3,
    retryDelayMs: 1_000,
    healthCheckIntervalMs: 60_000,
    ...overrides,
  };
}
