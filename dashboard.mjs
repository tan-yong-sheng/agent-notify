#!/usr/bin/env node

// ─── Agent Monitor Dashboard ─────────────────────────────────────────────────
// Zero-dependency web dashboard for monitoring coding agents (Pi, Claude, etc.)
// running across Orca worktrees and Herdr sessions.
//
// Usage:
//   node dashboard.mjs [--port 3333]
// Or set DASHBOARD_PORT in .env

import http from 'node:http'
import { URL, fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { loadEnv } from './shared/env.mjs'
import { resolveConfigDir, resolveDashboardPort } from './shared/config.mjs'
import { handleServiceCommand, handleUpdateCommand, checkUpdateStatusAsync, resolveTailscaleBin, resolveTailscaleHostname } from './shared/service.mjs'
import {
  getLiveAgents,
  normalizeAgentStatus,
  parseHerdrAgent,
  parseOrcaAgent,
  collectLiveState,
} from './shared/catalog.mjs'

// ─── Configuration & Port Resolution ─────────────────────────────────────────

function loadDashboardEnv() {
  const pluginRoot = path.dirname(fileURLToPath(import.meta.url))
  const pluginHome = path.dirname(pluginRoot)
  const durableDevDir = path.join(pluginHome, 'dev')
  const configDir = resolveConfigDir([pluginRoot, durableDevDir, pluginHome], pluginRoot)

  try {
    const envPath = path.join(configDir, '.env')
    return fs.existsSync(envPath) ? loadEnv(envPath) : {}
  } catch {
    return {}
  }
}

export function resolveConfig(argv = process.argv, env = process.env, fileEnv = loadDashboardEnv()) {
  return { port: resolveDashboardPort(argv, env, fileEnv) }
}

const config = resolveConfig()
const PORT = config.port

// The update probe re-enters this same script with --update-status-json, in its
// own process, so its blocking git calls stay off this event loop.
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const PROBE_ARGV = [SCRIPT_PATH]
const REPO_DIR = path.dirname(SCRIPT_PATH)

// The files the page needs to be installable. They are served from a fixed
// allowlist rather than by joining the request path onto a directory: the
// request path is attacker-controlled, and a join would let `..` reach any file
// the dashboard can read.
const PUBLIC_DIR = path.join(REPO_DIR, 'public')
const STATIC_FILES = new Map([
  ['/manifest.webmanifest', { file: 'manifest.webmanifest', type: 'application/manifest+json; charset=utf-8' }],
  ['/sw.js', { file: 'sw.js', type: 'text/javascript; charset=utf-8' }],
  ['/icon-192.png', { file: 'icon-192.png', type: 'image/png' }],
  ['/icon-512.png', { file: 'icon-512.png', type: 'image/png' }],
  ['/icon-maskable-512.png', { file: 'icon-maskable-512.png', type: 'image/png' }],
])

export { normalizeAgentStatus, parseHerdrAgent, parseOrcaAgent, collectLiveState }

// The banner label for an update status. Exported and embedded into the page, so
// the browser runs the same code the tests exercise: a status the dashboard could
// not refresh says so, instead of looking like a check that just succeeded.
export function updateBannerLabel(data) {
  const label = data.versionLabel || ((data.localSha || '') + ' → ' + (data.remoteSha || 'new'))
  return data.stale ? label + ' (last known, the update check could not run)' : label
}

// The order the rows are drawn in. Exported and embedded into the page for the
// same reason as the banner label: the browser runs the code the tests exercise.
//
// A known id keeps the position it was first seen at, and an id that is no
// longer in the snapshot is dropped, so a long-lived page does not keep ordering
// rows for agents that are gone. An agent that has never been seen is appended
// in the order the server sent it, so it appears at the bottom instead of moving
// the rows above it.
export function nextAgentOrder(knownIds, incomingIds) {
  const live = new Set(incomingIds)
  const kept = knownIds.filter((id) => live.has(id))
  const placed = new Set(kept)
  for (const id of incomingIds) {
    if (!placed.has(id)) {
      placed.add(id)
      kept.push(id)
    }
  }
  return kept
}

// ─── HTML Page Template (Variant B: Compact Dense Table) ─────────────────────

export function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Monitor</title>
  <link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="#161b22">
  <!-- iOS ignores the manifest's icons and reads this one, and it is the only
       way to launch full screen on an iPhone. -->
  <link rel="apple-touch-icon" href="/icon-192.png">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Agents">
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --card-border: #30363d;
      --text: #e6edf3;
      --text-muted: #8b949e;
      --accent: #58a6ff;
      --green: #3fb950;
      --green-bg: rgba(63, 185, 80, 0.15);
      --red: #f85149;
      --red-bg: rgba(248, 81, 73, 0.15);
      --yellow: #d29922;
      --yellow-bg: rgba(210, 153, 34, 0.15);
      --gray: #8b949e;
      --gray-bg: rgba(139, 148, 158, 0.15);
      --orca: #bf8700;
      --herdr: #a371f7;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 24px;
      line-height: 1.5;
    }

    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }

    .update-banner {
      background: rgba(88, 166, 255, 0.12);
      border: 1px solid var(--accent);
      border-radius: 8px;
      padding: 10px 16px;
      margin-bottom: 20px;
      font-size: 13px;
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .header h1 {
      font-size: 20px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .header-info {
      font-size: 13px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 12px;
    }

    /* Stats Bar */
    .stats-bar {
      display: flex;
      gap: 14px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .stat-pill {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 8px 14px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
    }
    .stat-pill .count {
      font-size: 18px;
      font-weight: 700;
      color: var(--text);
    }

    /* Badges */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      white-space: nowrap;
    }
    .badge-working { background: var(--green-bg); color: var(--green); border: 1px solid rgba(63, 185, 80, 0.4); }
    .badge-blocked { background: var(--red-bg); color: var(--red); border: 1px solid rgba(248, 81, 73, 0.4); }
    .badge-done, .badge-idle { background: var(--gray-bg); color: var(--gray); border: 1px solid rgba(139, 148, 158, 0.4); }
    .pulse-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
      box-shadow: 0 0 6px currentColor;
    }

    .tag-source {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 4px;
      font-weight: 600;
      display: inline-block;
    }
    .tag-orca { background: rgba(191, 135, 0, 0.2); color: #f0b72f; border: 1px solid rgba(191, 135, 0, 0.4); }
    .tag-herdr { background: rgba(163, 113, 247, 0.2); color: #c297ff; border: 1px solid rgba(163, 113, 247, 0.4); }

    .path-chip {
      font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace;
      font-size: 12px;
      color: #79c0ff;
      background: rgba(110, 118, 129, 0.1);
      padding: 2px 6px;
      border-radius: 4px;
      cursor: pointer;
      display: inline-block;
      max-width: 360px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: background 0.1s ease;
    }
    .path-chip:hover {
      background: rgba(110, 118, 129, 0.25);
      text-decoration: underline;
    }

    /* Controls Bar: Search & Filter Tabs */
    .controls-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      gap: 16px;
      flex-wrap: wrap;
    }
    .search-box {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 13px;
      width: 320px;
      outline: none;
    }
    .search-box:focus { border-color: var(--accent); }
    .filter-tabs {
      display: flex;
      gap: 6px;
    }
    .filter-tab {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.1s ease;
    }
    .filter-tab:hover { background: #21262d; color: var(--text); }
    .filter-tab.active {
      background: rgba(88, 166, 255, 0.15);
      border-color: var(--accent);
      color: var(--accent);
    }

    /* Table */
    .table-container {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      text-align: left;
    }
    th {
      background: #191f28;
      padding: 10px 14px;
      font-weight: 600;
      color: var(--text-muted);
      border-bottom: 1px solid var(--card-border);
      white-space: nowrap;
    }
    td {
      padding: 12px 14px;
      border-bottom: 1px solid rgba(48, 54, 61, 0.6);
      vertical-align: middle;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(110, 118, 129, 0.05); }

    .action-text {
      color: #c9d1d9;
      cursor: pointer;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      line-height: 1.4;
    }
    .action-text:hover { color: #fff; }

    /* Modal / Drawer for Full Prompt */
    .modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }
    .modal-box {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 10px;
      width: 90%;
      max-width: 640px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 16px 32px rgba(0,0,0,0.5);
    }
    .modal-header {
      padding: 14px 18px;
      border-bottom: 1px solid #30363d;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 600;
    }
    .modal-body {
      padding: 18px;
      overflow-y: auto;
      font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace;
      font-size: 13px;
      white-space: pre-wrap;
      color: #e6edf3;
      background: #0d1117;
      border-radius: 6px;
      margin: 16px;
    }
    .modal-close {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 20px;
      cursor: pointer;
    }

    /* Toast */
    .toast {
      position: fixed;
      top: 20px;
      right: 20px;
      background: #238636;
      color: white;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: none;
      z-index: 2000;
    }

    /* Narrow screens: the seven columns need about 1020px, so on a phone or a
       tablet held upright the table scrolls sideways with most of it off
       screen. Each row becomes a short card instead, and the column headers
       stop earning their place because every cell is labelled by its content.

       The row is reordered with flex order rather than restructured, so the
       markup stays one shape for every screen and the desktop table is
       unaffected. A card is then two or three tight lines instead of seven
       stacked ones: measured at 375x667 the stacked version was 218px a card
       and showed one card per screen. */
    @media (max-width: 900px) {
      body { padding: 10px; }

      /* Three bars' worth of chrome was 253px of a 667px screen before any
         content. The counts move onto the title line and the rest folds. */
      .header {
        flex-direction: row;
        align-items: baseline;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 2px 8px;
        margin-bottom: 8px;
      }
      .header h1 { font-size: 16px; }
      .header-info { font-size: 11px; gap: 6px; }

      .stats-bar { gap: 10px; margin-bottom: 8px; flex-wrap: nowrap; overflow-x: auto; }
      .stat-pill { padding: 0; border: none; background: none; gap: 5px; font-size: 12px; }
      .stat-pill .count { font-size: 13px; }
      .stat-pill .stat-label { display: none; }

      .controls-bar { flex-direction: row; align-items: center; gap: 8px; margin-bottom: 8px; }
      .search-box { width: auto; flex: 1 1 40%; min-width: 0; padding: 5px 8px; font-size: 12px; }
      .filter-tabs { overflow-x: auto; flex-wrap: nowrap; }
      .filter-tab { padding: 4px 8px; font-size: 12px; white-space: nowrap; }

      .table-container { border: none; background: transparent; overflow-x: visible; }
      table, thead, tbody { display: block; width: 100%; }
      thead { display: none; }

      /* Each row is a card of two or three lines, ordered by content rather
         than by column, and it wraps instead of stacking a cell per line. */
      tbody tr {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 2px 8px;
        background: var(--card-bg);
        border: 1px solid var(--card-border);
        border-radius: 8px;
        padding: 8px 10px;
        margin-bottom: 8px;
      }
      tbody td { border: none; padding: 0; max-width: none; }

      /* line 1: state, agent, and how long ago it moved */
      tbody td:nth-child(1) { order: 1; flex: 0 0 auto; }
      tbody td:nth-child(3) { order: 2; flex: 0 1 auto; font-size: 14px; min-width: 0; }
      tbody td:nth-child(7) { order: 3; flex: 0 0 auto; margin-left: auto; font-size: 11px; }

      /* line 2: where it is and which branch. The path chip is dropped here and
         kept in the modal, because it was the single tallest cell on the card. */
      tbody td:nth-child(4) { order: 4; flex: 1 1 auto; font-size: 12px; min-width: 0; }
      tbody td:nth-child(5) { order: 5; flex: 0 0 auto; font-size: 11px; }
      tbody td:nth-child(4) .path-chip { display: none; }
      tbody td:nth-child(4) > div { margin-bottom: 0; font-weight: 500; }

      /* line 3: what it is doing, truncated to one line */
      tbody td:nth-child(6) { order: 6; flex: 1 1 100%; font-size: 12px; min-width: 0; }
      tbody td:nth-child(6) .action-text {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: none;
        color: var(--text-muted);
      }
      /* The source tag says which runtime found the row, which the agent name
         already implies for a reader who knows these tools; it costs a whole
         line on every card, so it moves to the modal. */
      tbody td:nth-child(2) { display: none; }

      tbody td:empty { display: none; }
    }

    /* The same cards without the third line: ?layout=dense, for comparing a
       two-line row against the three-line one on a real phone. */
    body.layout-dense tbody td:nth-child(6) { display: none; }

    @media (max-width: 600px) {
      body { padding: 8px; }
      .header h1 { font-size: 15px; }
      tbody tr { padding: 7px 9px; }
    }
  </style>
</head>
<body>

  <div id="update-banner" class="update-banner" style="display: none;">
    <div>
      📦 <strong>Update Available:</strong> A newer revision is available (<code id="update-commit"></code>). Run <code>node dashboard.mjs --update</code> to upgrade.
    </div>
    <button onclick="document.getElementById('update-banner').style.display='none'" style="background:transparent; border:none; color:var(--text-muted); cursor:pointer;">✕</button>
  </div>

  <div class="header">
    <h1>
      <span>⚡ Agent Monitor</span>
    </h1>
    <div class="header-info">
      <span id="sources-status">Detecting runtimes...</span>
      <span>•</span>
      <span id="last-updated">Updating...</span>
    </div>
  </div>

  <div class="stats-bar">
    <div class="stat-pill">
      <div class="pulse-dot" style="color: var(--green);"></div>
      <div>
        <div class="count" id="count-working">0</div>
        <div class="stat-label" style="font-size: 11px; color: var(--text-muted);">Working / Running</div>
      </div>
    </div>
    <div class="stat-pill">
      <div class="pulse-dot" style="color: var(--red);"></div>
      <div>
        <div class="count" id="count-blocked">0</div>
        <div class="stat-label" style="font-size: 11px; color: var(--text-muted);">Blocked</div>
      </div>
    </div>
    <div class="stat-pill">
      <div class="pulse-dot" style="color: var(--gray);"></div>
      <div>
        <div class="count" id="count-idle">0</div>
        <div class="stat-label" style="font-size: 11px; color: var(--text-muted);">Settled / Idle</div>
      </div>
    </div>
  </div>

  <div class="controls-bar">
    <input type="text" id="search-box" class="search-box" placeholder="Filter by directory, branch, agent, prompt..." />
    <div class="filter-tabs">
      <button class="filter-tab active" data-filter="all" onclick="setFilter('all')">All (<span id="tab-count-all">0</span>)</button>
      <button class="filter-tab" data-filter="working" onclick="setFilter('working')">Working (<span id="tab-count-working">0</span>)</button>
      <button class="filter-tab" data-filter="blocked" onclick="setFilter('blocked')">Blocked (<span id="tab-count-blocked">0</span>)</button>
      <button class="filter-tab" data-filter="settled" onclick="setFilter('settled')">Settled (<span id="tab-count-settled">0</span>)</button>
    </div>
  </div>

  <div class="table-container">
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>Host</th>
          <th>Agent</th>
          <th>Workspace / Directory</th>
          <th>Branch</th>
          <th>Current Tool & Prompt</th>
          <th>Last Active</th>
        </tr>
      </thead>
      <tbody id="agent-table-body">
        <tr>
          <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 40px;">
            Loading running agents...
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div id="modal-backdrop" class="modal-backdrop" onclick="closeModal(event)">
    <div class="modal-box" onclick="event.stopPropagation()">
      <div class="modal-header">
        <span id="modal-title">Prompt / Tool Details</span>
        <button class="modal-close" onclick="closeModal()">&times;</button>
      </div>
      <div id="modal-content" class="modal-body"></div>
    </div>
  </div>

  <div id="toast" class="toast">Copied to clipboard!</div>

  <script>
    let allAgents = [];
    // agentOrder tracks first-seen insertion order by id so that rows keep
    // their position across polls even when the server returns them in a
    // different order.
    let agentOrder = [];
    // An agent that has gone must not stay in the order, or a long-lived page
    // keeps sorting rows for agents that no longer exist.
    const nextAgentOrder = ${nextAgentOrder.toString()};
    let currentFilter = 'all';
    let searchQuery = '';
    // A two-line row instead of three, for comparing density on a real phone.
    if (new URLSearchParams(location.search).get('layout') === 'dense') {
      document.body.classList.add('layout-dense');
    }

    function copyPath(text) {
      navigator.clipboard.writeText(text);
      const toast = document.getElementById('toast');
      toast.style.opacity = '1';
      setTimeout(() => { toast.style.opacity = '0'; }, 1500);
    }

    function setFilter(filter) {
      currentFilter = filter;
      document.querySelectorAll('.filter-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
      });
      renderRows();
    }

    document.getElementById('search-box').addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      renderRows();
    });

    // Delegated handler: agent data is read from data attributes instead of being
    // interpolated into inline handlers, where HTML escaping is not JS escaping.
    document.getElementById('agent-table-body').addEventListener('click', (e) => {
      const copyTarget = e.target.closest('[data-copy-path]');
      if (copyTarget) {
        copyPath(copyTarget.dataset.copyPath);
        return;
      }
      const modalTarget = e.target.closest('[data-agent-id]');
      if (modalTarget) showModalById(modalTarget.dataset.agentId);
    });

    async function fetchAgents() {
      try {
        const res = await fetch('/api/agents');
        const data = await res.json();
        const incoming = data.agents || [];
        // Keep the order of the agents that are still here, drop the ones that
        // are gone, and put a new agent at the bottom.
        agentOrder = nextAgentOrder(agentOrder, incoming.map((a) => a.id));
        allAgents = incoming;
        updateStats(data);
        renderRows();
      } catch (err) {
        console.error('Fetch error:', err);
      }
    }

    function updateStats(data) {
      const working = allAgents.filter(a => a.status === 'working').length;
      const blocked = allAgents.filter(a => a.status === 'blocked').length;
      const settled = allAgents.filter(a => a.status !== 'working' && a.status !== 'blocked').length;

      document.getElementById('count-working').innerText = working;
      document.getElementById('count-blocked').innerText = blocked;
      document.getElementById('count-idle').innerText = settled;

      document.getElementById('tab-count-all').innerText = allAgents.length;
      document.getElementById('tab-count-working').innerText = working;
      document.getElementById('tab-count-blocked').innerText = blocked;
      document.getElementById('tab-count-settled').innerText = settled;

      const orcaOk = data.sources?.orca?.available;
      const herdrOk = data.sources?.herdr?.available;
      document.getElementById('sources-status').innerHTML =
        '<span class="tag-source tag-orca" style="opacity:' + (orcaOk ? '1' : '0.4') + '">Orca ' + (orcaOk ? '●' : '✕') + '</span> ' +
        '<span class="tag-source tag-herdr" style="opacity:' + (herdrOk ? '1' : '0.4') + '">Herdr ' + (herdrOk ? '●' : '✕') + '</span>';

      document.getElementById('last-updated').innerText = 'Synced ' + new Date().toLocaleTimeString();
    }

    function badgeHTML(status) {
      if (status === 'working') return '<span class="badge badge-working"><span class="pulse-dot"></span> Working</span>';
      if (status === 'blocked') return '<span class="badge badge-blocked"><span class="pulse-dot"></span> Blocked</span>';
      return '<span class="badge badge-done">Done / Idle</span>';
    }

    function sourceTagHTML(source) {
      return source === 'orca'
        ? '<span class="tag-source tag-orca">Orca</span>'
        : '<span class="tag-source tag-herdr">Herdr</span>';
    }

    function renderRows() {
      const tbody = document.getElementById('agent-table-body');
      // Sort by first-seen position before filtering so the visible order is
      // stable across polls regardless of the server's payload order.
      const byId = new Map(allAgents.map(a => [a.id, a]));
      const ordered = agentOrder.map(id => byId.get(id)).filter(Boolean);
      let filtered = ordered;

      if (currentFilter === 'working') {
        filtered = filtered.filter(a => a.status === 'working');
      } else if (currentFilter === 'blocked') {
        filtered = filtered.filter(a => a.status === 'blocked');
      } else if (currentFilter === 'settled') {
        filtered = filtered.filter(a => a.status !== 'working' && a.status !== 'blocked');
      }

      if (searchQuery) {
        filtered = filtered.filter(a => {
          return (a.cwd && a.cwd.toLowerCase().includes(searchQuery)) ||
                 (a.displayName && a.displayName.toLowerCase().includes(searchQuery)) ||
                 (a.branch && a.branch.toLowerCase().includes(searchQuery)) ||
                 (a.agent && a.agent.toLowerCase().includes(searchQuery)) ||
                 (a.prompt && a.prompt.toLowerCase().includes(searchQuery));
        });
      }

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 40px;">No agents match the current filter.</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map((a) => {
        return \`
          <tr>
            <td>\${badgeHTML(a.status)}</td>
            <td>\${sourceTagHTML(a.source)}</td>
            <td><strong>\${escapeHTML(a.agent)}</strong></td>
            <td>
              <div style="font-weight:600; margin-bottom:2px;">\${escapeHTML(a.displayName)}</div>
              <span class="path-chip" data-copy-path="\${escapeHTML(a.cwd)}" title="Click to copy full path">\${escapeHTML(a.cwd)}</span>
            </td>
            <td>\${a.branch ? '<code style="color:var(--accent);">' + escapeHTML(a.branch) + '</code>' : '<span style="color:var(--text-muted)">—</span>'}</td>
            <td style="max-width:340px;">
              <div class="action-text" data-agent-id="\${escapeHTML(a.id)}" title="Click to expand prompt">
                \${a.tool ? '<code style="color:var(--accent); font-size:11px;">[' + escapeHTML(a.tool) + ']</code> ' : ''}
                <span>\${escapeHTML(a.prompt || (a.status === 'working' ? 'Processing...' : 'Idle'))}</span>
              </div>
            </td>
            <td style="color:var(--text-muted); font-size:12px; white-space:nowrap;">\${timeSince(a.updatedAt)}</td>
          </tr>
        \`;
      }).join('');
    }

    function showModalById(id) {
      const a = allAgents.find(x => x.id === id);
      if (!a) return;
      document.getElementById('modal-title').innerText = (a.displayName || a.agent) + ' (' + a.agent + ')';
      let content = '';
      if (a.tool) content += 'TOOL: ' + a.tool + '\\n\\n';
      if (a.toolInput) content += 'TOOL INPUT:\\n' + (typeof a.toolInput === 'object' ? JSON.stringify(a.toolInput, null, 2) : a.toolInput) + '\\n\\n';
      if (a.prompt) content += 'PROMPT:\\n' + a.prompt;
      if (!content) content = 'No active tool or prompt text captured.';
      document.getElementById('modal-content').innerText = content;
      document.getElementById('modal-backdrop').style.display = 'flex';
    }

    function closeModal() {
      document.getElementById('modal-backdrop').style.display = 'none';
    }

    function escapeHTML(str) {
      if (!str) return '';
      return String(str).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[m]);
    }

    function timeSince(date) {
      if (!date) return '—';
      const seconds = Math.floor((new Date() - date) / 1000);
      if (seconds < 5) return 'just now';
      if (seconds < 60) return seconds + 's ago';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm ago';
      const hours = Math.floor(minutes / 60);
      return hours + 'h ago';
    }

    // Polling
    fetchAgents();
    setInterval(fetchAgents, 3000);

    const updateBannerLabel = ${updateBannerLabel.toString()};

    // Update check (on load and every 10 minutes)
    async function checkUpdate() {
      try {
        const res = await fetch('/api/update');
        const data = await res.json();
        if (data.hasUpdate) {
          document.getElementById('update-commit').innerText = updateBannerLabel(data);
          document.getElementById('update-banner').style.display = 'flex';
        }
      } catch {}
    }
    checkUpdate();
    setInterval(checkUpdate, 600000);

    // A browser over plain http on a non-loopback address refuses to register a
    // worker, and that rejection is not an error the operator can act on: the
    // page works either way, it just cannot be installed. Tailscale serves over
    // https, which is the case this is for.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  </script>
</body>
</html>`
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

// Reject non-loopback Host headers so a DNS-rebinding page cannot read agent
// state (prompts, tool input, workspace paths) through the loopback listener.
const ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]']

// `tailscale serve` proxies to this listener and forwards the hostname it was
// reached under, so a tailnet request arrives with a Host the loopback rule
// rejects. Only this node's own name is admitted, not the whole `*.ts.net`
// space: another tailnet's dashboard is not this dashboard, and admitting the
// suffix would let any name in it through the guard. Any other name has to be
// named explicitly in AGENT_NOTIFY_ALLOWED_HOSTS.
export function isAllowedHost(
  hostHeader,
  extraHosts = (process.env.AGENT_NOTIFY_ALLOWED_HOSTS || ''),
  tailnetHost = ''
) {
  if (!hostHeader) return false
  const host = String(hostHeader).toLowerCase().replace(/:\d+$/, '')
  if (ALLOWED_HOSTS.includes(host)) return true
  const own = String(tailnetHost).toLowerCase().replace(/\.+$/, '')
  if (own && host === own) return true
  return String(extraHosts)
    .toLowerCase()
    .split(',')
    .map((h) => h.trim().replace(/:\d+$/, ''))
    .filter(Boolean)
    .includes(host)
}

// The tailnet name this dashboard answers under, or an empty string when it is
// not reached that way. Resolved on the first request and then kept: a request
// must not wait on a CLI it has already asked, but importing this module must
// not run one either. Every test, script and tool that imports `dashboard.mjs`
// would otherwise pay for a subprocess it never uses, and a `tailscale` that
// hangs would hang the import.
let tailnetHost = null
function tailnetHostName() {
  if (tailnetHost === null) {
    const bin = resolveTailscaleBin()
    tailnetHost = bin ? (resolveTailscaleHostname(bin) || '') : ''
  }
  return tailnetHost
}

const server = http.createServer(async (req, res) => {
  if (!isAllowedHost(req.headers.host, process.env.AGENT_NOTIFY_ALLOWED_HOSTS || '', tailnetHostName())) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    return res.end('Forbidden host')
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  if (reqUrl.pathname === '/api/agents') {
    const state = await getLiveAgents()
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    })
    return res.end(JSON.stringify(state))
  }

  if (reqUrl.pathname === '/api/update') {
    const updateInfo = await checkUpdateStatusAsync(REPO_DIR, PROBE_ARGV)
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    })
    return res.end(JSON.stringify(updateInfo))
  }

  const staticFile = STATIC_FILES.get(reqUrl.pathname)
  if (staticFile) {
    // A missing file is a deployment problem, not a 404 the operator can act
    // on, so say which file and why the browser will refuse the install.
    let body
    try {
      body = fs.readFileSync(path.join(PUBLIC_DIR, staticFile.file))
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      return res.end(`the dashboard is missing ${staticFile.file}, so it cannot be installed as an app`)
    }
    res.writeHead(200, { 'Content-Type': staticFile.type, 'Cache-Control': 'no-cache' })
    return res.end(body)
  }

  if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') {
    const html = renderDashboardHtml()
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(html)
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not Found')
})

// Server failures (a port already bound, a privileged port) arrive as an 'error'
// event; without a handler they surface as an unhandled exception, so a second
// dashboard on the same port would print a raw stack trace.
export function formatListenError(err, port) {
  if (err?.code === 'EADDRINUSE') {
    return `Port ${port} is already in use - another dashboard is probably running.\n   Stop the other instance, or start this one elsewhere: node dashboard.mjs --port <number>`
  }
  if (err?.code === 'EACCES') {
    return `Not allowed to bind port ${port}.\n   Pick a port above 1023: node dashboard.mjs --port <number>`
  }
  return `Could not start the dashboard on port ${port}: ${err?.message || err}`
}

server.on('error', (err) => {
  console.error(`\n❌ ${formatListenError(err, PORT)}\n`)
  process.exit(1)
})

export async function handleCliCommands(argv = process.argv) {
  if (await handleServiceCommand(argv, { port: PORT })) return true
  if (handleUpdateCommand(argv)) return true
  return false
}

// A symlinked (or npm/npx-shimmed) dashboard.mjs resolves argv[1] to the link,
// not to the real file, so comparing raw strings would find no match and exit 0
// without starting anything. Compare realpaths, and treat a path that cannot be
// resolved as "not this file".
export function isDirectInvocation(argv = process.argv, moduleUrl = import.meta.url) {
  const invoked = argv[1]
  if (!invoked) return false
  try {
    return fs.realpathSync(invoked) === fs.realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

if (isDirectInvocation(process.argv)) {
  handleCliCommands(process.argv).then((handled) => {
    if (!handled) {
      server.listen(PORT, '127.0.0.1', () => {
        console.log(`\n⚡ Agent Monitor Dashboard running at: http://localhost:${PORT}`)
        console.log(`   Monitoring Orca worktrees and Herdr sessions.`)
        console.log(`   Press Ctrl+C to stop.\n`)
        // Warms the 1h cache off the request path; the probe runs in a child
        // process, so the first /api/update does not block agent polling.
        checkUpdateStatusAsync(REPO_DIR, PROBE_ARGV).catch(() => {})
      })
    }
  })
}
