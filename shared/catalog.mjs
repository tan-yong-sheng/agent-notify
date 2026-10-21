// ─── Agent Catalog: Multi-Runtime Discovery Seam ──────────────────────────
// Deep query interface encapsulating CLI queries (`herdr agent list`,
// `orca worktree ps --json`), JSON schema normalization, and TTL caching.

import { execFile } from 'node:child_process'
import { getExtendedPathEnv } from './env.mjs'
import { detectGitBranchAsync } from './git.mjs'
import { entryStartedAt, entryStatus, readStateFile } from './timings.mjs'

const execEnv = getExtendedPathEnv()
// `orca worktree ps --json` grows with the number of worktrees, and the 1 MiB
// default would turn a busy machine into a truncation and a JSON parse error.
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024

function execCommand(cmd, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_COMMAND_OUTPUT_BYTES, env: execEnv, killSignal: 'SIGKILL' },
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

// `herdr plugin config-dir` prints a path, not JSON, so it needs its own
// runner rather than going through execCommand's parser.
function execCommandText(cmd, args, timeoutMs = 2000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', env: execEnv }, (err, stdout) => {
      if (err) return resolve({ ok: false, text: '' })
      resolve({ ok: true, text: String(stdout || '').trim() })
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

// Epoch milliseconds from a runtime field, or null. A string is rejected rather
// than coerced: `Number("Sun Jan 01")` is NaN, and a NaN timestamp renders as a
// row that claims to have been running since 1970 or for zero seconds.
function asEpoch(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

// One tool, one name. Herdr reports this tool as `dsh-tui` and Orca reports it
// as `dsh`, so a row's name would otherwise depend on which adapter happened to
// find it. The map is keyed on the reported name alone, and a name that is not
// in it passes through untouched: this is a rename of two spellings of one
// tool, not a whitelist of allowed agents.
const AGENT_ALIASES = new Map([['dsh', 'dsh-tui']])

export function canonicalAgentName(name) {
  const text = asText(name)
  return text ? (AGENT_ALIASES.get(text.toLowerCase()) || text) : text
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
    agent: canonicalAgentName(asText(record.agent)) || 'pi',
    status: normalizeAgentStatus(rawStatus),
    rawStatus,
    cwd: asText(record.cwd),
    displayName: asText(record.terminal_title) || asId(record.pane_id, 'Herdr Agent'),
    branch: '',
    tool: null,
    toolInput: null,
    prompt: null,
    focused: Boolean(record.focused),
    // Herdr reports no timestamps at all: its agent payload carries only the
    // monotonic counters `revision`, `state_change_seq` and `completion_seq`.
    // Stamping `Date.now()` here made every Herdr row say "just now" forever,
    // because the stamp was rewritten on each poll. `null` is the honest value;
    // collectLiveState() fills in the state's own observation time instead.
    stateStartedAt: null,
    updatedAt: null,
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
    agent: canonicalAgentName(asText(agent.agentType)) || 'pi',
    status: normalizeAgentStatus(rawStatus),
    rawStatus,
    cwd: asText(worktree.path),
    displayName,
    branch,
    tool: agent.toolName ?? null,
    toolInput: agent.toolInput ?? null,
    prompt: asText(agent.prompt).trim() || null,
    stateStartedAt: asEpoch(agent.stateStartedAt),
    updatedAt: asEpoch(agent.updatedAt),
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

// A probe failure is one row's problem: a rejected probe would otherwise reject
// the worker, abort `mapWithConcurrency`, and fail the whole snapshot over a
// single unusable directory. The probe is injectable so that path is testable.
// A failure returns null, which is not a branch, so `resolveBranch` can tell it
// apart from a directory that genuinely has no branch to show.
async function probeBranch(cwd, probe) {
  try {
    const detected = await probe(cwd)
    // A detached HEAD resolves to "HEAD", which is not a branch worth displaying.
    if (!detected || detected === 'HEAD') return ''
    return detected
  } catch {
    return null
  }
}

// Async because callers are request paths that resolve a branch per agent:
// spawning git synchronously would block the dashboard for up to the timeout for
// each worktree, and every row would pay it again on each cache expiry.
// Callers that arrive together for one directory share a single probe.
export async function resolveBranch(cwd, probe = detectGitBranchAsync) {
  if (!cwd) return ''

  const cached = readBranchCache(cwd)
  if (cached !== null) return cached

  const pending = pendingBranches.get(cwd)
  if (pending) return pending

  const lookup = probeBranch(cwd, probe)
    .then((branch) => {
      // A failed probe is reported as an empty branch but not cached: caching it
      // would serve the failure for the whole TTL after the probe recovered.
      // An empty result from a probe that ran is cached, because a detached HEAD
      // will not become a branch before the TTL expires.
      if (branch === null) return ''
      if (branchCache.size >= BRANCH_CACHE_LIMIT && !branchCache.has(cwd)) branchCache.clear()
      branchCache.set(cwd, { branch, at: Date.now() })
      return branch
    })
    .finally(() => {
      pendingBranches.delete(cwd)
    })
  pendingBranches.set(cwd, lookup)
  return lookup
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

// Two rows keyed alike make one row render the other's state: a runtime that
// reports a real id equal to another row's positional fallback (`pane-1`) would
// otherwise collide, and duplicate ids from a runtime collide with themselves.
// Repeats get a suffix instead of being dropped, so no row disappears.
function withUniqueIds(agents) {
  const seen = new Set()
  return agents.map((agent) => {
    if (!seen.has(agent.id)) {
      seen.add(agent.id)
      return agent
    }
    let suffix = 2
    while (seen.has(`${agent.id}~${suffix}`)) suffix += 1
    const uniqueId = `${agent.id}~${suffix}`
    seen.add(uniqueId)
    return { ...agent, id: uniqueId }
  })
}

// ─── State transition tracking ───────────────────────────────────────────────
// Only Orca reports when a state began (`stateStartedAt`). Herdr reports no
// wall clock at all: its agent payload carries just the monotonic counters
// `revision`, `state_change_seq` and `completion_seq`. So Herdr's timing has to
// be observed rather than read, and the catalog is the one place that sees
// every poll. Without it the table cannot answer "which agent has been working
// for 20 minutes", which is the question the table exists to answer.

// A snapshot cannot describe its own past. A row first seen already settled has
// no observable transition behind it, and a row first seen working has only a
// lower bound on how long it has been working. `stateSinceExact` and
// `settledSince` carry those two distinctions to the page, so it can print
// "12m+" or "—" instead of claiming a precision the data does not have.
const stateSince = new Map()

// Exposed for tests: the map outlives a collection by design, so a suite that
// asserts on first-sight behaviour needs a way to start from nothing.
export function resetStateSince() {
  stateSince.clear()
}

// A row that has gone must not keep its history: both runtimes reuse pane ids,
// and a stale entry would hand a new agent its predecessor's clock.
//
// A row is only known to have gone when its runtime answered. A failed query
// returns an empty list, and treating that as "every row of this runtime
// departed" would throw away every clock it had the moment Herdr or the Orca CLI
// hiccuped. `answered` names the runtimes that actually reported.
function forgetDeparted(agents, answered) {
  const live = new Set(agents.map((agent) => agent.id))
  for (const id of stateSince.keys()) {
    if (live.has(id)) continue
    // An id carries its runtime as a prefix; a source that did not answer says
    // nothing about its rows, so its history is kept.
    if (answered && !answered.has(id.split('-')[0])) continue
    stateSince.delete(id)
  }
}

const ACTIVE_STATUSES = new Set(['working', 'blocked'])

function isActive(status) {
  return ACTIVE_STATUSES.has(status)
}

// Works out when the current status began, in one of three ways:
//   1. the runtime said so (Orca) — exact, and it survives a restart;
//   2. the same status as last poll — the clock it was first given;
//   3. first sight, or a change this poll is the first to see — now.
// Only case 1 and a genuine transition are exact starts; case 3 on first sight
// is a lower bound, which is what stateSinceExact reports.
function resolveTiming(agent, previous, now) {
  if (agent.stateStartedAt !== null) {
    return { at: agent.stateStartedAt, exact: true, settledAt: agent.stateStartedAt }
  }
  const changed = previous ? previous.status !== agent.status : true
  if (previous && !changed) {
    return { at: previous.at, exact: previous.exact, settledAt: previous.settledAt }
  }
  // A row first seen settled has no observed transition behind it, so there is
  // nothing honest to print in the last-active column.
  return { at: now, exact: false, settledAt: previous ? now : null }
}

// Exported for tests. The clock is a parameter so a suite can step time
// forward without sleeping; `collectLiveState()` passes `Date.now()`.
export function trackStateSince(agents, now, answered = null) {
  forgetDeparted(agents, answered instanceof Set ? answered : null)

  for (const agent of agents) {
    const previous = stateSince.get(agent.id)
    const timing = resolveTiming(agent, previous, now)
    agent.stateSince = timing.at
    agent.stateSinceExact = timing.exact
    agent.settledSince = timing.settledAt

    stateSince.set(agent.id, {
      status: agent.status,
      at: timing.at,
      exact: timing.exact,
      settledAt: timing.settledAt,
    })

    // Last activity is a runtime fact, not an inference. Herdr reports none, so
    // for a running row the honest answer is "now" — it is running — and for a
    // settled row it is the transition, or nothing when none was observed. The
    // old stamp here was `Date.now()` on every poll, which made every Herdr row
    // claim "just now" forever.
    if (agent.updatedAt === null) {
      agent.updatedAt = isActive(agent.status) ? now : timing.settledAt
    }
  }
}

// Where the Herdr plugin keeps its per-pane state. Asked of Herdr rather than
// assumed: the adapter's own default is `/tmp`, while an installed plugin gets a
// directory under the user's config, and guessing wrong would silently produce
// "no duration" for every Herdr row.
// Cached because the value cannot change while the dashboard runs, and the
// catalog is asked for a snapshot every couple of seconds.
let pluginConfigDirCache = null

async function resolvePluginConfigDir() {
  const explicit = process.env.HERDR_PLUGIN_CONFIG_DIR
  if (explicit) return explicit
  if (pluginConfigDirCache !== null) return pluginConfigDirCache
  const lookup = await execCommandText('herdr', ['plugin', 'config-dir', 'agent-notify'])
  // A failed lookup is not cached: Herdr may simply not be running yet, and
  // caching the failure would hide durations for the rest of the process.
  if (!lookup.ok) return ''
  pluginConfigDirCache = lookup.text
  return pluginConfigDirCache
}

// The adapter stores the status it translated (`idle` becomes `done`), while a
// row keeps the runtime's own vocabulary (`idle`), so a literal comparison would
// drop the duration for every settled pane. Both spellings mean the same settled
// state; every other status compares as itself.
function sameState(recordedStatus, rowStatus) {
  const settle = (status) => (status === 'idle' ? 'done' : status)
  return settle(recordedStatus) === settle(rowStatus)
}

// Applies the transition times the adapter recorded. A pane with no recorded
// time keeps none: that is a run this dashboard started watching mid-flight, and
// a duration from first observation is the inaccurate number this replaced.
// The pure half, so the mapping from a recorded time to a row can be tested
// without a running adapter or a Herdr CLI.
export function applyRecordedTransitions(agents, state) {
  for (const agent of agents) {
    if (agent.source !== 'herdr') continue
    // Rows are keyed `herdr-<paneId>`; the store is keyed by Herdr's own pane id,
    // which is what the row id carries after its prefix.
    const paneId = agent.id.startsWith('herdr-') ? agent.id.slice('herdr-'.length) : ''
    if (!paneId) continue
    const entry = state[paneId]
    // The stored time describes the status it was recorded for. If a transition
    // event was missed or delayed, the row has already moved on and this clock
    // belongs to the previous state: showing it would date the current status
    // from when the previous one began.
    if (!sameState(entryStatus(entry), agent.status)) continue
    const recorded = entryStartedAt(entry)
    if (recorded === null) continue
    agent.stateSince = recorded
    agent.stateSinceExact = true
    // The adapter records when it first saw the status, so for a settled row
    // this is also when it settled.
    agent.settledSince = recorded
  }
  return agents
}

async function applyRecordedFromDisk(agents) {
  const configDir = await resolvePluginConfigDir()
  if (!configDir) return agents
  return applyRecordedTransitions(agents, readStateFile(configDir))
}

export async function collectLiveState() {
  const [herdrRes, orcaRes] = await Promise.all([
    execCommand('herdr', ['agent', 'list'], 2500),
    execCommand('orca', ['worktree', 'ps', '--json'], 3500),
  ])

  const agents = withUniqueIds([...extractHerdrAgents(herdrRes), ...extractOrcaAgents(orcaRes)])
  const now = Date.now()
  // Only a runtime that answered can testify that its rows are gone.
  const answered = new Set()
  if (herdrRes.ok) answered.add('herdr')
  if (orcaRes.ok) answered.add('orca')
  trackStateSince(agents, now, answered)
  // After trackStateSince, so a recorded time overrides the observed one. It
  // must run after ids are made unique, because a duplicate id carries a suffix
  // that no pane in the store has.
  await applyRecordedFromDisk(agents)
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
  //
  // Sharing a forced collection that is already running is deliberate: the wait is
  // bounded by one collection, while starting a probe per request would put back
  // the unbounded fan-out the branch probes were capped to avoid. Every forced
  // caller therefore waits for a collection no older than the one it joins.
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
