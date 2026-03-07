// Dashboard HTML — embedded as a string constant for zero-dependency serving
// Dashboard UI
// This file is the single source of truth for the dashboard page.

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>runcor dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
:root {
  --bg-0: #0a0a0f;
  --bg-1: #12121a;
  --bg-2: #1a1a26;
  --bg-3: #222233;
  --border: #2a2a3d;
  --text-0: #e8e8f0;
  --text-1: #a0a0b8;
  --text-2: #6a6a82;
  --accent: #4fc3f7;
  --green: #66bb6a;
  --amber: #ffa726;
  --red: #ef5350;
  --blue: #42a5f5;
  --purple: #ab47bc;
  --cyan: #26c6da;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: 'JetBrains Mono', monospace;
  background: var(--bg-0);
  color: var(--text-0);
  min-height: 100vh;
  overflow-x: hidden;
}

/* ── Header / Stats Bar ─────────────────────────────── */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  background: var(--bg-1);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 100;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 14px;
}

.logo {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--accent);
}

.logo span { color: var(--text-2); font-weight: 400; font-size: 11px; }

.connection-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-2);
}

.connection-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--green);
}

.connection-dot.disconnected { background: var(--red); }
.connection-dot.reconnecting { background: var(--amber); animation: pulse 1s ease-in-out infinite; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.stats-bar {
  display: flex;
  gap: 20px;
  font-size: 11px;
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.stat-label {
  color: var(--text-2);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.stat-value {
  font-weight: 600;
  font-size: 13px;
}

.stat-value.green { color: var(--green); }
.stat-value.amber { color: var(--amber); }
.stat-value.red { color: var(--red); }

/* ── Layout ──────────────────────────────────────────── */
.layout {
  display: grid;
  grid-template-columns: 240px 1fr 300px;
  height: calc(100vh - 46px);
}

/* ── Left: Connections Panel ─────────────────────────── */
.panel-left {
  background: var(--bg-1);
  border-right: 1px solid var(--border);
  overflow-y: auto;
  padding: 12px;
}

.panel-title {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--text-2);
  margin-bottom: 12px;
}

.adapter-card {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 8px;
}

.adapter-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.adapter-name {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
}

.adapter-state {
  font-size: 9px;
  padding: 2px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.adapter-state.connected { background: rgba(102,187,106,0.15); color: var(--green); }
.adapter-state.disconnected { background: rgba(239,83,80,0.15); color: var(--red); }
.adapter-state.reconnecting { background: rgba(255,167,38,0.15); color: var(--amber); }
.adapter-state.pending { background: rgba(106,106,130,0.15); color: var(--text-2); }

.adapter-meta {
  font-size: 10px;
  color: var(--text-2);
}

.empty-state {
  text-align: center;
  padding: 30px 16px;
  color: var(--text-2);
  font-size: 11px;
}

/* ── Center: Execution Feed ──────────────────────────── */
.panel-center {
  overflow-y: auto;
  padding: 12px 16px;
}

.exec-card {
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 6px;
  cursor: pointer;
  transition: border-color 0.15s;
}

.exec-card:hover { border-color: var(--accent); }

.exec-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.exec-flow-name {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 300px;
}

.exec-state {
  font-size: 9px;
  padding: 2px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.exec-state.queued { background: rgba(106,106,130,0.15); color: var(--text-2); }
.exec-state.running { background: rgba(79,195,247,0.15); color: var(--accent); }
.exec-state.complete { background: rgba(102,187,106,0.15); color: var(--green); }
.exec-state.failed { background: rgba(239,83,80,0.15); color: var(--red); }
.exec-state.waiting { background: rgba(255,167,38,0.15); color: var(--amber); }
.exec-state.retrying { background: rgba(171,71,188,0.15); color: var(--purple); }

.exec-meta {
  font-size: 10px;
  color: var(--text-2);
  display: flex;
  gap: 12px;
}

.exec-user {
  color: var(--accent);
  font-weight: 500;
}

.exec-provider { font-weight: 500; }
.exec-provider.anthropic { color: #d4a574; }
.exec-provider.openai { color: #74d4a5; }
.exec-provider.google { color: #a574d4; }

.exec-error {
  font-size: 10px;
  color: var(--red);
  margin-top: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Right: Tabbed Sidebar ───────────────────────────── */
.panel-right {
  background: var(--bg-1);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

.tab-bar {
  display: flex;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.tab-btn {
  flex: 1;
  padding: 8px 4px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-2);
  font-family: inherit;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.tab-btn:hover { color: var(--text-1); }
.tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }

.tab-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: none;
}

.tab-content.active { display: block; }

/* Provider card */
.provider-card {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 8px;
}

.provider-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.provider-name {
  font-size: 12px;
  font-weight: 500;
}

.health-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.health-dot.healthy { background: var(--green); }
.health-dot.unhealthy { background: var(--red); }
.health-dot.half_open { background: var(--amber); }

.provider-meta {
  font-size: 10px;
  color: var(--text-2);
  display: flex;
  gap: 12px;
}

/* Cost summary */
.cost-total {
  font-size: 20px;
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 12px;
}

.cost-section-title {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-2);
  margin: 12px 0 6px;
}

.cost-row {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  padding: 3px 0;
  border-bottom: 1px solid var(--border);
}

.cost-row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}

.cost-row-value { color: var(--accent); font-weight: 500; }

/* Discernment */
.objective-item {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 6px;
}

.objective-name {
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 2px;
}

.objective-desc {
  font-size: 10px;
  color: var(--text-2);
}

.rec-card {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 8px;
}

.rec-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.rec-action {
  font-size: 9px;
  padding: 2px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  font-weight: 600;
}

.rec-action.keep { background: rgba(102,187,106,0.15); color: var(--green); }
.rec-action.optimize { background: rgba(66,165,245,0.15); color: var(--blue); }
.rec-action.merge { background: rgba(38,198,218,0.15); color: var(--cyan); }
.rec-action.retire { background: rgba(239,83,80,0.15); color: var(--red); }
.rec-action.investigate { background: rgba(255,167,38,0.15); color: var(--amber); }
.rec-action.escalate { background: rgba(171,71,188,0.15); color: var(--purple); }

.rec-target {
  font-size: 12px;
  font-weight: 500;
}

.rec-explanation {
  font-size: 10px;
  color: var(--text-1);
}

.rec-confidence {
  font-size: 10px;
  color: var(--text-2);
  margin-top: 4px;
}

/* ── Overlay ─────────────────────────────────────────── */
.overlay-backdrop {
  display: none;
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.6);
  z-index: 200;
}

.overlay-backdrop.open { display: flex; align-items: center; justify-content: center; }

.overlay {
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: 700px;
  max-height: 80vh;
  overflow-y: auto;
  padding: 20px;
  position: relative;
}

.overlay-close {
  position: absolute;
  top: 12px;
  right: 12px;
  background: none;
  border: none;
  color: var(--text-2);
  font-size: 18px;
  cursor: pointer;
  font-family: inherit;
}

.overlay-close:hover { color: var(--text-0); }

.overlay-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 16px;
}

.overlay-section {
  margin-bottom: 16px;
}

.overlay-section-title {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-2);
  margin-bottom: 8px;
}

.timeline-entry {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
  font-size: 11px;
}

.timeline-state {
  font-size: 9px;
  padding: 2px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  font-weight: 600;
  min-width: 60px;
  text-align: center;
}

.timeline-time { color: var(--text-2); }
.timeline-duration { color: var(--text-2); font-size: 10px; }

.cost-entry-row {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
}

.eval-entry {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
}

/* Loading */
.loading {
  text-align: center;
  padding: 20px;
  color: var(--text-2);
  font-size: 11px;
}

.loading::after {
  content: '...';
  animation: dots 1.5s steps(3, end) infinite;
}

@keyframes dots {
  0% { content: ''; }
  33% { content: '.'; }
  66% { content: '..'; }
  100% { content: '...'; }
}

/* Focus */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
</head>
<body>

<!-- Header / Stats Bar -->
<div class="header">
  <div class="header-left">
    <div class="logo">RUNCOR <span>dashboard</span></div>
    <div class="connection-status" id="conn-status">
      <div class="connection-dot" id="conn-dot"></div>
      <span id="conn-text">Connected</span>
    </div>
  </div>
  <div class="stats-bar" id="stats-bar">
    <div class="stat"><span class="stat-label">Status</span><span class="stat-value" id="stat-status">—</span></div>
    <div class="stat"><span class="stat-label">Uptime</span><span class="stat-value" id="stat-uptime">—</span></div>
    <div class="stat"><span class="stat-label">Active</span><span class="stat-value" id="stat-active">0</span></div>
    <div class="stat"><span class="stat-label">Queue</span><span class="stat-value" id="stat-queue">0</span></div>
    <div class="stat"><span class="stat-label">Done</span><span class="stat-value green" id="stat-done">0</span></div>
    <div class="stat"><span class="stat-label">Failed</span><span class="stat-value red" id="stat-failed">0</span></div>
    <div class="stat"><span class="stat-label">Success</span><span class="stat-value" id="stat-success">—</span></div>
    <div class="stat"><span class="stat-label">Users</span><span class="stat-value" id="stat-users">0</span></div>
    <div class="stat" id="stat-cost-wrap"><span class="stat-label">Cost</span><span class="stat-value" id="stat-cost">$0.00</span></div>
  </div>
</div>

<!-- 3-Column Layout -->
<div class="layout">

  <!-- Left: Connections -->
  <div class="panel-left">
    <div class="panel-title">Connections</div>
    <div id="adapter-list"><div class="loading" id="adapter-loading">Loading</div></div>
  </div>

  <!-- Center: Execution Feed -->
  <div class="panel-center">
    <div id="exec-feed"><div class="loading" id="feed-loading">Loading</div></div>
    <div class="empty-state" id="feed-empty" style="display:none;">No executions yet</div>
  </div>

  <!-- Right: Tabbed Sidebar -->
  <div class="panel-right">
    <div class="tab-bar" id="tab-bar">
      <button class="tab-btn active" data-tab="providers" tabindex="0">Providers</button>
      <button class="tab-btn" data-tab="cost" id="tab-btn-cost" tabindex="0">Cost</button>
      <button class="tab-btn" data-tab="discernment" id="tab-btn-disc" tabindex="0">Discernment</button>
    </div>
    <div class="tab-content active" id="tab-providers"><div class="loading">Loading</div></div>
    <div class="tab-content" id="tab-cost"><div class="loading">Loading</div></div>
    <div class="tab-content" id="tab-discernment"><div class="loading">Loading</div></div>
  </div>

</div>

<!-- Detail Overlay -->
<div class="overlay-backdrop" id="overlay-backdrop">
  <div class="overlay" id="overlay" role="dialog" aria-modal="true">
    <button class="overlay-close" id="overlay-close" tabindex="0">&times;</button>
    <div class="overlay-title" id="overlay-title"></div>
    <div id="overlay-body"></div>
  </div>
</div>

<script>
(function() {
  'use strict';

  // ── Config ──────────────────────────────────────────
  // Derive API base: /v1/dashboard → /v1, / → /v1 (default)
  const rawBase = window.location.pathname.replace(/\\/dashboard$/, '').replace(/\\/$/, '');
  const API_BASE = rawBase || '/v1';
  const MAX_CARDS = 200;
  const POLL_INTERVAL = 2000;

  // ── State ───────────────────────────────────────────
  let capabilities = {};
  const executions = new Map(); // id → execution
  const providerCache = new Map(); // executionId → provider (buffer for race condition)
  let overlayExecId = null;
  let sseRetryDelay = 1000;
  let eventSource = null;
  var serverUptimeBase = { fetchedAt: Date.now(), value: 0 };

  // ── Utilities ───────────────────────────────────────
  function esc(s) { if (!s) return ''; var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
  function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '…' : s; }

  function formatMs(ms) {
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    if (ms < 3600000) return (ms / 60000).toFixed(1) + 'm';
    return (ms / 3600000).toFixed(1) + 'h';
  }

  function formatCost(c) { return '$' + (c || 0).toFixed(4); }

  function formatUptime(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600); s %= 3600;
    var m = Math.floor(s / 60); s %= 60;
    return (h > 0 ? h + 'h ' : '') + String(m).padStart(2, '0') + 'm ' + String(s).padStart(2, '0') + 's';
  }

  function stateClass(state) {
    return 'exec-state ' + (state || 'queued');
  }

  function adapterStateClass(state) {
    if (state === 'connected') return 'adapter-state connected';
    if (state === 'error' || state === 'disconnected') return 'adapter-state disconnected';
    if (state === 'connecting') return 'adapter-state reconnecting';
    return 'adapter-state pending';
  }

  function healthDotClass(state) {
    return 'health-dot ' + (state || 'healthy');
  }

  // ── API Fetch ───────────────────────────────────────
  async function api(path) {
    const resp = await fetch(API_BASE + path);
    if (!resp.ok) return null;
    return resp.json();
  }

  // ── Stats Bar ───────────────────────────────────────
  async function refreshStats() {
    const data = await api('/health');
    if (!data) return;
    capabilities = data.capabilities || {};

    document.getElementById('stat-status').textContent = data.status;
    if (data.uptime) serverUptimeBase = { fetchedAt: Date.now(), value: data.uptime };
    document.getElementById('stat-uptime').textContent = formatUptime(data.uptime);

    // Hide tabs based on capabilities
    document.getElementById('tab-btn-cost').style.display = capabilities.cost ? '' : 'none';
    document.getElementById('tab-btn-disc').style.display = capabilities.discernment ? '' : 'none';
    document.getElementById('stat-cost-wrap').style.display = capabilities.cost ? '' : 'none';

    // Compute execution stats
    let active = 0, queued = 0, done = 0, failed = 0;
    var userSet = new Set();
    for (const ex of executions.values()) {
      if (ex.state === 'running' || ex.state === 'retrying') active++;
      else if (ex.state === 'queued') queued++;
      else if (ex.state === 'complete') done++;
      else if (ex.state === 'failed') failed++;
      if (ex.userId) userSet.add(ex.userId);
    }
    document.getElementById('stat-active').textContent = active;
    document.getElementById('stat-queue').textContent = queued;
    document.getElementById('stat-done').textContent = done;
    document.getElementById('stat-failed').textContent = failed;
    document.getElementById('stat-users').textContent = userSet.size;
    const total = done + failed;
    document.getElementById('stat-success').textContent = total > 0 ? (done / total * 100).toFixed(0) + '%' : '—';
  }

  // ── Execution Feed ──────────────────────────────────
  function renderExecCard(ex) {
    const card = document.createElement('div');
    card.className = 'exec-card';
    card.dataset.id = ex.id;
    card.tabIndex = 0;
    card.title = ex.id;
    card.setAttribute('role', 'button');

    const ts = ex.timestamps;
    const startTime = ts.started || ts.queued;
    const endTime = ts.completed;
    const dur = startTime && endTime ? formatMs(new Date(endTime) - new Date(startTime)) : '—';

    card.innerHTML =
      '<div class="exec-card-header">' +
        '<span class="exec-flow-name" title="' + esc(ex.flowName) + '">' + esc(truncate(ex.flowName, 40)) + '</span>' +
        '<span class="' + stateClass(ex.state) + '">' + esc(ex.state) + '</span>' +
      '</div>' +
      '<div class="exec-meta">' +
        '<span>' + esc(truncate(ex.id, 12)) + '</span>' +
        '<span class="exec-user" title="User: ' + esc(ex.userId || 'system') + '">&#x25CF; ' + esc(truncate(ex.userId || 'system', 12)) + '</span>' +
        (ex._provider ? '<span class="exec-provider ' + esc(ex._provider) + '" title="Provider: ' + esc(ex._provider) + '">' + esc(ex._provider) + '</span>' : '') +
        '<span>' + (startTime ? new Date(startTime).toLocaleTimeString() : '—') + '</span>' +
        '<span>' + dur + '</span>' +
      '</div>' +
      (ex.state === 'failed' && ex.error ?
        '<div class="exec-error" title="' + esc(ex.error.message || ex.error || '') + '">' +
          (ex.error.code ? esc(ex.error.code) + ': ' : '') + esc(truncate(String(ex.error.message || ex.error), 120)) +
        '</div>' : '');

    card.addEventListener('click', () => openDetail(ex.id));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDetail(ex.id); });
    return card;
  }

  function refreshFeed() {
    const feed = document.getElementById('exec-feed');
    const empty = document.getElementById('feed-empty');
    const loading = document.getElementById('feed-loading');
    if (loading) loading.remove();

    if (executions.size === 0) {
      feed.innerHTML = '';
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';

    // Sort newest first
    const sorted = Array.from(executions.values()).sort((a, b) => {
      const ta = a.timestamps.queued || '';
      const tb = b.timestamps.queued || '';
      return tb.localeCompare(ta);
    });

    feed.innerHTML = '';
    for (const ex of sorted.slice(0, MAX_CARDS)) {
      feed.appendChild(renderExecCard(ex));
    }
  }

  async function loadInitialExecutions() {
    const data = await api('/executions?limit=200');
    if (data && data.executions) {
      for (const ex of data.executions) {
        executions.set(ex.id, ex);
      }
      refreshFeed();
      // Backfill provider info from cost data + providerCache
      var costData = await api('/cost/summary');
      if (costData && costData.execProviders) {
        for (var eid in costData.execProviders) {
          providerCache.set(eid, costData.execProviders[eid]);
          var ex2 = executions.get(eid);
          if (ex2 && !ex2._provider) ex2._provider = costData.execProviders[eid];
        }
      }
      // Apply any SSE-buffered providers
      for (var entry of providerCache) {
        var ex3 = executions.get(entry[0]);
        if (ex3 && !ex3._provider) ex3._provider = entry[1];
      }
      refreshFeed();
    } else {
      const loading = document.getElementById('feed-loading');
      if (loading) loading.remove();
      document.getElementById('feed-empty').style.display = '';
    }
  }

  // ── Adapter Panel ───────────────────────────────────
  async function refreshAdapters() {
    const data = await api('/adapters');
    const container = document.getElementById('adapter-list');
    const loading = document.getElementById('adapter-loading');
    if (loading) loading.remove();

    if (!data || !data.adapters || data.adapters.length === 0) {
      container.innerHTML = '<div class="empty-state">No adapters configured</div>';
      return;
    }

    container.innerHTML = '';
    for (const a of data.adapters) {
      const card = document.createElement('div');
      card.className = 'adapter-card';
      card.dataset.name = a.name;
      card.innerHTML =
        '<div class="adapter-header">' +
          '<span class="adapter-name" title="' + esc(a.name) + '">' + esc(truncate(a.name, 20)) + '</span>' +
          '<span class="' + adapterStateClass(a.state) + '">' + esc(a.state) + '</span>' +
        '</div>' +
        '<div class="adapter-meta">' +
          (typeof a.tools === 'number' ? a.tools + ' tools' : (a.tools ? a.tools.length + ' tools' : '0 tools')) +
          (a.lastHealthCheck ? ' · ' + new Date(a.lastHealthCheck).toLocaleTimeString() : '') +
        '</div>';
      container.appendChild(card);
    }
  }

  // ── Provider Tab ────────────────────────────────────
  async function refreshProviders() {
    const data = await api('/providers');
    const container = document.getElementById('tab-providers');

    if (!data || !data.providers || data.providers.length === 0) {
      container.innerHTML = '<div class="empty-state">No providers configured</div>';
      return;
    }

    container.innerHTML = '';
    for (const p of data.providers) {
      const card = document.createElement('div');
      card.className = 'provider-card';
      card.innerHTML =
        '<div class="provider-header">' +
          '<span class="provider-name">' + esc(p.name) + '</span>' +
          '<div class="' + healthDotClass(p.healthState) + '" title="' + esc(p.healthState) + '"></div>' +
        '</div>' +
        '<div class="provider-meta">' +
          '<span>Priority: ' + p.priority + '</span>' +
          '<span>' + esc(p.healthState) + '</span>' +
        '</div>';
      container.appendChild(card);
    }
  }

  // ── Cost Tab ────────────────────────────────────────
  async function refreshCost() {
    if (!capabilities.cost) return;
    const data = await api('/cost/summary');
    const container = document.getElementById('tab-cost');
    if (!data) return;

    // Update top stats bar cost total
    var costEl = document.getElementById('stat-cost');
    if (costEl) costEl.textContent = formatCost(data.total);

    let html = '<div class="cost-total">' + formatCost(data.total) + '</div>';
    html += '<div style="font-size:10px;color:var(--text-2);">' + data.entryCount + ' entries</div>';

    function renderBreakdown(title, items) {
      if (!items || items.length === 0) return '';
      let s = '<div class="cost-section-title">' + esc(title) + '</div>';
      for (const item of items.slice(0, 10)) {
        s += '<div class="cost-row"><span class="cost-row-name" title="' + esc(item.name) + '">' + esc(truncate(item.name, 25)) + '</span><span class="cost-row-value">' + formatCost(item.cost) + '</span></div>';
      }
      return s;
    }

    html += renderBreakdown('By Flow', data.byFlow);
    html += renderBreakdown('By User', data.byUser);
    html += renderBreakdown('By Provider', data.byProvider);

    container.innerHTML = html;
  }

  // ── Discernment Tab ─────────────────────────────────
  async function refreshDiscernment() {
    if (!capabilities.discernment) return;
    const data = await api('/discernment');
    const container = document.getElementById('tab-discernment');
    if (!data || !data.enabled) {
      container.innerHTML = '<div class="empty-state">Discernment not enabled</div>';
      return;
    }

    let html = '';

    // Objectives
    if (data.objectives && data.objectives.length > 0) {
      html += '<div class="cost-section-title">Objectives</div>';
      for (const obj of data.objectives) {
        html += '<div class="objective-item"><div class="objective-name">' + esc(obj.name) + '</div><div class="objective-desc">' + esc(obj.description || '') + '</div></div>';
      }
    }

    // Latest report
    if (data.latestReport) {
      const r = data.latestReport;
      html += '<div class="cost-section-title">Latest Cycle</div>';
      html += '<div style="font-size:11px;margin-bottom:8px;">' +
        new Date(r.timestamp).toLocaleString() + ' · ' + r.autonomy + ' · ' +
        r.signalCount + ' signals · ' + r.recommendationCount + ' recs</div>';
    }

    // Recommendations
    if (data.recommendations && data.recommendations.length > 0) {
      html += '<div class="cost-section-title">Recommendations</div>';
      for (const rec of data.recommendations) {
        html += '<div class="rec-card">' +
          '<div class="rec-header">' +
            '<span class="rec-action ' + esc(rec.action) + '">' + esc(rec.action) + '</span>' +
            '<span class="rec-target">' + esc(truncate(rec.target, 30)) + '</span>' +
          '</div>' +
          '<div class="rec-explanation" title="' + esc(rec.explanation || '') + '">' + esc(truncate(rec.explanation || '', 200)) + '</div>' +
          '<div class="rec-confidence">Confidence: ' + ((rec.confidence || 0) * 100).toFixed(0) + '%</div>' +
        '</div>';
      }
    }

    container.innerHTML = html || '<div class="empty-state">No discernment data yet</div>';
  }

  // ── Detail Overlay ──────────────────────────────────
  async function openDetail(execId) {
    overlayExecId = execId;
    const data = await api('/executions/' + execId + '/detail');
    if (!data || !data.execution) return;

    const ex = data.execution;
    document.getElementById('overlay-title').textContent = ex.flowName + ' — ' + ex.id;

    let html = '';

    // User & basic info
    if (ex.userId) {
      html += '<div style="font-size:12px;color:var(--accent);margin-bottom:8px;font-weight:500;">User: ' + esc(ex.userId) + '</div>';
    }

    // State timeline
    html += '<div class="overlay-section"><div class="overlay-section-title">State Timeline</div>';
    const states = [];
    if (ex.timestamps.queued) states.push({ state: 'queued', time: ex.timestamps.queued });
    if (ex.timestamps.started) states.push({ state: 'running', time: ex.timestamps.started });
    if (ex.timestamps.completed) states.push({ state: ex.state, time: ex.timestamps.completed });

    for (let i = 0; i < states.length; i++) {
      const dur = i > 0 ? formatMs(new Date(states[i].time) - new Date(states[i-1].time)) : '';
      html += '<div class="timeline-entry">' +
        '<span class="timeline-state ' + stateClass(states[i].state).replace('exec-state ', '') + '">' + states[i].state + '</span>' +
        '<span class="timeline-time">' + new Date(states[i].time).toLocaleTimeString() + '</span>' +
        (dur ? '<span class="timeline-duration">+' + dur + '</span>' : '') +
      '</div>';
    }
    html += '</div>';

    // Cost entries
    if (data.costEntries && data.costEntries.length > 0) {
      html += '<div class="overlay-section"><div class="overlay-section-title">Cost</div>';
      for (const ce of data.costEntries) {
        html += '<div class="cost-entry-row">' +
          '<span>' + esc(ce.provider) + ' / ' + esc(ce.model) + '</span>' +
          '<span>' + ce.promptTokens + '+' + ce.completionTokens + ' tok · ' + formatCost(ce.cost) + '</span>' +
        '</div>';
      }
      html += '</div>';
    }

    // Evaluation
    if (data.evaluation) {
      const ev = data.evaluation;
      html += '<div class="overlay-section"><div class="overlay-section-title">Evaluation</div>';
      html += '<div style="font-size:11px;margin-bottom:6px;">Overall: ' + (ev.overallScore * 100).toFixed(0) + '% · ' + ev.confidence + '</div>';
      if (ev.evaluatorResults) {
        for (const er of ev.evaluatorResults) {
          const scores = Object.entries(er.scores || {}).map(function(kv) { return kv[0] + ': ' + (kv[1] * 100).toFixed(0) + '%'; }).join(', ');
          html += '<div class="eval-entry"><span>' + esc(er.evaluatorName) + '</span><span>' + esc(scores) + '</span></div>';
        }
      }
      html += '</div>';
    }

    document.getElementById('overlay-body').innerHTML = html;
    document.getElementById('overlay-backdrop').classList.add('open');
    document.getElementById('overlay-close').focus();
  }

  function closeOverlay() {
    overlayExecId = null;
    document.getElementById('overlay-backdrop').classList.remove('open');
  }

  document.getElementById('overlay-close').addEventListener('click', closeOverlay);
  document.getElementById('overlay-backdrop').addEventListener('click', function(e) {
    if (e.target === this) closeOverlay();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && overlayExecId) closeOverlay();
  });

  // ── Tabs ────────────────────────────────────────────
  document.getElementById('tab-bar').addEventListener('click', function(e) {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
    document.querySelectorAll('.tab-content').forEach(function(t) { t.classList.remove('active'); });
    btn.classList.add('active');
    document.getElementById('tab-' + tab).classList.add('active');
  });

  // ── SSE ─────────────────────────────────────────────
  function connectSSE() {
    if (eventSource) { eventSource.close(); eventSource = null; }

    const dot = document.getElementById('conn-dot');
    const text = document.getElementById('conn-text');

    eventSource = new EventSource(API_BASE + '/events');

    eventSource.onopen = function() {
      sseRetryDelay = 1000;
      dot.className = 'connection-dot';
      text.textContent = 'Connected';
    };

    eventSource.onmessage = function(e) {
      try {
        const event = JSON.parse(e.data);
        handleSSEEvent(event);
      } catch {}
    };

    eventSource.onerror = function() {
      dot.className = 'connection-dot reconnecting';
      text.textContent = 'Reconnecting';
      eventSource.close();
      eventSource = null;
      setTimeout(connectSSE, sseRetryDelay);
      sseRetryDelay = Math.min(sseRetryDelay * 2, 30000);
    };
  }

  function handleSSEEvent(event) {
    const type = event.type;
    const d = event.data || event.detail || event;

    if (type === 'execution:state_change' || type === 'execution:complete') {
      const id = d.executionId;
      if (id) {
        const existing = executions.get(id);
        if (existing) {
          if (d.to) existing.state = d.to;
          if (d.state) existing.state = d.state;
          if (d.result !== undefined) existing.result = d.result;
          if (d.error !== undefined) existing.error = d.error;
          existing.timestamps = existing.timestamps || {};
          if (d.to === 'complete' || d.to === 'failed') {
            existing.timestamps.completed = new Date().toISOString();
          }
        } else {
          // New execution — fetch it
          api('/executions/' + id).then(function(resp) {
            if (resp && resp.execution) {
              var newEx = resp.execution;
              // Apply cached provider if we got cost:request before the fetch completed
              if (!newEx._provider && providerCache.has(id)) {
                newEx._provider = providerCache.get(id);
              }
              executions.set(id, newEx);
              // Evict oldest if over cap
              if (executions.size > MAX_CARDS) {
                const oldest = Array.from(executions.values()).sort(function(a, b) {
                  return (a.timestamps.queued || '').localeCompare(b.timestamps.queued || '');
                })[0];
                if (oldest) executions.delete(oldest.id);
              }
              refreshFeed();
            }
          });
          return;
        }
        refreshFeed();

        // Update overlay if open for this execution
        if (overlayExecId === id) {
          openDetail(id);
        }
      }
    }

    if (type === 'provider:health_change') {
      refreshProviders();
    }

    if (type === 'adapter:connected' || type === 'adapter:disconnected' || type === 'adapter:error') {
      refreshAdapters();
    }

    if (type === 'cost:request') {
      // Update cost total in stats bar
      const costEl = document.getElementById('stat-cost');
      if (costEl && d.cost) {
        const current = parseFloat(costEl.textContent.replace('$', '')) || 0;
        costEl.textContent = formatCost(current + d.cost);
      }
      // Tag execution with provider so the card shows it
      if (d.executionId && d.provider) {
        providerCache.set(d.executionId, d.provider);
        var ex = executions.get(d.executionId);
        if (ex && !ex._provider) {
          ex._provider = d.provider;
          refreshFeed();
        }
      }
    }
  }

  // ── Visibility Change ───────────────────────────────
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
      refreshStats();
      loadInitialExecutions();
      refreshAdapters();
      refreshProviders();
      if (capabilities.cost) refreshCost();
      if (capabilities.discernment) refreshDiscernment();
    }
  });

  // ── Polling ─────────────────────────────────────────
  setInterval(function() {
    refreshStats();
    refreshProviders();
    if (capabilities.cost) refreshCost();
    if (capabilities.discernment) refreshDiscernment();
  }, POLL_INTERVAL);

  // ── Uptime ticker (1s) ──────────────────────────────
  setInterval(function() {
    var el = document.getElementById('stat-uptime');
    if (el && serverUptimeBase.value) {
      var now = serverUptimeBase.value + (Date.now() - serverUptimeBase.fetchedAt);
      el.textContent = formatUptime(now);
    }
  }, 1000);

  // ── Init ────────────────────────────────────────────
  refreshStats();
  loadInitialExecutions();
  refreshAdapters();
  refreshProviders();
  connectSSE();

  // Delayed tab data load
  setTimeout(function() {
    if (capabilities.cost) refreshCost();
    if (capabilities.discernment) refreshDiscernment();
  }, 500);

})();
</script>
</body>
</html>`;
