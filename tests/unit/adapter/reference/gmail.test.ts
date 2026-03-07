// Gmail reference config tests
import { describe, it, expect } from 'vitest';
import {
  gmailAdapterConfig,
  gmailToolSchemas,
} from '../../../../src/adapter/reference/gmail.js';

describe('Gmail reference config', () => {
  describe('gmailAdapterConfig', () => {
    it('should return correct defaults', () => {
      const config = gmailAdapterConfig();
      expect(config.name).toBe('gmail');
      expect(config.transport).toBe('stdio');
      expect(config.command).toBe('npx');
      expect(config.args).toEqual(['-y', '@anthropic/gmail-mcp-server']);
      expect(config.timeoutMs).toBe(30_000);
      expect(config.retryAttempts).toBe(3);
      expect(config.retryDelayMs).toBe(1_000);
      expect(config.healthCheckIntervalMs).toBe(60_000);
    });

    it('should allow overriding timeoutMs', () => {
      const config = gmailAdapterConfig({ timeoutMs: 60_000 });
      expect(config.timeoutMs).toBe(60_000);
      // other defaults preserved
      expect(config.name).toBe('gmail');
      expect(config.transport).toBe('stdio');
    });

    it('should allow overriding retryAttempts', () => {
      const config = gmailAdapterConfig({ retryAttempts: 5 });
      expect(config.retryAttempts).toBe(5);
    });

    it('should allow overriding name', () => {
      const config = gmailAdapterConfig({ name: 'gmail-staging' });
      expect(config.name).toBe('gmail-staging');
    });

    it('should allow overriding transport to sse with url', () => {
      const config = gmailAdapterConfig({
        transport: 'sse',
        url: 'https://gmail-mcp.example.com/sse',
      });
      expect(config.transport).toBe('sse');
      expect(config.url).toBe('https://gmail-mcp.example.com/sse');
    });
  });

  describe('gmailToolSchemas', () => {
    it('should have 4 tool schemas', () => {
      expect(gmailToolSchemas).toHaveLength(4);
    });

    it('should contain the expected tool names', () => {
      const names = gmailToolSchemas.map((t) => t.name);
      expect(names).toEqual([
        'send_email',
        'read_email',
        'search_emails',
        'list_labels',
      ]);
    });

    it('should have a description for every tool', () => {
      for (const tool of gmailToolSchemas) {
        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe('string');
        expect(tool.description!.length).toBeGreaterThan(0);
      }
    });

    it('should have an inputSchema for every tool', () => {
      for (const tool of gmailToolSchemas) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      }
    });

    it('send_email should require to, subject, and body', () => {
      const sendEmail = gmailToolSchemas.find((t) => t.name === 'send_email')!;
      expect(sendEmail.inputSchema.required).toEqual(['to', 'subject', 'body']);
    });

    it('read_email should require messageId', () => {
      const readEmail = gmailToolSchemas.find((t) => t.name === 'read_email')!;
      expect(readEmail.inputSchema.required).toEqual(['messageId']);
    });

    it('search_emails should require query', () => {
      const searchEmails = gmailToolSchemas.find(
        (t) => t.name === 'search_emails',
      )!;
      expect(searchEmails.inputSchema.required).toEqual(['query']);
    });

    it('list_labels should have no required fields', () => {
      const listLabels = gmailToolSchemas.find(
        (t) => t.name === 'list_labels',
      )!;
      expect(listLabels.inputSchema.required).toBeUndefined();
    });
  });
});
