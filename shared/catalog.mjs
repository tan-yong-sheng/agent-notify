// ─── Agent Catalog: Multi-Runtime Discovery Seam ──────────────────────────
// Deep query interface encapsulating CLI queries (`herdr agent list`,
// `orca worktree ps --json`), JSON schema normalization, and TTL caching.

import { execFile } from 'node:child_process'
import { getExtendedPathEnv } from './env.mjs'
import { detectGitBranchAsync } from './git.mjs'

const execEnv = getExtendedPathEnv()
// `orca worktree ps --json` grows with the number of worktrees, and the 1 MiB
// default would turn a busy machine into a truncation and a JSON parse error.
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024

function execCommand(cmd, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_COMMAND_OUTPUT_BYTES, env: execEnv },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: err.message, data: null })
        try {
          resolve({ ok: true, data: JSON.parse(stdout) })
        } catch {
          resolve({ ok: false, error: 'JSON parse error', data: null })
        }
      }
    )
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

// `index` comes from the extractor and is only used when the runtime omits the
// id: one shared fallback would key every such row alike, and the dashboard
// resolves a row by id.
export function parseHerdrAgent(a = {}, index = 0) {
  const record = a && typeof a === 'object' ? a : {}
  const rawStatus = asText(record.agent_status, 'idle').toLowerCase()
  return {
    id: `herdr-${asId(record.pane_id, `pane-${index}`)}`,
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

export function parseOrcaAgent(wt = {}, a = {}, index = 0) {
  const worktree = wt && typeof wt === 'object' ? wt : {}
  const agent = a && typeof a === 'object' ? a : {}
  const rawStatus = asText(agent.state, 'idle').toLowerCase()
  const branch = asText(worktree.branch).replace(/^refs\/heads\//, '')
  const displayName = asText(worktree.displayName) || asText(worktree.repo) || 'Orca Worktree'

  return {
    id: `orca-${asId(agent.paneKey, `pane-${index}`)}`,
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
  return herdrRes.data.result.agents.map((agent, index) => parseHerdrAgent(agent, index))
}

// `herdr agent list` reports no branch field at all, so the branch is read from
// the agent's own directory instead. Branches rarely change but this spawns git,
// so results are cached well past the 2s snapshot TTL.
const branchCache = new Map()
const pendingBranches = new Map()
const BRANCH_TTL_MS = 30000
const BRANCH_CACHE_LIMIT = 200

function readBranchCache(cwd) {
  const cached = branchCache.get(cwd)
  return cached && Date.now() - cached.at < BRANCH_TTL_MS ? cached.branch : null
}

// Async because callers are request paths that resolve a branch per agent:
// spawning git synchronously would block the dashboard for up to the timeout for
// each worktree, and every row would pay it again on each cache expiry.
// Callers that arrive together for one directory share a single probe.
export async function resolveBranch(cwd) {
  if (!cwd) return ''

  const cached = readBranchCache(cwd)
  if (cached !== null) return cached

  const pending = pendingBranches.get(cwd)
  if (pending) return pending

  const probe = detectGitBranchAsync(cwd)
    .then((detected) => {
      // A detached HEAD resolves to "HEAD", which is not a branch worth displaying.
      const branch = detected === 'HEAD' ? '' : detected
      if (branchCache.size >= BRANCH_CACHE_LIMIT && !branchCache.has(cwd)) branchCache.clear()
      branchCache.set(cwd, { branch, at: Date.now() })
      return branch
    })
    .finally(() => {
      pendingBranches.delete(cwd)
    })
  pendingBranches.set(cwd, probe)
  return probe
}

// The snapshot size is decided by the runtimes, so the probes it triggers are
// capped: one git process per row at once could exhaust the process table.
const BRANCH_PROBE_CONCURRENCY = 4

// Runs `fn` over `items` with at most `limit` calls in flight, and returns the
// results in the order of `items`. Exported for tests.
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function extractOrcaAgents(orcaRes) {
  if (!orcaRes.ok || !Array.isArray(orcaRes.data?.result?.worktrees)) return []
  const list = []
  for (const wt of orcaRes.data.result.worktrees) {
    if (!wt || typeof wt !== 'object') continue
    if (Array.isArray(wt.agents)) {
      for (const a of wt.agents) {
        list.push(parseOrcaAgent(wt, a, list.length))
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

  const agents = [...extractHerdrAgents(herdrRes), ...extractOrcaAgents(orcaRes)]
  // Orca supplies the branch; fill it in from the directory for the runtimes that
  // do not. Rows in one directory share a single probe, and the spawns are capped
  // so a large snapshot cannot start one git per row at once.
  await mapWithConcurrency(
    agents.filter((agent) => !agent.branch),
    BRANCH_PROBE_CONCURRENCY,
    async (agent) => {
      agent.branch = await resolveBranch(agent.cwd)
    }
  )

  return {
    agents,
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
let inFlight = null
let inFlightIsForced = false
const CACHE_TTL_MS = 2000

export async function getLiveAgents({ forceFresh = false } = {}) {
  const now = Date.now()
  if (!forceFresh && cachedState && now - lastFetch < CACHE_TTL_MS) {
    return cachedState
  }
  // Requests that arrive before the cache is warm would otherwise each spawn the
  // runtimes; share one collection instead. A caller may share when any snapshot
  // will do (it is not asking for freshness) or when the collection in flight was
  // itself forced fresh now. A forced caller must not be answered with a
  // collection that began before it asked.
  if (inFlight && (inFlightIsForced || !forceFresh)) {
    return inFlight
  }

  let collection
  collection = collectLiveState()
    .then((state) => {
      // Only the newest collection may fill the cache: an older one finishing
      // late would otherwise overwrite the snapshot that replaced it.
      if (inFlight === collection) {
        cachedState = state
        lastFetch = Date.now()
      }
      return state
    })
    .finally(() => {
      if (inFlight === collection) {
        inFlight = null
        inFlightIsForced = false
      }
    })
  inFlight = collection
  inFlightIsForced = forceFresh
  return collection
}
