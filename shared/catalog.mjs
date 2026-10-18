// ─── Agent Catalog: Multi-Runtime Discovery Seam ──────────────────────────
// Deep query interface encapsulating CLI queries (`herdr agent list`,
// `orca worktree ps --json`), JSON schema normalization, and TTL caching.

import { execFile } from 'node:child_process'
import { getExtendedPathEnv } from './env.mjs'

const execEnv = getExtendedPathEnv()

function execCommand(cmd, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: timeoutMs, env: execEnv }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message, data: null })
      try {
        resolve({ ok: true, data: JSON.parse(stdout) })
      } catch {
        resolve({ ok: false, error: 'JSON parse error', data: null })
      }
    })
  })
}

export function normalizeAgentStatus(rawStatus) {
  const s = String(rawStatus || 'idle').toLowerCase()
  if (s === 'working') return 'working'
  if (s === 'blocked') return 'blocked'
  return s === 'done' ? 'done' : 'idle'
}

// Subprocess JSON is untrusted: a wrong-typed field must not throw and take the
// whole catalog down (which would 500 the dashboard). Only real strings are
// rendered; anything else falls back to a default instead of printing garbage.
function asText(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

// Ids stay distinct even if a runtime emits numeric ones.
function asId(value, fallback) {
  if (typeof value === 'string' && value) return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

export function parseHerdrAgent(a = {}) {
  const record = a && typeof a === 'object' ? a : {}
  const rawStatus = asText(record.agent_status, 'idle').toLowerCase()
  return {
    id: `herdr-${asId(record.pane_id, 'pane')}`,
    source: 'herdr',
    agent: asText(record.agent) || 'pi',
    status: normalizeAgentStatus(rawStatus),
    rawStatus,
    cwd: asText(record.cwd),
    displayName: asText(record.terminal_title) || asId(record.pane_id, 'Herdr Agent'),
    branch: '',
    tool: null,
    toolInput: null,
    prompt: null,
    focused: Boolean(record.focused),
    updatedAt: Date.now(),
  }
}

export function parseOrcaAgent(wt = {}, a = {}) {
  const worktree = wt && typeof wt === 'object' ? wt : {}
  const agent = a && typeof a === 'object' ? a : {}
  const rawStatus = asText(agent.state, 'idle').toLowerCase()
  const branch = asText(worktree.branch).replace(/^refs\/heads\//, '')
  const displayName = asText(worktree.displayName) || asText(worktree.repo) || 'Orca Worktree'

  return {
    id: `orca-${asId(agent.paneKey, 'pane')}`,
    source: 'orca',
    agent: asText(agent.agentType) || 'pi',
    status: normalizeAgentStatus(rawStatus),
    rawStatus,
    cwd: asText(worktree.path),
    displayName,
    branch,
    tool: agent.toolName ?? null,
    toolInput: agent.toolInput ?? null,
    prompt: asText(agent.prompt).trim() || null,
    stateStartedAt: agent.stateStartedAt ?? null,
    updatedAt: agent.updatedAt ?? Date.now(),
  }
}

function extractHerdrAgents(herdrRes) {
  if (!herdrRes.ok || !Array.isArray(herdrRes.data?.result?.agents)) return []
  return herdrRes.data.result.agents.map(parseHerdrAgent)
}

function extractOrcaAgents(orcaRes) {
  if (!orcaRes.ok || !Array.isArray(orcaRes.data?.result?.worktrees)) return []
  const list = []
  for (const wt of orcaRes.data.result.worktrees) {
    if (!wt || typeof wt !== 'object') continue
    if (Array.isArray(wt.agents)) {
      for (const a of wt.agents) {
        list.push(parseOrcaAgent(wt, a))
      }
    }
  }
  return list
}

export async function collectLiveState() {
  const [herdrRes, orcaRes] = await Promise.all([
    execCommand('herdr', ['agent', 'list'], 2500),
    execCommand('orca', ['worktree', 'ps', '--json'], 3500),
  ])

  return {
    agents: [...extractHerdrAgents(herdrRes), ...extractOrcaAgents(orcaRes)],
    sources: {
      herdr: { available: herdrRes.ok, error: herdrRes.error },
      orca: { available: orcaRes.ok, error: orcaRes.error },
    },
    timestamp: Date.now(),
  }
}

// ─── In-memory Cache & Query Seam ────────────────────────────────────────────

let cachedState = null
let lastFetch = 0
const CACHE_TTL_MS = 2000

export async function getLiveAgents({ forceFresh = false } = {}) {
  const now = Date.now()
  if (!forceFresh && cachedState && now - lastFetch < CACHE_TTL_MS) {
    return cachedState
  }
  cachedState = await collectLiveState()
  lastFetch = now
  return cachedState
}
