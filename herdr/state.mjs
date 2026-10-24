// ─── Per-pane status transition tracking ─────────────────────────────────────
// Prevents spurious notifications when a session starts in the idle state, and
// records when each transition was observed so the dashboard can show how long
// an agent has been in its current state.
//
// Herdr reports no wall clock at all: its agent payload carries only the
// monotonic counters `revision`, `state_change_seq` and `completion_seq`. This
// adapter is invoked on every `pane.agent_status_changed` event, so it is the
// one place a real timestamp can be taken.
//
// The file format and its atomic write live in `shared/timings.mjs`, because the
// dashboard reads the same file and must not depend on this plugin module.

import { entryStatus, entryStartedAt, readStateFile, writeStateFile } from '../shared/timings.mjs'

export function readState(configDir) {
  return readStateFile(configDir)
}

export function writeState(configDir, state) {
  writeStateFile(configDir, state)
}

function isDoneTransition(last) {
  return last !== 'done' && last !== undefined && last !== ''
}

// A blocked agent notifies on first sight; any earlier status counts as change.
function isBlockedTransition(last) {
  return last !== 'blocked'
}

export function shouldNotify(status, paneId, state) {
  const last = entryStatus(state[paneId])
  if (status === 'blocked') return isBlockedTransition(last)
  return status === 'done' && isDoneTransition(last)
}

// Records a status and, when it changed, the moment it was observed. The clock
// must survive re-observation: a poll that finds the same status again is not a
// new transition, and rewriting `at` would reset a four-hour run to "just now"
// on every event.
const KNOWN_STATUSES = new Set(['working', 'blocked', 'done'])

export function updateState(state, paneId, status, now = Date.now()) {
  if (!KNOWN_STATUSES.has(status)) return
  const previous = state[paneId]
  const unchanged = entryStatus(previous) === status
  // The observed time wins on a change; on re-observation the original clock is
  // kept, or a long run would reset to "just now" on every event.
  state[paneId] = { status, at: unchanged ? (entryStartedAt(previous) ?? now) : now }
}
