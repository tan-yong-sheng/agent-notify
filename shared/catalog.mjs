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

// A pi session file is named after the moment the session started:
// `2026-10-24T15-08-37-988Z_<uuid>.jsonl`. The time keeps the name safe on
// every filesystem, so the colons are dashes. The stamp is the session's
// start, a moment before the file itself appears.
const PI_SESSION_STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/

// The file name is the session's identity: the stamp says when the session
// started, the uuid says which session it is. Two sessions can share a
// millisecond, so the whole name is what tells two agents apart.
function sessionFileName(value) {
  const name = String(value || '').split(/[\\/]/).pop()
  return name || null
}

// The moment the agent's session started, or null when the runtime reports no
// session path or one this cannot read. It is the floor for any record about
// that agent: no record of this agent can be older than its session, and a
// pane reused by a new agent runs a new session, so a record from before this
// moment belongs to the predecessor.
function sessionStartFromPath(value) {
  const name = sessionFileName(value)
  const match = PI_SESSION_STAMP.exec(name)
  if (!match) return null
  const [, year, month, day, hour, minute, second, millis] = match
  const at = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`)
  if (!Number.isFinite(at)) return null
  // The parser rolls impossible dates forward (February 30 becomes March 2),
  // so the moment it returns must reproduce the stamp it was given.
  const stamp = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}`
  return new Date(at).toISOString().startsWith(stamp) ? at : null
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
    // The session the agent runs in. Herdr reports the session file: its name
    // is the session's identity, and the stamp in that name is the moment the
    // session started.
    sessionIdentity: sessionFileName(asText(record.agent_session?.value)),
    sessionStartedAt: sessionStartFromPath(asText(record.agent_session?.value)),
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

// A row that has gone must not keep its clock: both runtimes reuse pane ids,
// and a stale clock would hand a new agent its predecessor's history.
//
// A row is only known to have gone when its runtime answered. A failed query
// returns an empty list, and treating that as "every row of this runtime
// departed" would throw away every clock it had the moment Herdr or the Orca CLI
// hiccuped. `answered` names the runtimes that actually reported.
function forgetDeparted(agents, answered) {
  const live = new Set(agents.map((agent) => agent.id))
  for (const [id] of stateSince) {
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

// The floor is the latest instant that cannot belong to the current
// occurrence: a record stamped at or before it describes an earlier one.
//
// The two bounds are not equally strict. A poll boundary is inclusive — the
// poll at that instant saw a different status, so a record stamped there is
// the one it saw, or a change in the same millisecond that cannot be told
// apart from it. A session start is exclusive — the occurrence began when
// the session began, so a record stamped exactly at the session start may be
// that session's first transition — which makes the session bound the
// millisecond before the start.
//
// The session start is also the bound that survives the dashboard missing the
// moment a pane changed hands: a new agent runs a new session, so the
// predecessor's record falls before it.
//
// A handover is bounded by the later of the new session's start and the poll
// that saw the predecessor. The stamp alone is not enough: a resumed session
// carries its original start, which can be older than the predecessor's own
// session and says nothing about when the agent took over the pane. The poll
// that saw the predecessor is the other bound — the predecessor's record was
// written no later than it, unless the adapter lagged that event past it.
function occurrenceFloor(agent, previous, changed, now) {
  const sessionStart = agent.sessionStartedAt
  const sessionFloor = sessionStart === null || sessionStart === undefined ? null : sessionStart - 1
  if (!previous) return sessionFloor
  // A new agent starts a new occurrence: its own session bounds it, or this
  // poll when that session cannot be read.
  const handedOver = sessionChanged(previous, agent)
  const observed = handedOver
    ? (sessionFloor === null ? now : Math.max(sessionFloor, previous.observedAt))
    : (changed ? previous.observedAt : previous.floor)
  if (sessionFloor === null) return observed
  if (observed === null || observed === undefined) return sessionFloor
  return Math.max(observed, sessionFloor)
}

// A pane handed to a new agent runs a new session. Herdr reports one session
// per agent, and its file name is that session's identity, so a change in the
// name is the proof that the pane holds someone else now.
//
// The identity can also arrive late: a runtime that reports no session at
// first may report one later. That alone proves nothing, but a row whose
// clock starts before the session that is here now cannot belong to it, so
// the clock is proof enough.
function sessionChanged(previous, agent) {
  const after = agent.sessionIdentity
  if (after === null || after === undefined) return false
  const before = previous ? previous.session : null
  if (before !== null && before !== undefined) return before !== after
  const sessionStart = agent.sessionStartedAt
  if (sessionStart === null || sessionStart === undefined) return false
  return previous.at < sessionStart
}

// Works out when the current status began, in four ways:
//   1. the runtime said so (Orca) — exact, and it survives a restart;
//   2. the same agent, in the same status — the clock it was first given;
//   3. a change this process watched happen — measured to within one poll;
//   4. a new agent in the pane, or a first sighting — a lower bound, and the
//      only case that knows nothing.
function resolveTiming(agent, previous, now) {
  const changed = previous ? previous.status !== agent.status : true
  const floor = occurrenceFloor(agent, previous, changed, now)
  if (agent.stateStartedAt !== null) {
    // The runtime reports the start, but the floor still marks the last poll
    // that saw a different status, so a record cannot date an earlier run of
    // the current status.
    return { at: agent.stateStartedAt, exact: true, settledAt: agent.stateStartedAt, floor }
  }
  // The same agent, in the same status: the clock it was first given.
  if (previous && !changed && !sessionChanged(previous, agent)) {
    return { at: previous.at, exact: previous.exact, settledAt: previous.settledAt, floor }
  }
  // A change, a first sighting, or a new agent in the pane. The row's clock
  // starts again: the one the predecessor left behind belongs to another
  // agent, and a settled row must not claim it settled at the predecessor's
  // time.
  return { at: now, exact: false, settledAt: previous ? now : null, floor }
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
    agent.occurrenceFloor = timing.floor
    agent.settledSince = timing.settledAt

    stateSince.set(agent.id, {
      status: agent.status,
      at: timing.at,
      exact: timing.exact,
      settledAt: timing.settledAt,
      floor: timing.floor,
      // The agent's session, by its identity. A pane handed to a new agent
      // runs a new session, and that is what tells the two apart when the
      // status does not change. The identity carries the uuid as well as the
      // start, so two agents can share a millisecond and still differ.
      session: agent.sessionIdentity,
      // The poll this row was seen in. It becomes the next poll's floor when
      // the status changes, because the row showed the old status here.
      observedAt: now,
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
// Rows are keyed `herdr-<paneId>`; the store is keyed by Herdr's own pane id,
// which is what the row id carries after its prefix. A non-Herdr row has none.
function herdrPaneId(agent) {
  if (agent.source !== 'herdr') return ''
  return agent.id.startsWith('herdr-') ? agent.id.slice('herdr-'.length) : ''
}

// The recorded time for this row, or null when there is none it may trust.
//
// Two reasons to refuse. The stored time describes the status it was recorded
// for, so a missed or delayed event leaves the row on a newer status and that
// clock belongs to the previous state. And a matching status does not prove
// the current occurrence: the adapter can miss an event, and then its record
// still carries the status while its clock belongs to the earlier run of that
// status. The floor settles it — the current occurrence began after the last
// poll that saw a different status, and no earlier than the agent's session
// started, so a record at or before the floor describes the earlier one.
//
// What a record that passes the floor guarantees is that the adapter saw this
// status change after the dashboard last saw another one, and after the
// current session began. It dates the occurrence as the adapter saw it, which
// is at or after the change itself, so it never claims a longer run than the
// adapter observed. It cannot prove the record belongs to this occurrence
// rather than an earlier run of the same status inside the same session:
// Herdr reports no identifier that ties a record to an occurrence, and a
// missing event leaves the adapter and the dashboard with the same evidence —
// a row that looks like it has been running since it was last seen.
function recordedTimeFor(agent, store) {
  const paneId = herdrPaneId(agent)
  if (!paneId) return null
  const entry = store[paneId]
  if (!sameState(entryStatus(entry), agent.status)) return null
  const recorded = entryStartedAt(entry)
  if (recorded === null) return null
  const floor = agent.occurrenceFloor
  if (floor !== null && floor !== undefined && recorded <= floor) return null
  return recorded
}

export function applyRecordedTransitions(agents, state) {
  // A missing or corrupt store means no recorded times, not a crash: this runs
  // inside snapshot collection, where a throw takes every row down with it.
  const store = state && typeof state === 'object' ? state : {}
  for (const agent of agents) {
    const recorded = recordedTimeFor(agent, store)
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
