// Unit tests for dashboard route serving + health capabilities

import { describe, it, expect } from 'vitest';
import { DASHBOARD_HTML } from '../../../src/http/dashboard-html.js';

describe('Dashboard HTML', () => {
  it('exports a non-empty HTML string', () => {
    expect(typeof DASHBOARD_HTML).toBe('string');
    expect(DASHBOARD_HTML.length).toBeGreaterThan(1000);
  });

  it('contains DOCTYPE declaration', () => {
    expect(DASHBOARD_HTML).toContain('<!DOCTYPE html>');
  });

  it('contains runcor dashboard title', () => {
    expect(DASHBOARD_HTML).toContain('<title>runcor dashboard</title>');
  });

  it('contains stats bar elements', () => {
    expect(DASHBOARD_HTML).toContain('id="stat-status"');
    expect(DASHBOARD_HTML).toContain('id="stat-uptime"');
    expect(DASHBOARD_HTML).toContain('id="stat-active"');
    expect(DASHBOARD_HTML).toContain('id="stat-cost"');
  });

  it('contains 3-column layout', () => {
    expect(DASHBOARD_HTML).toContain('panel-left');
    expect(DASHBOARD_HTML).toContain('panel-center');
    expect(DASHBOARD_HTML).toContain('panel-right');
  });

  it('contains tabbed sidebar with Providers/Cost/Discernment', () => {
    expect(DASHBOARD_HTML).toContain('data-tab="providers"');
    expect(DASHBOARD_HTML).toContain('data-tab="cost"');
    expect(DASHBOARD_HTML).toContain('data-tab="discernment"');
  });

  it('contains overlay for execution detail', () => {
    expect(DASHBOARD_HTML).toContain('overlay-backdrop');
    expect(DASHBOARD_HTML).toContain('overlay-close');
  });

  it('contains SSE connection logic', () => {
    expect(DASHBOARD_HTML).toContain('EventSource');
    expect(DASHBOARD_HTML).toContain('connectSSE');
  });

  it('contains connection status indicator', () => {
    expect(DASHBOARD_HTML).toContain('id="conn-dot"');
    expect(DASHBOARD_HTML).toContain('id="conn-text"');
  });

  it('contains empty state message for no executions', () => {
    expect(DASHBOARD_HTML).toContain('No executions yet');
  });

  it('contains empty state for no adapters', () => {
    expect(DASHBOARD_HTML).toContain('No adapters configured');
  });

  it('does NOT contain any dummy/hardcoded connection data', () => {
    // Verify no fake adapter names from the demo
    expect(DASHBOARD_HTML).not.toContain('OpenAI GPT-4');
    expect(DASHBOARD_HTML).not.toContain('Google Gemini');
    expect(DASHBOARD_HTML).not.toContain('Salesforce CRM');
    expect(DASHBOARD_HTML).not.toContain('PostgreSQL');
    expect(DASHBOARD_HTML).not.toContain('SendGrid');
  });

  it('contains Escape key handler for overlay close', () => {
    expect(DASHBOARD_HTML).toContain("e.key === 'Escape'");
  });

  it('contains auto-reconnect with backoff', () => {
    expect(DASHBOARD_HTML).toContain('sseRetryDelay');
    expect(DASHBOARD_HTML).toContain('30000'); // max backoff
  });

  it('contains MAX_CARDS cap of 200', () => {
    expect(DASHBOARD_HTML).toContain('MAX_CARDS = 200');
  });

  it('contains 2s poll interval', () => {
    expect(DASHBOARD_HTML).toContain('POLL_INTERVAL = 2000');
  });

  it('contains visibility change handler for resync', () => {
    expect(DASHBOARD_HTML).toContain('visibilitychange');
  });
});
