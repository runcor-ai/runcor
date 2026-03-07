// SignalAccumulator — event-based counters for ephemeral data

import type { EventEmitter } from 'node:events';

/** A timestamped entry from an event */
export interface AccumulatorEntry {
  flowName: string;
  timestamp: Date;
  payload: Record<string, unknown>;
}

type EntryCategory = 'violation' | 'rate_limited' | 'tool_call' | 'mcp_invocation';

/**
 * Accumulates ephemeral event data between discernment cycles.
 * Subscribes to engine events and stores timestamped entries for
 * policy violations, rate limit hits, adapter tool calls, and MCP invocations.
 */
export class SignalAccumulator {
  private readonly entries = new Map<EntryCategory, AccumulatorEntry[]>([
    ['violation', []],
    ['rate_limited', []],
    ['tool_call', []],
    ['mcp_invocation', []],
  ]);

  private emitter: EventEmitter | null = null;
  private readonly listeners = new Map<string, (...args: unknown[]) => void>();

  /** Subscribe to engine events */
  attach(emitter: EventEmitter): void {
    this.emitter = emitter;

    const onViolation = (payload: Record<string, unknown>) => {
      const flowName = (payload.flowName as string) || '__global';
      this.entries.get('violation')!.push({
        flowName,
        timestamp: (payload.timestamp as Date) || new Date(),
        payload,
      });
    };

    const onRateLimited = (payload: Record<string, unknown>) => {
      const flowName = (payload.flowName as string) || '__global';
      this.entries.get('violation')!.push({
        flowName,
        timestamp: (payload.timestamp as Date) || new Date(),
        payload: { ...payload, _type: 'rate_limited' },
      });
    };

    const onToolCall = (payload: Record<string, unknown>) => {
      this.entries.get('tool_call')!.push({
        flowName: '__global',
        timestamp: new Date(),
        payload,
      });
    };

    this.listeners.set('policy:violation', onViolation as any);
    this.listeners.set('policy:rate_limited', onRateLimited as any);
    this.listeners.set('adapter:tool_call', onToolCall as any);

    emitter.on('policy:violation', onViolation as any);
    emitter.on('policy:rate_limited', onRateLimited as any);
    emitter.on('adapter:tool_call', onToolCall as any);
  }

  /** Unsubscribe from events */
  detach(): void {
    if (!this.emitter) return;
    for (const [event, listener] of this.listeners) {
      this.emitter.off(event, listener as any);
    }
    this.listeners.clear();
    this.emitter = null;
  }

  /** Get policy violations for a flow within the lookback window */
  getViolations(flowName: string, startTime: Date): AccumulatorEntry[] {
    return this.query('violation', flowName, startTime);
  }

  /** Get adapter tool calls within the lookback window */
  getToolCalls(flowName: string, startTime: Date): AccumulatorEntry[] {
    return this.query('tool_call', flowName, startTime);
  }

  /** Get MCP server invocations within the lookback window */
  getMcpInvocations(flowName: string, startTime: Date): AccumulatorEntry[] {
    return this.query('mcp_invocation', flowName, startTime);
  }

  /** Remove entries older than cutoff across all categories */
  prune(cutoffTime: Date): void {
    for (const [category, entries] of this.entries) {
      this.entries.set(
        category,
        entries.filter(e => e.timestamp >= cutoffTime),
      );
    }
  }

  /** Query entries by category, flow name, and start time */
  private query(category: EntryCategory, flowName: string, startTime: Date): AccumulatorEntry[] {
    const entries = this.entries.get(category) || [];
    return entries.filter(e => e.flowName === flowName && e.timestamp >= startTime);
  }
}
