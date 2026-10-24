// ─── Pane transition store ───────────────────────────────────────────────────
// One JSON file, written by the Herdr plugin adapter and read by the dashboard.
//
// Entries used to be bare status strings (`{"wGV:p3": "done"}`). They are now
// `{ status, at }`, where `at` is when that status was first observed. Both
// shapes are read, because an existing file holds hundreds of the old strings
// and a reader that rejected them would drop every notification transition on
// the first run after an upgrade.
//
// The format lives here rather than in `herdr/state.mjs` so that both the
// adapter (a writer) and `shared/catalog.mjs` (a reader) can depend on it
// without shared code reaching into the herdr plugin.

import fs from 'node:fs'
import path from 'node:path'

const STATE_FILE = 'agent-notify-state.json'

export function statePath(configDir) {
  return path.join(configDir || '/tmp', STATE_FILE)
}

// A real epoch timestamp, or false. A string or NaN must not become a duration
// measured from 1970, so nothing is coerced.
function isEpoch(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

// The status an entry records, whichever shape it is in. A string is the
// pre-timestamp shape; anything else is unrecognised, and reporting no history
// is what a missing entry already means.
export function entryStatus(entry) {
  if (typeof entry === 'string') return entry
  const status = entry?.status
  return typeof status === 'string' ? status : undefined
}

// When the entry's current status was first observed, or null. Only the object
// shape can answer, and only with a usable number.
export function entryStartedAt(entry) {
  const at = entry?.at
  return isEpoch(at) ? at : null
}

// Valid JSON is not necessarily a store: a file holding `null`, `[]` or `"x"`
// parses without error and would then be indexed as if it had panes. Anything
// that is not a plain object reads as empty, which is what a missing file
// already means, so a corrupt file cannot take a snapshot down.
function isStore(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function readStateFile(configDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(configDir), 'utf8'))
    return isStore(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

// Written through a temporary file and renamed into place. The dashboard reads
// this file while the adapter writes it, and a plain write leaves a window in
// which a reader sees truncated JSON; parsing that fails and yields `{}`, which
// would drop every transition at once. Rename is atomic within one directory.
export function writeStateFile(configDir, state) {
  const target = statePath(configDir)
  const temporary = `${target}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2))
    fs.renameSync(temporary, target)
  } catch {
    // A state write must not break notification delivery, and a temporary file
    // left behind is not worth failing the run over.
    try {
      fs.unlinkSync(temporary)
    } catch {
      // Nothing to clean up.
    }
  }
}

// When each pane entered its current status, keyed by pane id. An entry with no
// usable time is left out rather than reported as zero, so a caller can tell
// "unknown" from "just now".
export function readTransitions(state) {
  const times = new Map()
  for (const [paneId, entry] of Object.entries(state || {})) {
    const at = entryStartedAt(entry)
    if (at !== null) times.set(paneId, at)
  }
  return times
}
