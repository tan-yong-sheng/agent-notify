#!/usr/bin/env node

// ─── Herdr adapter: reads HERDR_PLUGIN_EVENT_JSON, dispatches to ntfy ───────
// Calls into shared/ntfy.mjs. Used by herdr-plugin.toml as [[events]] handler.

import { loadNtfyConfig, buildTags, isEnabled } from '../shared/ntfy.mjs'
import { dispatchNotification } from '../shared/notify.mjs'
import { showDesktopNotification } from '../shared/desktop.mjs'
import { buildSimpleBody } from '../shared/format.mjs'
import { detectGitBranch, detectGitRoot } from '../shared/git.mjs'
import fs from 'node:fs'
import path from 'node:path'
import {
  parseEventEnv,
  parseContextEnv,
  extractStatus,
  extractAgent,
  extractWorkspaceContext,
} from './utils.mjs'
import { resolveWorkspaceFromSnapshot } from './snapshot.mjs'
import { readState, writeState, shouldNotify, updateState } from './state.mjs'

const NOTIFY_STATES = ['done', 'blocked']
const NTFY_PRIORITY_DONE = 'default'
const NTFY_PRIORITY_BLOCKED = 'high'

function translateStatus(status) {
  if (status === 'idle') return 'done'
  return status
}

function isNotifyState(status) {
  return NOTIFY_STATES.includes(status)
}

function getConfigDir() {
  return process.env.HERDR_PLUGIN_CONFIG_DIR || '/tmp'
}

function getLogPath() {
  return path.join(getConfigDir(), 'agent-notify.log')
}

function writeLog(record) {
  try {
    const logPath = getLogPath()
    const line = `${new Date().toISOString()} ${JSON.stringify(record)}\n`
    fs.appendFileSync(logPath, line)
    trimLog(logPath)
  } catch {
    // Logging failures must not break notification delivery.
  }
}

function trimLog(logPath) {
  try {
    const maxLines = 200
    const content = fs.readFileSync(logPath, 'utf8')
    const lines = content.split('\n')
    if (lines.length > maxLines) {
      const trimmed = lines.slice(-maxLines).join('\n')
      fs.writeFileSync(logPath, trimmed)
    }
  } catch {
    // Ignore trim errors.
  }
}

function notifyTitle(status) {
  if (status === 'blocked') return 'Agent needs action'
  return 'Agent settled'
}

function notifyPriority(status) {
  if (status === 'blocked') return NTFY_PRIORITY_BLOCKED
  return NTFY_PRIORITY_DONE
}

function resolveLocation(workspace, tab) {
  if (!workspace) return tab || ''
  if (!tab) return workspace
  return `${workspace} · ${tab}`
}

function resolveWorkspace(rawWorkspace) {
  if (!rawWorkspace) return ''
  const gitRoot = detectGitRoot(rawWorkspace)
  return gitRoot || rawWorkspace
}

function composeNotification(status, agent, event, context, config) {
  const { workspace: rawWorkspace, tab, paneId } = extractWorkspaceContext(event, context)
  const snapshotWorkspace = rawWorkspace ? '' : resolveWorkspaceFromSnapshot(paneId)
  const workspace = resolveWorkspace(rawWorkspace || snapshotWorkspace)
  const location = resolveLocation(workspace, tab)
  const branch = detectGitBranch(workspace)
  const body = buildSimpleBody(status, location, branch)

  return {
    title: notifyTitle(status),
    body,
    tags: buildTags(status, agent, body),
    priority: notifyPriority(status),
    config,
    workspace,
    paneId,
  }
}

async function runTestNotification(config) {
  if (!isEnabled(config)) {
    console.log('Agent notify is disabled by config.')
    return
  }

  const title = 'Agent Notify test'
  const body = buildSimpleBody('done', process.cwd(), detectGitBranch(process.cwd()))
  await dispatchNotification(
    {
      title,
      body,
      tags: buildTags('done', 'Agent', body),
      priority: NTFY_PRIORITY_DONE,
      config,
    },
    config,
    showDesktopNotification
  )
  console.log('Test notification sent.')
}

function logKeys(label, obj) {
  try {
    return Object.keys(obj || {}).join(',')
  } catch {
    return ''
  }
}

function resolveAction(status, paneId, state) {
  if (!isNotifyState(status)) return { canNotify: false, reason: 'status' }
  if (!shouldNotify(status, paneId, state)) return { canNotify: false, reason: 'transition' }
  return { canNotify: true, reason: '' }
}

async function handleAgentEvent(config) {
  writeLog({ type: 'event_received', platform_desktop: config.PLATFORM_DESKTOP, platform_ntfy: config.PLATFORM_NTFY })

  const event = parseEventEnv()
  const context = parseContextEnv()
  const rawStatus = extractStatus(event, context)
  const status = translateStatus(rawStatus)
  const agent = extractAgent(event, context)
  const { workspace, tab, paneId } = extractWorkspaceContext(event, context)
  const configDir = getConfigDir()
  const state = readState(configDir)
  const lastStatus = state[paneId]

  writeLog({
    type: 'parsed',
    rawStatus,
    status,
    agent,
    workspace,
    tab,
    paneId,
    lastStatus,
    eventKeys: logKeys('event', event?.data || event),
    contextKeys: logKeys('context', context),
  })

  const action = resolveAction(status, paneId, state)
  updateState(state, paneId, status)
  writeState(configDir, state)

  if (!action.canNotify) {
    writeLog({ type: 'skipped', reason: action.reason, status, lastStatus })
    return
  }

  writeLog({ type: 'dispatching', status, agent, workspace })
  const notification = composeNotification(status, agent, event, context, config)
  await dispatchNotification(notification, config, showDesktopNotification)
  writeLog({ type: 'dispatched', status, agent, workspace })
}

async function main() {
  const config = loadNtfyConfig(process.env.HERDR_PLUGIN_CONFIG_DIR)
  const args = process.argv.slice(2)

  if (args.includes('--test')) {
    await runTestNotification(config)
    return
  }

  await handleAgentEvent(config)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Unhandled error:', err)
    process.exit(0)
  })
}
