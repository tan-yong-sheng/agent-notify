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

export function parseHerdrAgent(a = {}) {
  const rawStatus = (a.agent_status || 'idle').toLowerCase()
  return {
    id: `herdr-${a.pane_id || 'pane'}`,
    source: 'herdr',
    agent: a.agent || 'pi',
    status: normalizeAgentStatus(rawStatus),
    rawStatus,
    cwd: a.cwd || '',
    displayName: a.terminal_title || a.pane_id || 'Herdr Agent',
    branch: '',
    tool: null,
    toolInput: null,
    prompt: null,
    focused: Boolean(a.focused),
    updatedAt: Date.now(),
  }
}

export function parseOrcaAgent(wt = {}, a = {}) {
  const rawStatus = (a.state || 'idle').toLowerCase()
  const branch = wt.branch ? wt.branch.replace(/^refs\/heads\//, '') : ''
  const displayName = wt.displayName || wt.repo || 'Orca Worktree'

  return {
    id: `orca-${a.paneKey || 'pane'}`,
    source: 'orca',
    agent: a.agentType || 'pi',
    status: normalizeAgentStatus(rawStatus),
    rawStatus,
    cwd: wt.path || '',
    displayName,
    branch,
    tool: a.toolName ?? null,
    toolInput: a.toolInput ?? null,
    prompt: a.prompt ? a.prompt.trim() : null,
    stateStartedAt: a.stateStartedAt ?? null,
    updatedAt: a.updatedAt ?? Date.now(),
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
