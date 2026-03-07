// Calendar reference config tests
import { describe, it, expect } from 'vitest';
import {
  calendarAdapterConfig,
  calendarToolSchemas,
} from '../../../../src/adapter/reference/calendar.js';

describe('Calendar reference config', () => {
  describe('calendarAdapterConfig', () => {
    it('should return correct defaults', () => {
      const config = calendarAdapterConfig();
      expect(config.name).toBe('calendar');
      expect(config.transport).toBe('stdio');
      expect(config.command).toBe('npx');
      expect(config.args).toEqual(['-y', '@anthropic/calendar-mcp-server']);
      expect(config.timeoutMs).toBe(30_000);
      expect(config.retryAttempts).toBe(3);
      expect(config.retryDelayMs).toBe(1_000);
      expect(config.healthCheckIntervalMs).toBe(60_000);
    });

    it('should allow overriding timeoutMs', () => {
      const config = calendarAdapterConfig({ timeoutMs: 45_000 });
      expect(config.timeoutMs).toBe(45_000);
      // other defaults preserved
      expect(config.name).toBe('calendar');
      expect(config.transport).toBe('stdio');
    });

    it('should allow overriding retryAttempts', () => {
      const config = calendarAdapterConfig({ retryAttempts: 5 });
      expect(config.retryAttempts).toBe(5);
    });

    it('should allow overriding name', () => {
      const config = calendarAdapterConfig({ name: 'calendar-staging' });
      expect(config.name).toBe('calendar-staging');
    });

    it('should allow overriding transport to sse with url', () => {
      const config = calendarAdapterConfig({
        transport: 'sse',
        url: 'https://calendar-mcp.example.com/sse',
      });
      expect(config.transport).toBe('sse');
      expect(config.url).toBe('https://calendar-mcp.example.com/sse');
    });
  });

  describe('calendarToolSchemas', () => {
    it('should have 4 tool schemas', () => {
      expect(calendarToolSchemas).toHaveLength(4);
    });

    it('should contain the expected tool names', () => {
      const names = calendarToolSchemas.map((t) => t.name);
      expect(names).toEqual([
        'create_event',
        'list_events',
        'update_event',
        'delete_event',
      ]);
    });

    it('should have a description for every tool', () => {
      for (const tool of calendarToolSchemas) {
        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe('string');
        expect(tool.description!.length).toBeGreaterThan(0);
      }
    });

    it('should have an inputSchema for every tool', () => {
      for (const tool of calendarToolSchemas) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      }
    });

    it('create_event should require title, startTime, and endTime', () => {
      const createEvent = calendarToolSchemas.find(
        (t) => t.name === 'create_event',
      )!;
      expect(createEvent.inputSchema.required).toEqual([
        'title',
        'startTime',
        'endTime',
      ]);
    });

    it('update_event should require eventId', () => {
      const updateEvent = calendarToolSchemas.find(
        (t) => t.name === 'update_event',
      )!;
      expect(updateEvent.inputSchema.required).toEqual(['eventId']);
    });

    it('delete_event should require eventId', () => {
      const deleteEvent = calendarToolSchemas.find(
        (t) => t.name === 'delete_event',
      )!;
      expect(deleteEvent.inputSchema.required).toEqual(['eventId']);
    });

    it('list_events should have no required fields', () => {
      const listEvents = calendarToolSchemas.find(
        (t) => t.name === 'list_events',
      )!;
      expect(listEvents.inputSchema.required).toBeUndefined();
    });
  });
});
