// ─── Per-pane status transition tracking ─────────────────────────────────────
// Prevents spurious notifications when a session starts in the idle state.

import fs from 'node:fs'
import path from 'node:path'

function getStatePath(configDir) {
  return path.join(configDir || '/tmp', 'agent-notify-state.json')
}

export function readState(configDir) {
  try {
    return JSON.parse(fs.readFileSync(getStatePath(configDir), 'utf8'))
  } catch {
    return {}
  }
}

export function writeState(configDir, state) {
  try {
    fs.writeFileSync(getStatePath(configDir), JSON.stringify(state, null, 2))
  } catch {
    // State persistence failures must not break notification delivery.
  }
}

function isDoneTransition(last) {
  return last !== 'done' && last !== undefined && last !== ''
}

function isBlockedTransition(last) {
  return last !== 'blocked'
}

export function shouldNotify(status, paneId, state) {
  const last = state[paneId]
  if (status === 'blocked') return isBlockedTransition(last)
  return status === 'done' && isDoneTransition(last)
}

export function updateState(state, paneId, status) {
  if (status === 'working' || status === 'blocked' || status === 'done') {
    state[paneId] = status
  }
}
