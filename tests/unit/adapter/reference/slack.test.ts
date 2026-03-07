// Slack reference config tests
import { describe, it, expect } from 'vitest';
import {
  slackAdapterConfig,
  slackToolSchemas,
} from '../../../../src/adapter/reference/slack.js';

describe('Slack reference config', () => {
  describe('slackAdapterConfig', () => {
    it('should return correct defaults', () => {
      const config = slackAdapterConfig();
      expect(config.name).toBe('slack');
      expect(config.transport).toBe('stdio');
      expect(config.command).toBe('npx');
      expect(config.args).toEqual(['-y', '@anthropic/slack-mcp-server']);
      expect(config.timeoutMs).toBe(30_000);
      expect(config.retryAttempts).toBe(3);
      expect(config.retryDelayMs).toBe(1_000);
      expect(config.healthCheckIntervalMs).toBe(60_000);
    });

    it('should allow overriding timeoutMs', () => {
      const config = slackAdapterConfig({ timeoutMs: 15_000 });
      expect(config.timeoutMs).toBe(15_000);
      // other defaults preserved
      expect(config.name).toBe('slack');
      expect(config.transport).toBe('stdio');
    });

    it('should allow overriding retryAttempts', () => {
      const config = slackAdapterConfig({ retryAttempts: 5 });
      expect(config.retryAttempts).toBe(5);
    });

    it('should allow overriding name', () => {
      const config = slackAdapterConfig({ name: 'slack-staging' });
      expect(config.name).toBe('slack-staging');
    });

    it('should allow overriding transport to sse with url', () => {
      const config = slackAdapterConfig({
        transport: 'sse',
        url: 'https://slack-mcp.example.com/sse',
      });
      expect(config.transport).toBe('sse');
      expect(config.url).toBe('https://slack-mcp.example.com/sse');
    });
  });

  describe('slackToolSchemas', () => {
    it('should have 4 tool schemas', () => {
      expect(slackToolSchemas).toHaveLength(4);
    });

    it('should contain the expected tool names', () => {
      const names = slackToolSchemas.map((t) => t.name);
      expect(names).toEqual([
        'send_message',
        'list_channels',
        'read_messages',
        'list_users',
      ]);
    });

    it('should have a description for every tool', () => {
      for (const tool of slackToolSchemas) {
        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe('string');
        expect(tool.description!.length).toBeGreaterThan(0);
      }
    });

    it('should have an inputSchema for every tool', () => {
      for (const tool of slackToolSchemas) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      }
    });

    it('send_message should require channel and text', () => {
      const sendMessage = slackToolSchemas.find(
        (t) => t.name === 'send_message',
      )!;
      expect(sendMessage.inputSchema.required).toEqual(['channel', 'text']);
    });

    it('read_messages should require channel', () => {
      const readMessages = slackToolSchemas.find(
        (t) => t.name === 'read_messages',
      )!;
      expect(readMessages.inputSchema.required).toEqual(['channel']);
    });

    it('list_channels should have no required fields', () => {
      const listChannels = slackToolSchemas.find(
        (t) => t.name === 'list_channels',
      )!;
      expect(listChannels.inputSchema.required).toBeUndefined();
    });

    it('list_users should have no required fields', () => {
      const listUsers = slackToolSchemas.find(
        (t) => t.name === 'list_users',
      )!;
      expect(listUsers.inputSchema.required).toBeUndefined();
    });
  });
});
