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

function isNotifyState(state) {
  return state === 'done' || state === 'blocked'
}

function notifyTitle(state) {
  if (state === 'blocked') return 'Agent needs action'
  return 'Agent settled'
}

function notifyPriority(state, config) {
  if (state === 'blocked') return config.NTFY_PRIORITY_BLOCKED
  return config.NTFY_PRIORITY_DONE
}

function readAgent(payload) {
  return payload.agentType || 'Agent'
}

function readWorktreeId(payload) {
  return payload.worktreeId || ''
}

async function handleStatusChanged(payload, config, orca) {
  const state = readState(payload)
  if (!isNotifyState(state)) return

  const agent = readAgent(payload)
  const worktreeId = readWorktreeId(payload)
  const body = buildOrcaBody(state, worktreeId)

  await dispatchNotification(
    {
      title: notifyTitle(state),
      body,
      tags: buildTags(state, agent, body),
      priority: notifyPriority(state, config),
      config,
    },
    config,
    async (title, body) => {
      try {
        const result = await orca.host.call('notifications.show', { title, body })
        if (!result?.delivered) {
          showDesktopNotification(title, body)
        }
      } catch {
        showDesktopNotification(title, body)
      }
    }
  )
}

function resolveOrcaConfigDir() {
  const pluginRoot = path.dirname(fileURLToPath(import.meta.url))
  return pluginRoot
}

export default function activate(orca) {
  orca.events.on('agent.status.changed', async (payload) => {
    const config = loadNtfyConfig(resolveOrcaConfigDir())
    if (!isEnabled(config)) return
    await handleStatusChanged(payload, config, orca)
  })
}
