// ─── Integration + unit tests for agent-notify ───────────────────────────────
// Runs the Herdr adapter in integration mode and unit-tests shared/ntfy.mjs.

import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import http from 'node:http'
import { loadEnv, loadNtfyConfig, resolveConfigDir, buildTags, isEnabled, buildAuthHeaders, isDesktopMode, isNtfyMode } from './shared/ntfy.mjs'
import { dispatchNotification } from './shared/notify.mjs'
import { publishToNtfy } from './shared/publish.mjs'
import { buildSimpleBody } from './shared/format.mjs'
import { detectGitBranch } from './shared/git.mjs'
import {
  parseEventEnv,
  parseContextEnv,
  extractStatus,
  extractAgent,
  extractWorkspaceContext,
  extractSupplementaryStatus,
} from './herdr/utils.mjs'
import { findPaneCwd } from './herdr/snapshot.mjs'
import { shouldNotify, updateState } from './herdr/state.mjs'
import {
  resolveNotifyState,
  forgetPane,
  isSettleAlreadyNotified,
  markPaneNotified,
} from './main.mjs'
import { getExtendedPathEnv } from './shared/env.mjs'
import {
  resolveConfig as resolveDashboardConfig,
  isAllowedHost,
  isDirectInvocation,
  formatListenError,
} from './dashboard.mjs'
import { resolveDashboardPort } from './shared/config.mjs'
import {
  normalizeAgentStatus,
  parseHerdrAgent,
  parseOrcaAgent,
  getLiveAgents,
  resolveBranch,
} from './shared/catalog.mjs'
import {
  buildSystemdUnit,
  buildLaunchdPlist,
  buildWindowsVbs,
  getServicePlatform,
  resolveServiceRuntime,
  buildVersionLabel,
  fetchUpdateStatus,
  checkUpdateStatusAsync,
  nonInteractiveGitEnv,
} from './shared/service.mjs'

const results = { pass: 0, fail: 0, total: 0 }
const dashboardPath = fileURLToPath(new URL('./dashboard.mjs', import.meta.url))

function assert(condition, label) {
  results.total++
  if (condition) {
    results.pass++
    console.log(`  ✓ ${label}`)
  } else {
    results.fail++
    console.error(`  ✗ ${label}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests: Herdr adapter
// ─────────────────────────────────────────────────────────────────────────────

const integrationCases = [
  {
    name: 'Herdr: Agent Done (Standard)',
    env: {
      HERDR_SESSION: 'dev-session',
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        event: 'pane.agent_status_changed',
        data: {
          type: 'pane_agent_status_changed',
          pane_id: 'p1',
          workspace_id: 'my-project',
          agent_status: 'done',
          agent: 'Codex',
          title: 'Refactor login controller',
        },
      }),
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_workspace: 'my-project',
        focused_pane_tab: 'editor',
        focused_pane_id: 'p1',
      }),
    },
  },
  {
    name: 'Herdr: Agent Blocked (Question / Prompt)',
    env: {
      HERDR_SESSION: 'infra-deploy',
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        event: 'pane.agent_status_changed',
        data: {
          type: 'pane_agent_status_changed',
          pane_id: 'p2',
          workspace_id: 'deployment-infra',
          agent_status: 'blocked',
          agent: 'Hermes',
          custom_status: 'Invalid credentials for AWS. Please provide valid AWS_ACCESS_KEY_ID.',
        },
      }),
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_workspace: 'deployment-infra',
        focused_pane_tab: 'TUI',
        focused_pane_id: 'p2',
      }),
    },
  },
  {
    name: 'Herdr: Agent Blocked (Error match)',
    env: {
      HERDR_SESSION: 'web-testing',
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        event: 'pane.agent_status_changed',
        data: {
          type: 'pane_agent_status_changed',
          pane_id: 'p3',
          workspace_id: 'web-app',
          agent_status: 'blocked',
          agent: 'OMP',
          state_labels: {
            error: 'ReferenceError: x is not defined at index.js:10:15',
          },
        },
      }),
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_workspace: 'web-app',
        focused_pane_tab: 'tests',
        focused_pane_id: 'p3',
      }),
    },
  },
  {
    name: 'Herdr: Long Status Truncation',
    env: {
      HERDR_SESSION: 'heavy-work',
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        event: 'pane.agent_status_changed',
        data: {
          type: 'pane_agent_status_changed',
          pane_id: 'p4',
          workspace_id: 'docs-search',
          agent_status: 'blocked',
          agent: 'Librarian',
          custom_status: 'This is a very long error message that will definitely exceed the standard length boundary and trigger the truncation logic implemented in the notify.mjs script to verify it outputs exactly three dots at the end.',
        },
      }),
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_workspace: 'docs-search',
        focused_pane_tab: 'docs',
        focused_pane_id: 'p4',
      }),
    },
  },
  {
    name: 'Herdr: Agent working (should skip)',
    env: {
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        event: 'pane.agent_status_changed',
        data: { agent_status: 'working' },
      }),
    },
  },
]

function runIntegrationTests() {
  console.log('\nRunning Herdr integration tests...\n')
  for (const tc of integrationCases) {
    console.log(`  --> ${tc.name}`)
    try {
      execSync('node herdr/herdr-adapter.mjs --test', {
        env: { ...process.env, ...tc.env },
        stdio: 'pipe',
      })
      results.pass++
      results.total++
      console.log('      ✓ completed')
    } catch (err) {
      results.fail++
      results.total++
      console.error(`      ✗ failed: ${err.message}`)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests: shared/ntfy.mjs
// ─────────────────────────────────────────────────────────────────────────────

async function runUnitTests() {
  console.log('\nRunning shared/ntfy.mjs unit tests...\n')

  // ── loadEnv ──
  const tmpFile1 = path.join(os.tmpdir(), `ntfy-test-1-${Date.now()}.env`)
  const tmpFile2 = path.join(os.tmpdir(), `ntfy-test-2-${Date.now()}.env`)
  const tmpFile3 = path.join(os.tmpdir(), `ntfy-test-3-${Date.now()}.env`)

  fs.writeFileSync(tmpFile1, 'FOO=bar\nBAZ=qux\n')
  fs.writeFileSync(tmpFile2, 'FOO="bar"\nBAZ=\'qux\'\n')
  fs.writeFileSync(tmpFile3, '# comment\n\nFOO=bar\n')

  assert(JSON.stringify(loadEnv(null)) === '{}', 'loadEnv(null) returns {}')
  assert(JSON.stringify(loadEnv('/nonexistent')) === '{}', 'loadEnv(missing) returns {}')
  assert(loadEnv(tmpFile1).FOO === 'bar', 'loadEnv parses unquoted value')
  assert(loadEnv(tmpFile1).BAZ === 'qux', 'loadEnv parses second unquoted value')
  assert(loadEnv(tmpFile2).FOO === 'bar', 'loadEnv strips double quotes')
  assert(loadEnv(tmpFile2).BAZ === 'qux', 'loadEnv strips single quotes')
  assert(loadEnv(tmpFile3).FOO === 'bar', 'loadEnv skips comments/blank lines')
  assert(Object.keys(loadEnv(tmpFile3)).length === 1, 'loadEnv ignores only comments/blanks')

  fs.unlinkSync(tmpFile1)
  fs.unlinkSync(tmpFile2)
  fs.unlinkSync(tmpFile3)

  // ── loadNtfyConfig ──
  const savedEnv = {
    PLATFORM_DESKTOP: process.env.PLATFORM_DESKTOP,
    PLATFORM_NTFY: process.env.PLATFORM_NTFY,
    NTFY_URL: process.env.NTFY_URL,
    NTFY_TOPIC: process.env.NTFY_TOPIC,
    NTFY_API_KEY: process.env.NTFY_API_KEY,
  }
  delete process.env.PLATFORM_DESKTOP
  delete process.env.PLATFORM_NTFY
  delete process.env.NTFY_URL
  delete process.env.NTFY_TOPIC
  delete process.env.NTFY_API_KEY

  const defaults = loadNtfyConfig()
  assert(defaults.PLATFORM_DESKTOP === true, 'loadNtfyConfig default desktop enabled')
  assert(defaults.PLATFORM_NTFY === false, 'loadNtfyConfig default ntfy disabled')
  assert(defaults.NTFY_URL === 'http://localhost:10081', 'loadNtfyConfig default URL')
  assert(defaults.NTFY_TOPIC === 'agent-alerts', 'loadNtfyConfig default topic')
  assert(defaults.NTFY_API_KEY === '', 'loadNtfyConfig default api key')

  process.env.PLATFORM_DESKTOP = 'false'
  process.env.PLATFORM_NTFY = 'true'
  process.env.NTFY_URL = 'https://ntfy.example.com'
  process.env.NTFY_TOPIC = 'custom-topic'
  process.env.NTFY_API_KEY = 'tok'
  const overridden = loadNtfyConfig()
  assert(overridden.PLATFORM_DESKTOP === false, 'loadNtfyConfig env desktop override')
  assert(overridden.PLATFORM_NTFY === true, 'loadNtfyConfig env ntfy override')
  assert(overridden.NTFY_URL === 'https://ntfy.example.com', 'loadNtfyConfig env URL override')
  assert(overridden.NTFY_TOPIC === 'custom-topic', 'loadNtfyConfig env topic override')
  assert(overridden.NTFY_API_KEY === 'tok', 'loadNtfyConfig env api key override')

  // configDir .env overrides defaults but not env vars
  delete process.env.NTFY_TOPIC
  delete process.env.NTFY_URL
  const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntfy-config-'))
  const tmpConfigEnv = path.join(tmpConfigDir, '.env')
  fs.writeFileSync(tmpConfigEnv, 'NTFY_TOPIC=from-config-dir\n')
  const fromDir = loadNtfyConfig(tmpConfigDir)
  assert(fromDir.NTFY_TOPIC === 'from-config-dir', 'loadNtfyConfig configDir .env')
  assert(fromDir.NTFY_URL === 'http://localhost:10081', 'loadNtfyConfig configDir default')
  fs.unlinkSync(tmpConfigEnv)
  fs.rmdirSync(tmpConfigDir)

  // Orca layout: hashed package root first, durable dev/.env second
  const orcaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-plugin-home-'))
  const hashedRoot = path.join(orcaHome, 'contenthash')
  const durableDev = path.join(orcaHome, 'dev')
  fs.mkdirSync(hashedRoot)
  fs.mkdirSync(durableDev)
  fs.writeFileSync(path.join(durableDev, '.env'), 'PLATFORM_NTFY=true\nNTFY_TOPIC=orca-dev\n')
  const resolvedDev = resolveConfigDir([hashedRoot, durableDev, orcaHome], durableDev)
  assert(resolvedDev === durableDev, 'resolveConfigDir prefers durable dev/.env')
  const orcaConfig = loadNtfyConfig(resolvedDev)
  assert(orcaConfig.PLATFORM_NTFY === true, 'orca durable .env enables ntfy')
  assert(orcaConfig.NTFY_TOPIC === 'orca-dev', 'orca durable .env topic')
  // package-local .env wins when present
  fs.writeFileSync(path.join(hashedRoot, '.env'), 'PLATFORM_NTFY=false\nNTFY_TOPIC=package-local\n')
  const resolvedPackage = resolveConfigDir([hashedRoot, durableDev, orcaHome], durableDev)
  assert(resolvedPackage === hashedRoot, 'resolveConfigDir prefers package-local .env')
  fs.rmSync(orcaHome, { recursive: true, force: true })

  Object.assign(process.env, savedEnv)

  // ── buildAuthHeaders ──
  assert(JSON.stringify(buildAuthHeaders('')) === '{}', 'buildAuthHeaders empty returns {}')
  assert(buildAuthHeaders('mytoken')['Authorization'] === 'Bearer mytoken', 'buildAuthHeaders bearer token')
  assert(buildAuthHeaders('user:pass')['Authorization'].startsWith('Basic '), 'buildAuthHeaders basic token')

  // ── isEnabled ──
  assert(isEnabled() === true, 'isEnabled default')
  assert(isEnabled({}) === true, 'isEnabled with config')

  // ── buildTags ──
  const tagsDone = buildTags('done', 'Codex', 'task complete')
  assert(tagsDone.includes('white_check_mark'), 'buildTags(done) has white_check_mark')
  assert(tagsDone.includes('scroll'), 'buildTags(Codex) has scroll')
  assert(!tagsDone.includes('warning'), 'buildTags(done) has no warning')

  const tagsQuestion = buildTags('blocked', 'Hermes', 'What should I do?')
  assert(tagsQuestion.includes('question'), 'buildTags(blocked, ?) has question')
  assert(tagsQuestion.includes('speech_balloon'), 'buildTags(Hermes) has speech_balloon')

  const tagsError = buildTags('blocked', 'OMP', 'ReferenceError: x not defined')
  assert(tagsError.includes('x'), 'buildTags(blocked, error) has x')
  assert(tagsError.includes('tools'), 'buildTags(OMP) has tools')

  const tagsWarning = buildTags('blocked', 'Pi', 'Waiting for approval')
  assert(tagsWarning.includes('warning'), 'buildTags(blocked, plain) has warning')
  assert(tagsWarning.includes('tools'), 'buildTags(Pi) has tools')

  const tagsTest = buildTags('done', 'Runner', 'Run tests')
  assert(tagsTest.includes('test_tube'), 'buildTags(text includes test) has test_tube')

  // ── notification mode helpers ──
  assert(isDesktopMode({ PLATFORM_DESKTOP: true }) === true, 'isDesktopMode(enabled)')
  assert(isDesktopMode({ PLATFORM_DESKTOP: false }) === false, 'isDesktopMode(disabled)')
  assert(isNtfyMode({ PLATFORM_NTFY: true }) === true, 'isNtfyMode(enabled)')
  assert(isNtfyMode({ PLATFORM_NTFY: false }) === false, 'isNtfyMode(disabled)')

  // ── buildSimpleBody ──
  assert(buildSimpleBody('done', '/home/user/project', 'main') === 'done · /home/user/project · (main)', 'buildSimpleBody full')
  assert(buildSimpleBody('blocked', '/home/user/project') === 'blocked · /home/user/project', 'buildSimpleBody no branch')
  assert(buildSimpleBody('done') === 'done', 'buildSimpleBody minimal')

  // ── dispatchNotification ──
  let desktopCalled = false
  let desktopTitle = ''
  let desktopBody = ''
  await dispatchNotification(
    { title: 'Test', body: 'Body' },
    { PLATFORM_DESKTOP: true, PLATFORM_NTFY: false },
    (title, body) => {
      desktopCalled = true
      desktopTitle = title
      desktopBody = body
    }
  )
  assert(desktopCalled === true, 'dispatchNotification desktop calls showDesktop')
  assert(desktopTitle === 'Test', 'dispatchNotification passes title')
  assert(desktopBody === 'Body', 'dispatchNotification passes body')

  // ntfy platform skips desktop
  let ntfyDesktopCalled = false
  await dispatchNotification(
    { title: 'Test', body: 'Body' },
    { PLATFORM_DESKTOP: false, PLATFORM_NTFY: true, NTFY_URL: 'http://localhost:10081' },
    () => { ntfyDesktopCalled = true }
  )
  assert(ntfyDesktopCalled === false, 'dispatchNotification ntfy skips desktop')

  // both platforms: desktop still fires even when ntfy is unreachable
  let bothDesktopCalled = false
  const bothResults = await dispatchNotification(
    { title: 'Test', body: 'Body' },
    { PLATFORM_DESKTOP: true, PLATFORM_NTFY: true, NTFY_URL: 'http://127.0.0.1:1', NTFY_TOPIC: 'agent-alerts' },
    () => { bothDesktopCalled = true }
  )
  assert(bothDesktopCalled === true, 'dispatchNotification both calls desktop')
  assert(bothResults.desktop?.ok === true, 'dispatchNotification desktop result ok')
  assert(bothResults.ntfy?.ok === false, 'dispatchNotification ntfy result fails independently')

  // ── publishToNtfy via local HTTP server (node:http path) ──
  const missing = await publishToNtfy({ title: 'x', body: 'y', config: {} })
  assert(missing.ok === false, 'publishToNtfy missing NTFY_URL fails')

  let received = null
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      received = {
        method: req.method,
        url: req.url,
        title: req.headers.title,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const published = await publishToNtfy({
    title: 'Smoke',
    body: 'hello-ntfy',
    tags: 'test_tube',
    priority: '4',
    config: {
      NTFY_URL: `http://127.0.0.1:${port}`,
      NTFY_TOPIC: 'agent-alerts',
      NTFY_API_KEY: '',
    },
  })
  server.close()
  assert(published.ok === true, 'publishToNtfy local server succeeds')
  assert(received?.method === 'POST', 'publishToNtfy posts')
  assert(received?.url === '/agent-alerts', 'publishToNtfy uses topic path')
  assert(received?.title === 'Smoke', 'publishToNtfy sends title header')
  assert(received?.body === 'hello-ntfy', 'publishToNtfy sends body')

  // ── detectGitBranch ──
  const tmpGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-git-'))
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
  execSync('git init', { cwd: tmpGitDir, stdio: 'ignore' })
  execSync('git checkout -b test-branch', { cwd: tmpGitDir, stdio: 'ignore', env: gitEnv })
  execSync('git commit --allow-empty -m init', { cwd: tmpGitDir, stdio: 'ignore', env: gitEnv })
  assert(detectGitBranch(tmpGitDir) === 'test-branch', 'detectGitBranch reads branch')
  assert(detectGitBranch('/nonexistent') === '', 'detectGitBranch missing dir')
  fs.rmSync(tmpGitDir, { recursive: true, force: true })
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests: herdr/herdr-adapter.mjs helpers
// ─────────────────────────────────────────────────────────────────────────────

async function runHerdrUnitTests() {
  console.log('\nRunning herdr/herdr-adapter.mjs unit tests...\n')

  // parseEventEnv / parseContextEnv
  process.env.HERDR_PLUGIN_EVENT_JSON = JSON.stringify({ event: 'pane.agent_status_changed', data: { agent_status: 'done' } })
  process.env.HERDR_PLUGIN_CONTEXT_JSON = JSON.stringify({ focused_pane_workspace: 'w' })
  assert(extractStatus(parseEventEnv(), parseContextEnv()) === 'done', 'extractStatus reads event data')
  assert(extractAgent(parseEventEnv(), parseContextEnv()) === 'Agent', 'extractAgent default')
  delete process.env.HERDR_PLUGIN_EVENT_JSON
  delete process.env.HERDR_PLUGIN_CONTEXT_JSON

  assert(extractStatus({}, { focused_pane_status: 'blocked' }) === 'blocked', 'extractStatus fallback to context')
  assert(extractAgent({ data: { agent: 'Pi' } }, {}) === 'Pi', 'extractAgent from event')
  assert(extractAgent({ data: { display_agent: 'Display' } }, {}) === 'Display', 'extractAgent prefers display_agent')

  // A workspace label is not a path: the adapter resolves this value as a
  // directory and runs git in it, so a label must never be returned here.
  const ws = extractWorkspaceContext({ data: { workspace: 'repo', tab: 'editor', pane_id: 'p1' } }, {})
  assert(ws.workspace === '', 'extractWorkspaceContext ignores the workspace label')
  assert(ws.tab === 'editor', 'extractWorkspaceContext tab')
  assert(ws.paneId === 'p1', 'extractWorkspaceContext paneId')

  const wsLabels = extractWorkspaceContext(
    { data: { pane_id: 'wG5:p3' } },
    { workspace_label: 'my-project', focused_pane_workspace: 'my-project', workspace: 'my-project' }
  )
  assert(wsLabels.workspace === '', 'extractWorkspaceContext ignores label-only context')

  // With no event pane id there is nothing to match against, so the focused
  // pane's cwd is not evidence and the snapshot lookup has to decide instead.
  const wsUnprovenPane = extractWorkspaceContext(
    { data: {} },
    { focused_pane_id: 'wG5:p3', focused_pane_cwd: '/home/user/focused-project' }
  )
  assert(
    wsUnprovenPane.workspace === '',
    'extractWorkspaceContext needs the event pane to accept focused_pane_cwd'
  )
  assert(
    wsUnprovenPane.paneId === 'wG5:p3',
    'extractWorkspaceContext still reports the context pane for the snapshot lookup'
  )

  const wsHerdrCwd = extractWorkspaceContext(
    { data: { pane_id: 'wG5:p3' } },
    { workspace_cwd: '/home/user/project', tab_label: 'terminal 1' }
  )
  assert(wsHerdrCwd.workspace === '/home/user/project', 'extractWorkspaceContext Herdr workspace_cwd')
  assert(wsHerdrCwd.tab === 'terminal 1', 'extractWorkspaceContext Herdr tab_label')
  assert(wsHerdrCwd.paneId === 'wG5:p3', 'extractWorkspaceContext Herdr pane_id')

  const wsFocusedCwd = extractWorkspaceContext(
    { data: { pane_id: 'wG5:p3' } },
    { focused_pane_id: 'wG5:p3', focused_pane_cwd: '/home/user/focused-project' }
  )
  assert(wsFocusedCwd.workspace === '/home/user/focused-project', 'extractWorkspaceContext Herdr focused_pane_cwd when pane matches')

  // When focused_pane_id does NOT match the event pane, focused_pane_cwd must be ignored.
  const wsMismatchedPane = extractWorkspaceContext(
    { data: { pane_id: 'wG5:p3' } },
    { focused_pane_id: 'wG5:other', focused_pane_cwd: '/home/user/other-project' }
  )
  assert(wsMismatchedPane.workspace === '', 'extractWorkspaceContext ignores focused_pane_cwd when pane ID mismatches')

  const sup = extractSupplementaryStatus({ data: { custom_status: 'cs', title: 't', state_labels: { error: 'e' } } }, {})
  assert(sup.customStatus === 'cs', 'extractSupplementaryStatus custom_status')
  assert(sup.error === 'e', 'extractSupplementaryStatus error')
  assert(sup.title === 't', 'extractSupplementaryStatus title')

  // findPaneCwd
  assert(findPaneCwd(null, 'p1') === '', 'findPaneCwd null snapshot')
  assert(findPaneCwd({}, 'p1') === '', 'findPaneCwd empty snapshot')
  assert(findPaneCwd({ panes: [] }, 'p1') === '', 'findPaneCwd no panes match')
  assert(
    findPaneCwd({ panes: [{ pane_id: 'p1', cwd: '/a' }] }, 'p1') === '/a',
    'findPaneCwd matches pane_id cwd'
  )
  assert(
    findPaneCwd({ panes: [{ pane_id: 'p1', foreground_cwd: '/b' }] }, 'p1') === '/b',
    'findPaneCwd falls back to foreground_cwd'
  )
  assert(
    findPaneCwd({ panes: [{ pane_id: 'p1', cwd: '/a', foreground_cwd: '/b' }] }, 'p1') === '/a',
    'findPaneCwd prefers cwd'
  )
  assert(
    findPaneCwd(
      { panes: [{ pane_id: 'p1', cwd: '/a' }, { pane_id: 'p2', cwd: '/b' }] },
      'p2'
    ) === '/b',
    'findPaneCwd finds correct pane'
  )

  // shouldNotify
  assert(shouldNotify('done', 'p1', {}) === false, 'shouldNotify skips initial done')
  assert(shouldNotify('done', 'p1', { p1: 'working' }) === true, 'shouldNotify notifies working->done')
  assert(shouldNotify('done', 'p1', { p1: 'done' }) === false, 'shouldNotify skips done->done')
  assert(shouldNotify('blocked', 'p1', {}) === true, 'shouldNotify notifies initial blocked')
  assert(shouldNotify('blocked', 'p1', { p1: 'working' }) === true, 'shouldNotify notifies working->blocked')
  assert(shouldNotify('blocked', 'p1', { p1: 'blocked' }) === false, 'shouldNotify skips blocked->blocked')
  assert(shouldNotify('working', 'p1', {}) === false, 'shouldNotify never notifies working')

  // updateState
  const us = {}
  updateState(us, 'p1', 'working')
  assert(us.p1 === 'working', 'updateState stores working')
  updateState(us, 'p1', 'waiting')
  assert(us.p1 === 'working', 'updateState ignores waiting')
}

function runOrcaMainUnitTests() {
  console.log('\nRunning main.mjs (Orca plugin) unit tests...\n')

  // Gate on the main agent's own state; subagent processes never drive a
  // notification on their own.
  assert(
    resolveNotifyState({ state: 'working', mainAgent: { state: 'done', stateStartedAt: 1 } }) === 'done',
    'resolveNotifyState prefers mainAgent state over combined'
  )
  assert(
    resolveNotifyState({ state: 'done' }) === 'done',
    'resolveNotifyState falls back to combined state without mainAgent'
  )
  assert(
    resolveNotifyState({ state: 'DONE', mainAgent: { state: 'Blocked', stateStartedAt: 1 } }) === 'blocked',
    'states are lowercased before comparison'
  )
  assert(
    resolveNotifyState({}) === '',
    'empty payload resolves to empty (not a notify state)'
  )

  // Per-pane settle de-dupe: a subagent finishing re-emits the row while the
  // main agent already settled; that must not re-notify.
  const pane = 'tab:leaf'
  assert(isSettleAlreadyNotified(pane, 'done') === false, 'fresh pane is not de-duped')
  markPaneNotified(pane, 'done')
  assert(isSettleAlreadyNotified(pane, 'done') === true, 'same settle state de-duped')
  assert(isSettleAlreadyNotified(pane, 'blocked') === false, 'different state is not de-duped')
  assert(isSettleAlreadyNotified('', 'done') === false, 'empty paneKey never de-dupes')
  forgetPane(pane)
  assert(isSettleAlreadyNotified(pane, 'done') === false, 'forgotten pane notifies again')
}

async function runDashboardUnitTests() {
  console.log('\nRunning dashboard.mjs unit tests...\n')

  const env = getExtendedPathEnv(['/nonexistent/test/path'])
  assert(typeof env.PATH === 'string', 'getExtendedPathEnv returns PATH')

  assert(
    resolveDashboardConfig(['node', 'dashboard.mjs', '--port', '4567'], {}).port === 4567,
    'resolveDashboardConfig --port <n>'
  )
  assert(
    resolveDashboardConfig(['node', 'dashboard.mjs', '--port=7890'], {}).port === 7890,
    'resolveDashboardConfig --port=<n>'
  )
  assert(
    resolveDashboardConfig(['node', 'dashboard.mjs'], { DASHBOARD_PORT: '5555' }).port === 5555,
    'resolveDashboardConfig DASHBOARD_PORT env'
  )
  assert(
    resolveDashboardConfig(['node', 'dashboard.mjs', '--port', '99999'], {}, {}).port === 3333,
    'resolveDashboardConfig rejects out-of-range port'
  )
  assert(
    resolveDashboardPort(['node', 'dashboard.mjs'], { DASHBOARD_PORT: '4002' }, { DASHBOARD_PORT: '4001' }) === 4002,
    'resolveDashboardPort prefers the environment to the file'
  )
  assert(
    resolveDashboardPort(['node', 'dashboard.mjs'], {}, { DASHBOARD_PORT: '4001' }) === 4001,
    'resolveDashboardPort reads the .env fallback'
  )
  assert(
    resolveDashboardPort(['node', 'dashboard.mjs', '--port', '4003'], {}, {}) === 4003,
    'resolveDashboardPort prefers the flag'
  )

  // A launch through a symlink (or an npm/npx shim) must still start the server
  // instead of resolving argv[1] to the link and exiting 0 without a word.
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-link-'))
  const linkPath = path.join(linkDir, 'dashboard-link.mjs')
  fs.symlinkSync(dashboardPath, linkPath)
  assert(isDirectInvocation(['node', linkPath]), 'isDirectInvocation follows a symlinked entry point')
  assert(isDirectInvocation(['node', dashboardPath]), 'isDirectInvocation accepts the real path')
  assert(
    !isDirectInvocation(['node', path.join(linkDir, 'other.mjs')]),
    'isDirectInvocation rejects another file'
  )
  assert(!isDirectInvocation(['node']), 'isDirectInvocation rejects a missing argv[1]')
  assert(
    !isDirectInvocation(['node', path.join(linkDir, 'gone.mjs')]),
    'isDirectInvocation rejects an unresolvable path'
  )

  assert(formatListenError({ code: 'EADDRINUSE' }, 3333).includes('3333'), 'formatListenError names the busy port')
  assert(/already in use/.test(formatListenError({ code: 'EADDRINUSE' }, 3333)), 'formatListenError explains a busy port')
  assert(/Not allowed/.test(formatListenError({ code: 'EACCES' }, 80)), 'formatListenError explains a privileged port')
  assert(
    formatListenError(new Error('boom'), 3333).includes('boom'),
    'formatListenError falls back to the error message'
  )

  assert(isAllowedHost('localhost:3333'), 'isAllowedHost accepts localhost with port')
  assert(isAllowedHost('127.0.0.1:3333'), 'isAllowedHost accepts loopback ip')
  assert(isAllowedHost('[::1]:3333'), 'isAllowedHost accepts ipv6 loopback')
  assert(!isAllowedHost('evil.example.com:3333'), 'isAllowedHost rejects external host')
  assert(!isAllowedHost('localhost.evil.com'), 'isAllowedHost rejects host suffix trick')
  assert(!isAllowedHost(undefined), 'isAllowedHost rejects missing host')

  assert(normalizeAgentStatus('WORKING') === 'working', 'normalizeAgentStatus working')
  assert(normalizeAgentStatus('blocked') === 'blocked', 'normalizeAgentStatus blocked')
  assert(normalizeAgentStatus('Done') === 'done', 'normalizeAgentStatus done')
  assert(normalizeAgentStatus('idle') === 'idle', 'normalizeAgentStatus idle')
  assert(normalizeAgentStatus('unknown') === 'idle', 'normalizeAgentStatus fallback')

  const herdrAgent = parseHerdrAgent({
    pane_id: 'p1',
    agent: 'pi',
    agent_status: 'working',
    cwd: '/path/to/herdr',
    terminal_title: 'Title',
    focused: true,
  })
  assert(herdrAgent.source === 'herdr', 'parseHerdrAgent source')
  assert(herdrAgent.status === 'working', 'parseHerdrAgent status')
  assert(herdrAgent.cwd === '/path/to/herdr', 'parseHerdrAgent cwd')
  assert(herdrAgent.displayName === 'Title', 'parseHerdrAgent displayName')

  const orcaAgent = parseOrcaAgent(
    { path: '/path/to/orca', displayName: 'Orca Repo', branch: 'refs/heads/feature' },
    { paneKey: 'k1', agentType: 'claude', state: 'done', prompt: 'hi' }
  )
  assert(orcaAgent.source === 'orca', 'parseOrcaAgent source')
  assert(orcaAgent.status === 'done', 'parseOrcaAgent status')
  assert(orcaAgent.cwd === '/path/to/orca', 'parseOrcaAgent cwd')
  assert(orcaAgent.branch === 'feature', 'parseOrcaAgent branch stripped')
  assert(orcaAgent.prompt === 'hi', 'parseOrcaAgent prompt')

  // Untrusted CLI payloads: wrong-typed or missing fields must degrade, not throw.
  const malformedHerdr = parseHerdrAgent({ agent_status: { nope: true }, pane_id: 42, cwd: null, terminal_title: 7 })
  assert(malformedHerdr.id === 'herdr-42', 'parseHerdrAgent keeps a numeric pane id distinct')
  assert(malformedHerdr.status === 'idle' && malformedHerdr.cwd === '', 'parseHerdrAgent coerces bad status and cwd')
  assert(parseHerdrAgent(null).id === 'herdr-pane', 'parseHerdrAgent survives a null element')

  assert(parseOrcaAgent(null, null).id === 'orca-pane', 'parseOrcaAgent survives a null worktree and agent')
  assert(parseOrcaAgent({ branch: 42 }, {}).branch === '', 'parseOrcaAgent rejects a non-string branch')
  assert(parseOrcaAgent({}, { prompt: 99 }).prompt === null, 'parseOrcaAgent rejects a non-string prompt')

  // Service & Update tests
  assert(getServicePlatform() === process.platform, 'getServicePlatform matches process.platform')
  assert(resolveServiceRuntime('/custom/bun').includes('bun'), 'resolveServiceRuntime detects bun')
  assert(typeof resolveServiceRuntime() === 'string', 'resolveServiceRuntime returns string')

  const systemd = buildSystemdUnit('/usr/bin/node', '/path/dashboard.mjs', '/path')
  assert(systemd.includes('ExecStart=/usr/bin/node /path/dashboard.mjs'), 'buildSystemdUnit ExecStart')
  assert(systemd.includes('WorkingDirectory=/path'), 'buildSystemdUnit WorkingDirectory')

  // A path with spaces must stay one argv element; % is a systemd specifier.
  const spaced = buildSystemdUnit('/opt/my node/node', '/repo dir/dashboard.mjs', '/repo dir')
  assert(spaced.includes('ExecStart="/opt/my node/node" "/repo dir/dashboard.mjs"'), 'buildSystemdUnit quotes argv with spaces')
  // `WorkingDirectory=` takes no quoting: a quoted value is rejected by systemd as
  // "not absolute", while a bare space is preserved.
  assert(spaced.includes('WorkingDirectory=/repo dir'), 'buildSystemdUnit leaves a spaced working directory bare')
  assert(buildSystemdUnit('/usr/bin/node', '/path/100%.mjs', '/path').includes('100%%.mjs'), 'buildSystemdUnit escapes % specifiers')
  assert(
    buildSystemdUnit('/usr/bin/node', '/path/a$b.mjs', '/path').includes('ExecStart=/usr/bin/node "/path/a$$b.mjs"'),
    'buildSystemdUnit escapes $ expansion in ExecStart'
  )
  assert(
    buildSystemdUnit('/usr/bin/node', '/path/x.mjs', '/path/a$b').includes('WorkingDirectory=/path/a$b'),
    'buildSystemdUnit leaves a literal $ alone in WorkingDirectory'
  )
  let newlineRejected = false
  try {
    buildSystemdUnit('/usr/bin/node', '/path/x.mjs', '/path\nExecStartPre=/bin/true')
  } catch {
    newlineRejected = true
  }
  assert(newlineRejected, 'buildSystemdUnit refuses a newline instead of injecting a directive')
  let backslashRejected = false
  try {
    buildSystemdUnit('/usr/bin/node', '/path/x.mjs', '/path/ends-with\\')
  } catch {
    backslashRejected = true
  }
  assert(backslashRejected, 'buildSystemdUnit refuses a working directory ending in a backslash')

  const plist = buildLaunchdPlist('/usr/bin/node', '/path/dashboard.mjs', '/path')
  assert(plist.includes('<string>dev.agent-notify.dashboard</string>'), 'buildLaunchdPlist label')
  assert(plist.includes('<string>/usr/bin/node</string>'), 'buildLaunchdPlist node')
  assert(
    buildLaunchdPlist('/usr/bin/node', '/path/a&b.mjs', '/path<c>').includes('/path/a&amp;b.mjs'),
    'buildLaunchdPlist escapes XML in paths'
  )

  const vbs = buildWindowsVbs('C:\\node.exe', 'C:\\dashboard.mjs')
  assert(vbs.includes('WshShell.Run'), 'buildWindowsVbs Run')

  // No remote configured, so this stays offline: it must report a git checkout
  // it cannot resolve, rather than reaching out to the network.
  const tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-update-'))
  execSync('git init', { cwd: tmpRepoDir, stdio: 'ignore' })
  const updateStatus = fetchUpdateStatus(tmpRepoDir)
  assert(typeof updateStatus === 'object', 'fetchUpdateStatus returns object')
  assert(updateStatus.isGit === true, 'fetchUpdateStatus isGit')
  assert(updateStatus.hasUpdate === false, 'fetchUpdateStatus reports no update without a target')
  assert(Boolean(updateStatus.unavailable), 'fetchUpdateStatus explains the missing target')
  assert(fetchUpdateStatus('/nonexistent').isGit === false, 'fetchUpdateStatus non-git directory')

  // The dashboard route must not run the probe on its event loop. A 0ms timer
  // proves the loop kept running while the probe was in flight: with a
  // synchronous probe the timer is cancelled before it can fire, because the
  // awaiting continuation is a microtask that runs first. The probe entry is the
  // real dashboard script, but the target is a non-git temp directory, so the
  // child re-enters the script and the check stays offline.
  let loopRanWhileProbing = false
  const probeTimer = setTimeout(() => {
    loopRanWhileProbing = true
  }, 0)
  const firstStatus = await checkUpdateStatusAsync(linkDir, [dashboardPath])
  clearTimeout(probeTimer)
  assert(firstStatus.isGit === false, 'checkUpdateStatusAsync reports a non-git directory')
  assert(typeof firstStatus.checkedAt === 'number', 'checkUpdateStatusAsync returns a status with checkedAt')
  assert(loopRanWhileProbing, 'checkUpdateStatusAsync does not block the event loop')
  assert(
    (await checkUpdateStatusAsync(linkDir, [dashboardPath])) === firstStatus,
    'checkUpdateStatusAsync serves a repeat call from cache'
  )

  // Installing must restart an already-running unit: `enable --now` leaves a
  // running unit on its previous definition, so reinstalling after an edit would
  // keep serving the old ExecStart. A fake systemctl on PATH records the calls it
  // receives, so the real install path runs without touching the user's units.
  if (getServicePlatform() === 'linux') {
    const runInstall = (isActive) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-home-'))
      const binDir = path.join(home, 'bin')
      fs.mkdirSync(binDir, { recursive: true })
      const callsLog = path.join(home, 'calls.log')
      fs.writeFileSync(
        path.join(binDir, 'systemctl'),
        [
          '#!/bin/sh',
          `echo "$@" >> "${callsLog}"`,
          '[ "$2" = "is-active" ] && exit "${FAKE_IS_ACTIVE:-0}"',
          'exit 0',
          '',
        ].join('\n'),
        { mode: 0o755 }
      )
      const stdout = execSync(`"${process.execPath}" "${dashboardPath}" --service install`, {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          DASHBOARD_PORT: '4321',
          FAKE_IS_ACTIVE: isActive ? '0' : '3',
        },
      })
      return { calls: fs.readFileSync(callsLog, 'utf8'), stdout, home }
    }

    const freshInstall = runInstall(false)
    assert(freshInstall.calls.includes('--user daemon-reload'), 'service install reloads systemd units')
    assert(freshInstall.calls.includes('--user enable agent-monitor.service'), 'service install enables the unit')
    assert(freshInstall.calls.includes('--user start agent-monitor.service'), 'service install starts a stopped unit')
    assert(freshInstall.stdout.includes('http://localhost:4321'), 'service install reports the resolved port')
    assert(
      fs.existsSync(path.join(freshInstall.home, '.config', 'systemd', 'user', 'agent-monitor.service')),
      'service install writes the unit file'
    )

    const reinstall = runInstall(true)
    assert(reinstall.calls.includes('--user restart agent-monitor.service'), 'service install restarts an active unit')
    assert(
      !reinstall.calls.includes('--user start agent-monitor.service'),
      'service install does not start an already active unit'
    )
  }
  fs.rmSync(tmpRepoDir, { recursive: true, force: true })

  // This check runs inside the HTTP server: git must never sit on a credential
  // prompt there. Proven against real git rather than asserted: without the
  // guard git reaches for the terminal, with it git refuses outright.
  const promptProbe = (env) => {
    try {
      execSync('git -c credential.helper= credential fill', {
        input: 'protocol=https\nhost=agent-notify.invalid\n\n',
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      })
      return ''
    } catch (err) {
      return String(err.stderr || '')
    }
  }
  assert(
    nonInteractiveGitEnv().GIT_TERMINAL_PROMPT === '0',
    'nonInteractiveGitEnv disables terminal prompts'
  )
  assert(
    nonInteractiveGitEnv().GIT_ASKPASS === '',
    'nonInteractiveGitEnv clears GIT_ASKPASS'
  )
  assert(
    /terminal prompts disabled/.test(promptProbe(nonInteractiveGitEnv())),
    'git refuses to prompt for credentials with nonInteractiveGitEnv'
  )
  // getExtendedPathEnv() spreads process.env, so an askpass program set by the
  // caller would survive unless the guard overwrites it. /bin/echo satisfies
  // the fill when consulted, which makes a bypass observable instead of silent.
  const inheritedAskpass = process.env.GIT_ASKPASS
  process.env.GIT_ASKPASS = '/bin/echo'
  try {
    assert(
      /terminal prompts disabled/.test(promptProbe(nonInteractiveGitEnv())),
      'nonInteractiveGitEnv overrides an inherited GIT_ASKPASS'
    )
  } finally {
    if (inheritedAskpass === undefined) delete process.env.GIT_ASKPASS
    else process.env.GIT_ASKPASS = inheritedAskpass
  }

  assert(
    buildVersionLabel({ orca: '1.1.0', herdr: '0.3.0' }, { orca: '1.2.0', herdr: '0.4.0' }) ===
      'orca 1.1.0 → 1.2.0 · herdr 0.3.0 → 0.4.0',
    'buildVersionLabel both changed'
  )
  assert(
    buildVersionLabel({ orca: '1.1.0', herdr: '0.3.0' }, { orca: '1.2.0', herdr: '0.3.0' }) === 'orca 1.1.0 → 1.2.0',
    'buildVersionLabel only changed manifest'
  )
  assert(
    buildVersionLabel({ orca: '1.1.0', herdr: '0.3.0' }, { orca: '1.1.0', herdr: '0.3.0' }) === null,
    'buildVersionLabel unchanged returns null'
  )
  assert(buildVersionLabel({}, {}) === null, 'buildVersionLabel empty returns null')

  // Catalog tests
  const liveState = await getLiveAgents()
  assert(Array.isArray(liveState.agents), 'getLiveAgents returns agents array')
  assert(typeof liveState.sources === 'object', 'getLiveAgents returns sources object')
  // Callers that arrive together share one collection instead of spawning the
  // runtimes once per request.
  const [coalescedA, coalescedB] = await Promise.all([
    getLiveAgents({ forceFresh: true }),
    getLiveAgents({ forceFresh: true }),
  ])
  assert(coalescedA === coalescedB, 'getLiveAgents coalesces concurrent collections')

  // `herdr agent list` has no branch field, so the branch comes from the directory.
  const tmpBranchRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-branch-'))
  execSync('git init', { cwd: tmpBranchRepo, stdio: 'ignore' })
  execSync('git checkout -b branch-probe', { cwd: tmpBranchRepo, stdio: 'ignore' })
  execSync('git -c user.email=t@e.c -c user.name=t commit --allow-empty -m init', { cwd: tmpBranchRepo, stdio: 'ignore' })
  assert(resolveBranch(tmpBranchRepo) === 'branch-probe', 'resolveBranch reads the directory branch')
  assert(resolveBranch(tmpBranchRepo) === 'branch-probe', 'resolveBranch serves a repeat lookup from cache')
  assert(resolveBranch('/nonexistent') === '', 'resolveBranch missing directory')
  assert(resolveBranch('') === '', 'resolveBranch empty directory')
  fs.rmSync(tmpBranchRepo, { recursive: true, force: true })
  // Intentional: a removed directory keeps its branch for the cache TTL, and the
  // row it belonged to is gone long before that matters.
  assert(resolveBranch(tmpBranchRepo) === 'branch-probe', 'resolveBranch serves a deleted directory from cache')
  assert(resolveBranch(`${tmpBranchRepo}-never-cached`) === '', 'resolveBranch never-cached directory')
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  runIntegrationTests()
  await runUnitTests()
  await runHerdrUnitTests()
  runOrcaMainUnitTests()
  await runDashboardUnitTests()

  console.log(`\nResults: ${results.pass}/${results.total} passed, ${results.fail} failed`)
  if (results.fail > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Test runner error:', err)
  process.exit(1)
})
