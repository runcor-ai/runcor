// CLI output formatting — colors, tables, JSON, error messages, event log
// No external dependencies — inline ANSI escape codes

const isColorSupported =
  !process.env['NO_COLOR'] &&
  process.stdout.isTTY === true;

let colorEnabled = isColorSupported;

export function disableColor(): void {
  colorEnabled = false;
}

export function isColorEnabled(): boolean {
  return colorEnabled;
}

// ── ANSI color helpers ──

function wrap(code: string, text: string): string {
  return colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const red = (t: string) => wrap('31', t);
export const green = (t: string) => wrap('32', t);
export const yellow = (t: string) => wrap('33', t);
export const blue = (t: string) => wrap('34', t);
export const magenta = (t: string) => wrap('35', t);
export const cyan = (t: string) => wrap('36', t);
export const dim = (t: string) => wrap('2', t);
export const bold = (t: string) => wrap('1', t);

// ── Table formatting ──

export interface Column {
  key: string;
  label: string;
  width: number;
}

export function formatTable(rows: Record<string, string>[], columns: Column[]): string {
  const lines: string[] = [];

  // Header
  const header = columns.map(c => c.label.padEnd(c.width)).join('  ');
  lines.push(header);

  // Separator
  const sep = columns.map(c => '\u2500'.repeat(c.width)).join('  ');
  lines.push(sep);

  // Rows
  for (const row of rows) {
    const line = columns.map(c => {
      const val = row[c.key] ?? '';
      return val.length > c.width ? val.slice(0, c.width - 1) + '\u2026' : val.padEnd(c.width);
    }).join('  ');
    lines.push(line);
  }

  return lines.join('\n');
}

// ── JSON output ──

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// ── Error / success formatting ──

export function formatError(code: string, message: string): string {
  return red(`Error: ${message}`);
}

export function formatSuccess(message: string): string {
  return green(message);
}

// ── Event log formatting ──

/** Maps engine event names to display categories */
const EVENT_CATEGORIES: Record<string, { category: string; color: (t: string) => string }> = {
  'execution:state_change': { category: 'execution', color: cyan },
  'execution:complete': { category: 'complete', color: cyan },
  'cost:request': { category: 'cost', color: yellow },
  'cost:budget_warning': { category: 'cost', color: yellow },
  'cost:budget_exceeded': { category: 'cost', color: red },
  'policy:violation': { category: 'policy', color: magenta },
  'policy:warning': { category: 'policy', color: magenta },
  'policy:rate_limited': { category: 'policy', color: magenta },
  'eval:score': { category: 'eval', color: green },
  'eval:complete': { category: 'eval', color: green },
  'eval:flagged': { category: 'eval', color: yellow },
  'adapter:connected': { category: 'adapter', color: blue },
  'adapter:disconnected': { category: 'adapter', color: blue },
  'adapter:error': { category: 'adapter', color: red },
  'adapter:tools_discovered': { category: 'adapter', color: blue },
  'adapter:tool_call': { category: 'adapter', color: blue },
  'flow:registered': { category: 'flow', color: dim },
  'flow:unregistered': { category: 'flow', color: dim },
  'scheduler:trigger': { category: 'scheduler', color: dim },
  'scheduler:skip': { category: 'scheduler', color: dim },
  'scheduler:registered': { category: 'scheduler', color: dim },
  'scheduler:removed': { category: 'scheduler', color: dim },
  'provider:health_change': { category: 'provider', color: dim },
  'ready': { category: 'engine', color: green },
  'shutdown': { category: 'engine', color: dim },
};

export function formatEventLog(eventName: string, data: Record<string, unknown>): string {
  const now = new Date();
  const ts = [
    now.getHours().toString().padStart(2, '0'),
    now.getMinutes().toString().padStart(2, '0'),
    now.getSeconds().toString().padStart(2, '0'),
  ].join(':');

  const mapping = EVENT_CATEGORIES[eventName] ?? { category: eventName, color: dim };
  const tag = mapping.color(`[${mapping.category}]`);
  const flow = (data['flowName'] as string) ?? '';
  const execId = (data['executionId'] as string) ?? '';

  let msg = '';
  if (eventName === 'execution:state_change') {
    msg = `${data['from']} \u2192 ${data['to']}`;
  } else if (eventName === 'execution:complete') {
    msg = data['error'] ? `failed` : 'complete';
  } else if (eventName === 'cost:request') {
    const cost = data['cost'] as number | undefined;
    const model = (data['model'] as string) ?? '';
    msg = cost !== undefined ? `$${cost.toFixed(4)}  ${model}` : model;
  } else if (eventName === 'cost:budget_exceeded') {
    msg = `budget exceeded`;
  } else if (eventName === 'policy:violation') {
    msg = (data['reason'] as string) ?? 'denied';
  } else if (eventName === 'policy:rate_limited') {
    msg = `rate limited`;
  } else if (eventName === 'adapter:connected' || eventName === 'adapter:disconnected') {
    msg = (data['name'] as string) ?? '';
  } else if (eventName === 'adapter:error') {
    msg = `${data['name']}: ${data['error']}`;
  } else if (eventName === 'flow:registered' || eventName === 'flow:unregistered') {
    msg = (data['name'] as string) ?? '';
  } else if (eventName === 'eval:flagged') {
    msg = `flagged: ${data['reason'] ?? ''}`;
  } else {
    // Generic: stringify first few keys
    const keys = Object.keys(data).filter(k => k !== 'flowName' && k !== 'executionId' && k !== 'timestamp');
    msg = keys.slice(0, 3).map(k => `${k}=${data[k]}`).join(' ');
  }

  const parts = [ts, tag];
  if (flow) parts.push(flow);
  if (msg) parts.push(msg);
  if (execId) parts.push(dim(`(${execId.slice(0, 12)})`));

  return parts.join('  ');
}

// ── Relative time formatting ──

export function relativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
