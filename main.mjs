// ─── Orca plugin: agent-notify ─────────────────────────────────────────────
// Runs inside Orca's plugin worker fork (plain Node, no Electron).
// Receives `orca` API — subscribes to agent.status.changed and sends to ntfy.
//
// Install via:
//   1. Push to GitHub
//   2. Orca → Settings → Plugins → + Install plugin → <repo URL>
//   3. Enable in plugin list

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loadNtfyConfig, buildTags, isEnabled } from './shared/ntfy.mjs'
import { resolveConfigDir } from './shared/config.mjs'
import { dispatchNotification } from './shared/notify.mjs'
import { buildSimpleBody } from './shared/format.mjs'
import { detectGitBranch } from './shared/git.mjs'
import { showDesktopNotification } from './shared/desktop.mjs'

function extractWorktreePath(worktreeId) {
  if (!worktreeId) return ''
  // Orca worktreeIds are shaped like `<repoId>::<absolutePath>`
  const parts = String(worktreeId).split('::')
  return parts.length > 1 ? parts.slice(1).join('::') : worktreeId
}

function buildOrcaBody(state, worktreeId) {
  const location = extractWorktreePath(worktreeId)
  const branch = detectGitBranch(location)
  return buildSimpleBody(state, location, branch)
}

function readState(payload) {
  return payload.state?.toLowerCase() || ''
}

function readMainAgentState(payload) {
  return payload.mainAgent?.state?.toLowerCase() || ''
}

function isNotifyState(state) {
  return state === 'done' || state === 'blocked'
}

// Gate on the main agent's own state so subagent processes (claude -p, pi -p,
// codex exec, ...) never drive a notification on their own. When the host
// does not carry a mainAgent fact, fall back to the combined state - that is
// the best available main-agent signal.
export function resolveNotifyState(payload) {
  const mainState = readMainAgentState(payload)
  return mainState || readState(payload)
}

function notifyTitle(state) {
  if (state === 'blocked') return 'Agent needs action'
  return 'Agent settled'
}

function notifyPriority(state, config) {
  if (state === 'blocked') return config.NTFY_PRIORITY_BLOCKED
  return config.NTFY_PRIORITY_DONE
}

function readWorktreeId(payload) {
  return payload.worktreeId || ''
}

function summarizeConfig(config) {
  return {
    PLATFORM_DESKTOP: config.PLATFORM_DESKTOP,
    PLATFORM_NTFY: config.PLATFORM_NTFY,
    NTFY_URL: config.NTFY_URL,
    NTFY_TOPIC: config.NTFY_TOPIC,
    hasApiKey: Boolean(config.NTFY_API_KEY),
    NTFY_PRIORITY_DONE: config.NTFY_PRIORITY_DONE,
    NTFY_PRIORITY_BLOCKED: config.NTFY_PRIORITY_BLOCKED,
  }
}

function logOrca(orca, message) {
  try {
    orca?.log?.(message)
  } catch {
    // Logging must never break notification delivery.
  }
  console.error(message)
}

// Orca re-emits the row when the combined state changes, so a main agent that
// already settled is re-announced when a subagent process finishes. Notify
// each pane at most once per settle cycle (reset by any non-notify fact).
const lastSettledByPane = new Map()

export function forgetPane(paneKey) {
  lastSettledByPane.delete(paneKey)
}

export function isSettleAlreadyNotified(paneKey, state) {
  if (!paneKey) return false
  if (lastSettledByPane.size >= 512) lastSettledByPane.clear()
  return lastSettledByPane.get(paneKey) === state
}

export function markPaneNotified(paneKey, state) {
  if (paneKey) lastSettledByPane.set(paneKey, state)
}

async function handleStatusChanged(payload, config, orca) {
  const state = resolveNotifyState(payload)
  const paneKey = payload.paneKey || ''

  if (!isNotifyState(state)) {
    // New main-agent activity starts a fresh settle cycle.
    forgetPane(paneKey)
    return
  }
  if (isSettleAlreadyNotified(paneKey, state)) return
  markPaneNotified(paneKey, state)

  const worktreeId = readWorktreeId(payload)
  const body = buildOrcaBody(state, worktreeId)

  logOrca(
    orca,
    `[agent-notify] dispatch state=${state} config=${JSON.stringify(summarizeConfig(config))}`
  )

  const results = await dispatchNotification(
    {
      title: notifyTitle(state),
      body,
      // Orca's v0 projection carries no agent-type field, so agent-specific
      // emoji tags are out of scope here.
      tags: buildTags(state, '', body),
      priority: notifyPriority(state, config),
      config,
    },
    config,
    async (title, bodyText) => {
      try {
        const result = await orca.host.call('notifications.show', { title, body: bodyText })
        if (!result?.delivered) {
          showDesktopNotification(title, bodyText)
        }
      } catch {
        showDesktopNotification(title, bodyText)
      }
    }
  )

  logOrca(orca, `[agent-notify] results ${JSON.stringify(results)}`)
}

function resolveOrcaConfigDir() {
  // Orca installs plugins under a content-hash directory and keeps durable
  // config in a sibling `dev/` folder. Prefer any existing .env over the
  // hashed package root so ntfy settings survive reinstalls.
  const pluginRoot = path.dirname(fileURLToPath(import.meta.url))
  const pluginHome = path.dirname(pluginRoot)
  const durableDevDir = path.join(pluginHome, 'dev')
  return resolveConfigDir([pluginRoot, durableDevDir, pluginHome], durableDevDir)
}

export default function activate(orca) {
  const configDir = resolveOrcaConfigDir()
  const bootConfig = loadNtfyConfig(configDir)
  logOrca(
    orca,
    `[agent-notify] activated configDir=${configDir} config=${JSON.stringify(summarizeConfig(bootConfig))}`
  )

  orca.events.on('agent.status.changed', async (payload) => {
    const config = loadNtfyConfig(configDir)
    if (!isEnabled(config)) return
    await handleStatusChanged(payload, config, orca)
  })
}
