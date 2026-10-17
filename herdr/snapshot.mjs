// ─── Herdr snapshot lookup ─────────────────────────────────────────────────
// Falls back to `herdr api snapshot` when the plugin event provides no path.

import { execSync } from 'node:child_process'
import { getExtendedPathEnv } from '../shared/env.mjs'

function safeJsonParse(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function paneCwd(pane) {
  if (pane.cwd) return pane.cwd
  if (pane.foreground_cwd) return pane.foreground_cwd
  return ''
}

function getPanes(snapshot) {
  return snapshot && Array.isArray(snapshot.panes) ? snapshot.panes : []
}

export function findPaneCwd(snapshot, paneId) {
  const pane = getPanes(snapshot).find((p) => p.pane_id === paneId)
  return pane ? paneCwd(pane) : ''
}

export function resolveWorkspaceFromSnapshot(paneId) {
  if (!paneId) return ''
  try {
    const stdout = execSync('herdr api snapshot', {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: getExtendedPathEnv(),
    })
    const response = safeJsonParse(stdout)
    return findPaneCwd(response?.result?.snapshot, paneId)
  } catch {
    return ''
  }
}
