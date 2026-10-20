// ─── Integration + unit tests for agent-notify ───────────────────────────────
// Runs the Herdr adapter in integration mode and unit-tests shared/ntfy.mjs.

import { execFileSync, execSync } from 'node:child_process'
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
  renderDashboardHtml,
  updateBannerLabel,
  nextAgentOrder,
} from './dashboard.mjs'
import { insideTile, insidePolygon, renderRgba, encodePng } from './tools/make-icons.mjs'
import { resolveDashboardPort } from './shared/config.mjs'

// The driver's recovery modules are loaded on demand. A syntax error in one of
// them must fail the recovery tests, not take the whole suite down with it:
// the suite is the thing that decides whether a mutation was caught, and it
// has to be able to report a broken recovery rather than vanish.
async function recoveryModules() {
  const [leftover, restore, lib] = await Promise.all([
    import('./.agents/skills/verify/scripts/leftover.mjs'),
    import('./.agents/skills/verify/scripts/restore.mjs'),
    import('./.agents/skills/verify/scripts/lib.mjs'),
  ])
  return { ...leftover, ...restore, ...lib }
}

// The catalogue is one of the modules the driver loads behind its gate, so it
// is loaded on demand for the same reason: a syntax error in it must fail the
// recovery tests rather than the whole suite.
let cataloguePromise = null
function loadCatalogue() {
  if (!cataloguePromise) {
    cataloguePromise = import('./.agents/skills/verify/scripts/mutations.mjs').then((m) => m.MUTATIONS)
  }
  return cataloguePromise
}
import {
  normalizeAgentStatus,
  parseHerdrAgent,
  parseOrcaAgent,
  getLiveAgents,
  resolveBranch,
  mapWithConcurrency,
  canonicalAgentName,
} from './shared/catalog.mjs'
import {
  buildSystemdUnit,
  buildLaunchdPlist,
  buildWindowsVbs,
  installDarwinService,
  writeUpdateCheckCache,
  getServicePlatform,
  resolveServiceRuntime,
  buildVersionLabel,
  fetchUpdateStatus,
  checkUpdateStatusAsync,
  nonInteractiveGitEnv,
  resolveTailscaleBin,
  enableTailscaleServe,
  tailscaleBinNames,
  resolveTailscaleHostname,
} from './shared/service.mjs'

const results = { pass: 0, fail: 0, total: 0 }
const dashboardPath = fileURLToPath(new URL('./dashboard.mjs', import.meta.url))
const catalogPath = fileURLToPath(new URL('./shared/catalog.mjs', import.meta.url))

// launchd installs run the real installer against a fake supervisor, so the
// supervisor's chatter is swallowed instead of interleaving with the report.
function captureConsole(fn) {
  const lines = []
  const realLog = console.log
  const realError = console.error
  console.log = (...parts) => lines.push(parts.join(' '))
  console.error = (...parts) => lines.push(parts.join(' '))
  try {
    fn()
  } finally {
    console.log = realLog
    console.error = realError
  }
  return lines
}

// Function.prototype.toString() is re-serialized by some runtimes (Bun emits its
// own formatting, semicolons included), so the function embedded in the page is
// sliced by matching braces instead of by a regex over its source.
function sliceEmbeddedFunction(source, prelude) {
  const start = source.indexOf(prelude)
  if (start === -1) return null
  const from = start + prelude.length
  let depth = 0
  let seenBrace = false
  for (let i = from; i < source.length; i++) {
    if (source[i] === '{') {
      depth++
      seenBrace = true
    } else if (source[i] === '}') {
      depth--
      if (seenBrace && depth === 0) return source.slice(from, i + 1)
    }
  }
  return null
}

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

// The update check's failure paths and the banner they feed. Kept out of the
// dashboard assertions above: the branching here is what makes a failed check
// readable, and it reads better as its own case.
async function assertUpdateFailureAndBanner() {

  // runtime with no process.execPath is the real case), so this promise rejects
  // rather than resolving null. /api/update awaits it with no catch, so a
  // rejection here would surface as a failed request instead of a status.
  const spawnFailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-nospawn-'))
  const realExecPath = process.execPath
  let spawnFailStatus = null
  let spawnFailRejected = null
  try {
    process.execPath = ''
    spawnFailStatus = await checkUpdateStatusAsync(spawnFailDir, [dashboardPath]).catch((err) => {
      spawnFailRejected = err
      return null
    })
  } finally {
    process.execPath = realExecPath
  }
  assert(spawnFailRejected === null, 'a probe that cannot spawn does not reject the update check')
  assert(
    spawnFailStatus?.unavailable === 'the update check could not run',
    'a probe that cannot spawn reports that the check could not run'
  )
  fs.rmSync(spawnFailDir, { recursive: true, force: true })

  // A stale status is one the dashboard could not refresh, so the banner has to
  // say that instead of looking like a check that just succeeded. The page embeds
  // the same function the tests call, so the two cannot drift apart.
  const dashboardHtml = renderDashboardHtml()
  assert(
    updateBannerLabel({ versionLabel: 'v1 → v2', stale: true }).endsWith('(last known, the update check could not run)'),
    'updateBannerLabel marks a stale status as last known'
  )
  assert(
    updateBannerLabel({ localSha: 'aaaaaaa', remoteSha: 'bbbbbbb' }) === 'aaaaaaa → bbbbbbb',
    'updateBannerLabel renders the revision pair'
  )
  assert(
    dashboardHtml.includes('.innerText = updateBannerLabel('),
    'the dashboard labels the update banner through it'
  )
  const embeddedLabel = sliceEmbeddedFunction(dashboardHtml, 'const updateBannerLabel = ')
  assert(embeddedLabel !== null, 'the dashboard embeds the update banner label')
  const pageLabel = new Function(`return ${embeddedLabel}`)()
  const staleCase = { localSha: 'aaaaaaa', remoteSha: 'bbbbbbb', stale: true }
  assert(
    pageLabel(staleCase) === updateBannerLabel(staleCase),
    'the embedded update banner label matches the tested one for a stale status'
  )
  const freshCase = { localSha: 'aaaaaaa', remoteSha: 'bbbbbbb' }
  assert(
    pageLabel(freshCase) === updateBannerLabel(freshCase),
    'the embedded update banner label matches the tested one for a fresh status'
  )

  // Rows keep the position they were first seen at, so a poll that returns the
  // agents in another order does not make the table jump around.
  assert(
    JSON.stringify(nextAgentOrder([], ['a', 'b', 'c'])) === JSON.stringify(['a', 'b', 'c']),
    'nextAgentOrder keeps the order the server sent for a fresh page'
  )
  assert(
    JSON.stringify(nextAgentOrder(['a', 'b', 'c'], ['c', 'a', 'b'])) === JSON.stringify(['a', 'b', 'c']),
    'nextAgentOrder keeps the first-seen order when a poll reorders the agents'
  )
  assert(
    JSON.stringify(nextAgentOrder(['a', 'b'], ['a', 'b', 'c'])) === JSON.stringify(['a', 'b', 'c']),
    'nextAgentOrder puts a new agent at the bottom'
  )
  // The order is historical state, so an agent that is gone must not keep a
  // slot: otherwise a long-lived page sorts rows for agents that no longer
  // exist and the list grows with everything ever seen.
  assert(
    JSON.stringify(nextAgentOrder(['a', 'b', 'c'], ['a', 'c'])) === JSON.stringify(['a', 'c']),
    'nextAgentOrder drops the agent that is gone'
  )
  assert(
    nextAgentOrder(['a', 'b', 'c'], ['a', 'c']).includes('b') === false,
    'the agent that is gone is not kept in the order'
  )
  assert(
    JSON.stringify(nextAgentOrder(['a', 'b'], ['b', 'c', 'a'])) === JSON.stringify(['a', 'b', 'c']),
    'nextAgentOrder keeps the surviving agents in place and appends the new one'
  )
  assert(
    JSON.stringify(nextAgentOrder([], [])) === JSON.stringify([]),
    'nextAgentOrder is empty when nothing is running'
  )
  assert(
    JSON.stringify(nextAgentOrder(['a', 'b'], [])) === JSON.stringify([]),
    'nextAgentOrder drops every id when the snapshot is empty'
  )

  // The page runs the same function the tests exercise, so the orders above are
  // the orders a browser actually draws.
  const embeddedOrder = sliceEmbeddedFunction(dashboardHtml, 'const nextAgentOrder = ')
  assert(embeddedOrder !== null, 'the dashboard embeds the row order function')
  const pageOrder = new Function(`return ${embeddedOrder}`)()
  const reordered = ['c', 'a', 'b']
  assert(
    JSON.stringify(pageOrder(['a', 'b', 'c'], reordered)) === JSON.stringify(nextAgentOrder(['a', 'b', 'c'], reordered)),
    'the embedded row order matches the tested one'
  )
  assert(
    dashboardHtml.includes('agentOrder = nextAgentOrder(agentOrder,'),
    'the page rebuilds the order through it on every poll'
  )
}

// The files that make the page installable. Chrome refuses to offer
// installation without a manifest, a worker and the icons the manifest names,
// so each of those is checked here rather than discovered on a phone.
function runPwaTests() {
  console.log('\nRunning PWA tests...\n')

  // The drawing that makes the icons, exercised directly: a committed PNG
  // nobody can regenerate is a binary, and these are what proves the glyph is
  // where the artwork says it is.
  assert(insideTile(0.5, 0.5, 0.22) === true, 'the middle of the icon tile is inside it')
  assert(insideTile(0.02, 0.02, 0.22) === false, 'the corner of the icon is outside the rounded tile')
  assert(insideTile(0.5, 0.02, 0.22) === true, 'the middle of an edge is inside the tile')
  assert(insidePolygon(0.5, 0.5, [[0, 0], [1, 0], [1, 1], [0, 1]]) === true, 'a point inside a square is inside it')
  assert(insidePolygon(1.5, 0.5, [[0, 0], [1, 0], [1, 1], [0, 1]]) === false, 'a point outside a square is outside it')
  // The bolt is drawn over the tile, so the centre pixel must be the accent
  // colour rather than the background, and the corner must stay transparent.
  const tiny = renderRgba(16)
  const pixel = (buf, size, x, y) => [...buf.subarray(1 + y * (1 + size * 4) + 1 + x * 4, 1 + y * (1 + size * 4) + 1 + x * 4 + 4)]
  assert(pixel(tiny, 16, 0, 0)[3] === 0, 'the icon corner is transparent')
  assert(pixel(tiny, 16, 8, 8).join() !== '0,0,0,0', 'the icon centre is drawn')
  const png = encodePng(8)
  assert(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'encodePng writes a PNG signature')
  assert(png.readUInt32BE(16) === 8 && png.readUInt32BE(20) === 8, 'encodePng writes the size it was given')

  const repoRoot = path.dirname(fileURLToPath(import.meta.url))
  const publicDir = path.join(repoRoot, 'public')
  // The nested-suite fixture copies only the files git tracks, and this group
  // reads files that live beside the suite. When the copy does not carry them,
  // say so and leave the assertions to the run that does, rather than throwing
  // and taking the suite's summary down with it.
  if (!fs.existsSync(path.join(publicDir, 'manifest.webmanifest'))) {
    console.log('  (PWA tests skipped: this copy of the repository has no public/ directory)')
    return
  }
  const dashboardHtml = renderDashboardHtml()

  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'))
  assert(manifest.name === 'Agent Monitor', 'the manifest names the app')
  assert(manifest.short_name, 'the manifest has a short name for a launcher')
  assert(manifest.start_url === '/', 'the manifest starts at the dashboard')
  assert(manifest.display === 'standalone', 'the manifest asks for a standalone window')
  assert(manifest.theme_color, 'the manifest declares a theme colour')
  assert(Array.isArray(manifest.icons) && manifest.icons.length >= 2, 'the manifest names icons')

  // Chrome will not offer installation without a 192 and a 512 icon, and the
  // maskable one is what stops Android cropping the glyph to its own shape.
  const sizes = manifest.icons.map((i) => i.sizes)
  assert(sizes.includes('192x192'), 'the manifest has a 192x192 icon')
  assert(sizes.includes('512x512'), 'the manifest has a 512x512 icon')
  assert(
    manifest.icons.some((i) => i.purpose === 'maskable'),
    'the manifest has a maskable icon for Android launchers'
  )

  // The icons are real PNGs of the size the manifest claims, not placeholders
  // that happen to have the right filename.
  for (const icon of manifest.icons) {
    const bytes = fs.readFileSync(path.join(publicDir, path.basename(icon.src)))
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    assert(bytes.subarray(0, 8).equals(signature), `${icon.src} is a PNG`)
    const [wantW, wantH] = icon.sizes.split('x').map(Number)
    assert(bytes.readUInt32BE(16) === wantW && bytes.readUInt32BE(20) === wantH, `${icon.src} is ${icon.sizes}`)
  }

  assert(dashboardHtml.includes('rel="manifest"'), 'the page links the manifest')
  assert(dashboardHtml.includes('name="theme-color"'), 'the page declares a theme colour')
  assert(dashboardHtml.includes('rel="apple-touch-icon"'), 'the page gives iOS an icon')
  assert(dashboardHtml.includes("serviceWorker.register('/sw.js')"), 'the page registers the worker')

  // The worker must never serve live state from a cache: a stale table would
  // show agents that have already exited, with nothing to tell them from ones
  // that are still running.
  const worker = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8')
  assert(worker.includes("startsWith('/api/')"), 'the worker leaves the live API alone')
  assert(
    !worker.includes("'/api/agents'") && !worker.includes('"/api/agents"'),
    'the worker does not name an API path in its precache list'
  )
  assert(
    worker.indexOf("startsWith('/api/')") < worker.indexOf('caches.match'),
    'the worker returns for an API path before it considers a cache'
  )
}

// The Host allowlist is its own unit: `tailscale serve` forwards the tailnet
// hostname, and the loopback-only rule rejected it, so the rules are asserted
// together and away from the dashboard unit tests they would otherwise inflate.
function runAllowedHostTests() {
  console.log('\nRunning Host allowlist tests...\n')
  assert(isAllowedHost('localhost:3333'), 'isAllowedHost accepts localhost with port')
  assert(isAllowedHost('127.0.0.1:3333'), 'isAllowedHost accepts loopback ip')
  assert(isAllowedHost('[::1]:3333'), 'isAllowedHost accepts ipv6 loopback')
  assert(!isAllowedHost('evil.example.com:3333'), 'isAllowedHost rejects external host')
  assert(!isAllowedHost('localhost.evil.com'), 'isAllowedHost rejects host suffix trick')
  assert(!isAllowedHost(undefined), 'isAllowedHost rejects missing host')

  // `tailscale serve` forwards the tailnet hostname, so the dashboard has to
  // accept it or every tailnet request is a 403. Only this node's name is
  // admitted: another tailnet's dashboard is not this dashboard.
  const ownTailnet = 'lenovo-ideapad.tail3260f2.ts.net'
  assert(
    isAllowedHost(ownTailnet, '', ownTailnet),
    'isAllowedHost accepts this node\'s tailnet hostname'
  )
  assert(
    isAllowedHost(`${ownTailnet}:443`, '', ownTailnet),
    'isAllowedHost accepts this node\'s tailnet hostname with a port'
  )
  assert(
    isAllowedHost(ownTailnet, '', `${ownTailnet}.`),
    'isAllowedHost matches the tailnet name whatever trailing dot it was read with'
  )
  assert(
    !isAllowedHost('someone-else.tail3260f2.ts.net', '', ownTailnet),
    'isAllowedHost rejects another name in the same tailnet'
  )
  assert(
    !isAllowedHost('other.ts.net', '', ownTailnet),
    'isAllowedHost rejects a tailnet name that is not this node\'s'
  )
  assert(
    !isAllowedHost(ownTailnet, '', ''),
    'isAllowedHost rejects the tailnet name when this node has none'
  )
  assert(
    !isAllowedHost('ts.net.evil.com', '', ownTailnet),
    'isAllowedHost rejects a tailnet name buried in another domain'
  )
  assert(
    !isAllowedHost('evitts.net', '', ownTailnet),
    'isAllowedHost rejects a name that only ends in the same letters'
  )
  assert(
    !isAllowedHost('myhost.example.com', '', ownTailnet),
    'isAllowedHost still rejects an unnamed external host'
  )

  // Importing the module must not run the Tailscale CLI. Every test, script and
  // tool that imports `dashboard.mjs` would otherwise pay for a subprocess it
  // never uses, and a `tailscale` that hangs would hang the import itself. The
  // name is read on the first request instead, which is where it is needed.
  const importProbe = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-import-'))
  try {
    const callLog = path.join(importProbe, 'calls.log')
    fs.writeFileSync(path.join(importProbe, 'tailscale'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(callLog)}\necho '{"Self":{"DNSName":"probe.tail0.ts.net."}}'\nexit 0\n`, { mode: 0o755 })
    execFileSync(process.execPath, ['--input-type=module', '-e', 'import(\'./dashboard.mjs\')'], {
      cwd: path.dirname(dashboardPath),
      stdio: 'ignore',
      env: { ...process.env, PATH: `${importProbe}${path.delimiter}${process.env.PATH}` },
    })
    assert(
      fs.existsSync(callLog) === false,
      'importing the dashboard does not run the tailscale CLI'
    )
  } finally {
    fs.rmSync(importProbe, { recursive: true, force: true })
  }
  // Anything else has to be named, so a custom domain stays opt-in.
  assert(
    isAllowedHost('monitor.internal:3333', 'monitor.internal'),
    'isAllowedHost accepts a host the operator named'
  )
  assert(
    isAllowedHost('monitor.internal', ' other.internal , monitor.internal '),
    'isAllowedHost reads the named hosts through their whitespace'
  )
  assert(
    !isAllowedHost('monitor.internal', ''),
    'isAllowedHost rejects a host that was not named'
  )
  const savedAllowed = process.env.AGENT_NOTIFY_ALLOWED_HOSTS
  try {
    process.env.AGENT_NOTIFY_ALLOWED_HOSTS = 'monitor.internal,other.internal'
    assert(
      isAllowedHost('monitor.internal:3333'),
      'isAllowedHost reads the named hosts from the environment when none are passed'
    )
    assert(!isAllowedHost('unnamed.internal'), 'isAllowedHost rejects a host the environment does not name')
  } finally {
    if (savedAllowed === undefined) delete process.env.AGENT_NOTIFY_ALLOWED_HOSTS
    else process.env.AGENT_NOTIFY_ALLOWED_HOSTS = savedAllowed
  }

}

// The Tailscale helpers talk to a CLI and a spawnSync'd binary, so they are
// asserted on their own rather than inflating the dashboard unit tests.
async function runTailscaleTests() {
  console.log('\nRunning Tailscale serve tests...\n')
  // ── Tailscale serve helpers ──────────────────────────────────────────────
  // resolveTailscaleBin finds a real binary when it is on PATH and returns null
  // when it is absent. Verified with a fake directory to stay offline.
  const tsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-ts-'))
  const tsBinDir = path.join(tsHome, 'bin')
  fs.mkdirSync(tsBinDir, { recursive: true })
  const fakeTailscale = path.join(tsBinDir, 'tailscale')
  fs.writeFileSync(fakeTailscale, '#!/bin/sh\necho ok\n', { mode: 0o755 })
  const savedPathForTs = process.env.PATH
  process.env.PATH = `${tsBinDir}${path.delimiter}${savedPathForTs}`
  assert(resolveTailscaleBin() === fakeTailscale, 'resolveTailscaleBin finds a tailscale binary on PATH')
  process.env.PATH = '/nonexistent-ts-dir'
  assert(resolveTailscaleBin() === null, 'resolveTailscaleBin returns null when tailscale is absent')
  process.env.PATH = savedPathForTs

  // Windows installs the CLI as tailscale.exe, so looking for the bare name
  // would skip the prompt on a platform this dashboard supports.
  assert(
    JSON.stringify(tailscaleBinNames('win32')) === JSON.stringify(['tailscale.exe', 'tailscale']),
    'tailscaleBinNames looks for the Windows executable first'
  )
  assert(
    JSON.stringify(tailscaleBinNames('linux')) === JSON.stringify(['tailscale']),
    'tailscaleBinNames looks for the bare name elsewhere'
  )
  const winDir = path.join(tsHome, 'winbin')
  fs.mkdirSync(winDir, { recursive: true })
  fs.writeFileSync(path.join(winDir, 'tailscale.exe'), '#!/bin/sh\necho ok\n', { mode: 0o755 })
  process.env.PATH = winDir
  const expectedWinLookup = process.platform === 'win32' ? path.join(winDir, 'tailscale.exe') : null
  assert(
    resolveTailscaleBin() === expectedWinLookup,
    'resolveTailscaleBin looks for the name its platform installs'
  )
  process.env.PATH = savedPathForTs
  // enableTailscaleServe runs the binary and captures the URL from `serve status`.
  // A fake tailscale that prints a URL to status is enough to prove the happy path;
  // a fake that exits 1 proves the graceful failure path.
  const tsLog = path.join(tsHome, 'ts.log')
  fs.writeFileSync(
    fakeTailscale,
    [
      '#!/bin/sh',
      `printf '%s\n' "$*" >> ${JSON.stringify(tsLog)}`,
      '[ "$1" = status ] && printf \'{"Self":{"DNSName":"myhost.example.ts.net."}}\'  && exit 0',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 }
  )
  const tsUrl = enableTailscaleServe(fakeTailscale, 4006)
  const tsCalls = fs.readFileSync(tsLog, 'utf8')
  assert(tsCalls.includes('serve --bg 4006'), 'enableTailscaleServe calls tailscale serve --bg <port>')
  assert(tsCalls.includes('status --self --json'), 'enableTailscaleServe queries tailscale status --self --json for the hostname')
  assert(tsUrl === 'https://myhost.example.ts.net', 'enableTailscaleServe returns the HTTPS URL (trailing dot stripped)')

  assert(
    resolveTailscaleHostname(fakeTailscale) === 'myhost.example.ts.net',
    'resolveTailscaleHostname reads the MagicDNS name without its trailing dot'
  )

  // Serve config belongs to root until an operator is set, so the failure has
  // to name the command that lifts it instead of repeating the one that failed.
  const tsWarned = []
  const realWarn = console.warn
  console.warn = (...args) => tsWarned.push(args.join(' '))
  try {
    fs.writeFileSync(
      fakeTailscale,
      '#!/bin/sh\necho "sending serve config: Access denied: serve config denied" >&2\nexit 1\n',
      { mode: 0o755 }
    )
    const deniedUrl = enableTailscaleServe(fakeTailscale, 4006)
    assert(deniedUrl === null, 'enableTailscaleServe returns null when serve is denied')
    const deniedOutput = tsWarned.join('\n')
    assert(
      deniedOutput.includes('sudo tailscale set --operator=$USER'),
      'a denied serve names the command that grants the permission'
    )
    assert(
      deniedOutput.includes('tailscale serve --bg 4006'),
      'a denied serve still says how to run it once it is permitted'
    )
  } finally {
    console.warn = realWarn
  }

  fs.writeFileSync(tsLog, '')
  tsWarned.length = 0
  console.warn = (...args) => tsWarned.push(args.join(' '))
  try {
    fs.writeFileSync(fakeTailscale, '#!/bin/sh\necho "some other failure" >&2\nexit 1\n', { mode: 0o755 })
    enableTailscaleServe(fakeTailscale, 4006)
    const otherOutput = tsWarned.join('\n')
    assert(
      !otherOutput.includes('set --operator'),
      'a failure that is not a permission problem does not suggest the operator command'
    )
    assert(otherOutput.includes('some other failure'), 'a failure that is not a permission problem says what failed')
  } finally {
    console.warn = realWarn
  }

  fs.writeFileSync(fakeTailscale, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const tsUrlFail = enableTailscaleServe(fakeTailscale, 4006)
  assert(tsUrlFail === null, 'enableTailscaleServe returns null when tailscale exits non-zero')

  // A CLI that never answers must not hold the install open. The fake sleeps
  // far longer than the bound, and the bound is passed in so the test does not
  // pay the real 20s to prove it.
  fs.writeFileSync(fakeTailscale, '#!/bin/sh\nsleep 120\n', { mode: 0o755 })
  const hungStart = Date.now()
  const hungUrl = enableTailscaleServe(fakeTailscale, 4006, 1500)
  const hungElapsed = Date.now() - hungStart
  assert(hungUrl === null, 'enableTailscaleServe returns null when tailscale never answers')
  assert(hungElapsed < 30000, 'a hung tailscale CLI cannot hold the install open')
  const hungHostname = resolveTailscaleHostname(fakeTailscale, 1500)
  assert(hungHostname === null, 'resolveTailscaleHostname returns null when tailscale never answers')

  fs.rmSync(tsHome, { recursive: true, force: true })
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
  assert(
    resolveDashboardPort(['node', 'dashboard.mjs', '--port=4003'], {}, {}) === 4003,
    'resolveDashboardPort accepts the flag=value form'
  )
  // parseInt reads a numeric prefix, so a malformed value must fall through to
  // the next source instead of binding a port nobody asked for.
  assert(
    resolveDashboardPort(['node', 'dashboard.mjs', '--port', '4004junk'], { DASHBOARD_PORT: '4005' }, {}) === 4005,
    'resolveDashboardPort rejects a flag with trailing garbage'
  )
  assert(
    resolveDashboardPort(['node', 'dashboard.mjs'], { DASHBOARD_PORT: '4005.5' }, {}) === 3333,
    'resolveDashboardPort rejects a fractional environment port'
  )
  assert(
    resolveDashboardPort(['node', 'dashboard.mjs', '--port=0'], {}, {}) === 3333,
    'resolveDashboardPort rejects port 0'
  )
  assert(
    resolveDashboardPort(['node', 'dashboard.mjs', '--port'], {}, {}) === 3333,
    'resolveDashboardPort falls back when the flag has no value'
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

  // The same tool is reported as `dsh` by Orca and `dsh-tui` by Herdr, so a row
  // would otherwise be named after the adapter that found it. Both come out
  // under one name; everything else passes through untouched.
  assert(canonicalAgentName('dsh') === 'dsh-tui', 'canonicalAgentName renames the short spelling')
  assert(canonicalAgentName('dsh-tui') === 'dsh-tui', 'canonicalAgentName leaves the long spelling alone')
  assert(canonicalAgentName('DSH') === 'dsh-tui', 'canonicalAgentName folds case')
  assert(canonicalAgentName('pi') === 'pi', 'canonicalAgentName leaves another agent alone')
  assert(canonicalAgentName('') === '', 'canonicalAgentName leaves an empty name empty')
  assert(canonicalAgentName(undefined) === '', 'canonicalAgentName does not throw on a missing name')
  assert(
    parseOrcaAgent({ path: '/p' }, { paneKey: 'k', agentType: 'dsh', state: 'idle' }).agent === 'dsh-tui',
    'an Orca row is named the same as the Herdr row for this tool'
  )
  assert(
    parseHerdrAgent({ pane_id: 'p', agent: 'dsh-tui', agent_status: 'idle' }).agent === 'dsh-tui',
    'the Herdr name for this tool is already the canonical one'
  )
  assert(
    parseHerdrAgent({ pane_id: 'p', agent: 'dsh', agent_status: 'idle' }).agent === 'dsh-tui',
    'a Herdr row using the short spelling is renamed too'
  )

  // Untrusted CLI payloads: wrong-typed or missing fields must degrade, not throw.
  const malformedHerdr = parseHerdrAgent({ agent_status: { nope: true }, pane_id: 42, cwd: null, terminal_title: 7 })
  assert(malformedHerdr.id === 'herdr-42', 'parseHerdrAgent keeps a numeric pane id distinct')
  assert(malformedHerdr.status === 'idle' && malformedHerdr.cwd === '', 'parseHerdrAgent coerces bad status and cwd')
  assert(parseHerdrAgent(null).id === 'herdr-pane-0', 'parseHerdrAgent survives a null element')
  assert(
    parseHerdrAgent({}, 1).id === 'herdr-pane-1',
    'parseHerdrAgent keys a missing pane id by row position'
  )

  assert(parseOrcaAgent(null, null).id === 'orca-pane-0', 'parseOrcaAgent survives a null worktree and agent')
  assert(
    parseOrcaAgent({}, {}, 3).id === 'orca-pane-3',
    'parseOrcaAgent keys a missing pane key by row position'
  )
  assert(parseOrcaAgent({ branch: 42 }, {}).branch === '', 'parseOrcaAgent rejects a non-string branch')
  assert(parseOrcaAgent({}, { prompt: 99 }).prompt === null, 'parseOrcaAgent rejects a non-string prompt')

  // Service & Update tests
  assert(getServicePlatform() === process.platform, 'getServicePlatform matches process.platform')
  assert(resolveServiceRuntime('/custom/bun').includes('bun'), 'resolveServiceRuntime detects bun')
  assert(typeof resolveServiceRuntime() === 'string', 'resolveServiceRuntime returns string')

  const systemd = buildSystemdUnit('/usr/bin/node', '/path/dashboard.mjs', '/path', 4006)
  assert(
    systemd.includes('ExecStart=/usr/bin/node /path/dashboard.mjs --port 4006'),
    'buildSystemdUnit ExecStart carries the port the install reported'
  )
  assert(systemd.includes('WorkingDirectory=/path'), 'buildSystemdUnit WorkingDirectory')

  // A path with spaces must stay one argv element; % is a systemd specifier.
  const spaced = buildSystemdUnit('/opt/my node/node', '/repo dir/dashboard.mjs', '/repo dir', 4006)
  assert(spaced.includes('ExecStart="/opt/my node/node" "/repo dir/dashboard.mjs"'), 'buildSystemdUnit quotes argv with spaces')
  // `WorkingDirectory=` takes no quoting: a quoted value is rejected by systemd as
  // "not absolute", while a bare space is preserved.
  assert(spaced.includes('WorkingDirectory=/repo dir'), 'buildSystemdUnit leaves a spaced working directory bare')
  assert(buildSystemdUnit('/usr/bin/node', '/path/100%.mjs', '/path', 4006).includes('100%%.mjs'), 'buildSystemdUnit escapes % specifiers')
  assert(
    buildSystemdUnit('/usr/bin/node', '/path/a$b.mjs', '/path', 4006).includes('ExecStart=/usr/bin/node "/path/a$$b.mjs"'),
    'buildSystemdUnit escapes $ expansion in ExecStart'
  )
  assert(
    buildSystemdUnit('/usr/bin/node', '/path/x.mjs', '/path/a$b', 4006).includes('WorkingDirectory=/path/a$b'),
    'buildSystemdUnit leaves a literal $ alone in WorkingDirectory'
  )
  let newlineRejected = false
  try {
    buildSystemdUnit('/usr/bin/node', '/path/x.mjs', '/path\nExecStartPre=/bin/true', 4006)
  } catch {
    newlineRejected = true
  }
  assert(newlineRejected, 'buildSystemdUnit refuses a newline instead of injecting a directive')
  let backslashRejected = false
  try {
    buildSystemdUnit('/usr/bin/node', '/path/x.mjs', '/path/ends-with\\', 4006)
  } catch {
    backslashRejected = true
  }
  assert(backslashRejected, 'buildSystemdUnit refuses a working directory ending in a backslash')
  let invalidPortRejected = false
  try {
    buildSystemdUnit('/usr/bin/node', '/path/x.mjs', '/path', 70000)
  } catch {
    invalidPortRejected = true
  }
  assert(invalidPortRejected, 'buildSystemdUnit refuses a port outside the valid range')

  const plist = buildLaunchdPlist('/usr/bin/node', '/path/dashboard.mjs', '/path', 4006)
  assert(plist.includes('<string>dev.agent-notify.dashboard</string>'), 'buildLaunchdPlist label')
  assert(plist.includes('<string>/usr/bin/node</string>'), 'buildLaunchdPlist node')
  assert(
    plist.includes('<string>--port</string>\n        <string>4006</string>'),
    'buildLaunchdPlist passes the port the install reported'
  )
  assert(
    buildLaunchdPlist('/usr/bin/node', '/path/a&b.mjs', '/path<c>', 4006).includes('/path/a&amp;b.mjs'),
    'buildLaunchdPlist escapes XML in paths'
  )

  const vbs = buildWindowsVbs('C:\\node.exe', 'C:\\dashboard.mjs', 4006)
  assert(vbs.includes('WshShell.Run'), 'buildWindowsVbs Run')
  assert(vbs.includes('--port 4006'), 'buildWindowsVbs passes the port the install reported')
  let vbsQuoteRejected = false
  try {
    buildWindowsVbs('C:\\node.exe', 'C:\\quoted"script.mjs', 4006)
  } catch {
    vbsQuoteRejected = true
  }
  assert(vbsQuoteRejected, 'buildWindowsVbs refuses a quote that would break the launcher')

  // The launchd installer has to replace a job that is already loaded: `load` on
  // its own leaves the previous definition (and its old port) running. Exercised
  // through the real installer with a fake `launchctl` on PATH and a throwaway
  // HOME, so the plist lands somewhere harmless and no supervisor is touched.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-launchd-'))
  const binDir = path.join(fakeHome, 'bin')
  const launchctlLog = path.join(fakeHome, 'launchctl.log')
  const loadedMarker = path.join(fakeHome, 'loaded')
  const launchedPlist = path.join(fakeHome, 'Library', 'LaunchAgents', 'dev.agent-notify.dashboard.plist')
  fs.mkdirSync(binDir, { recursive: true })
  const fakeLaunchctl = path.join(binDir, 'launchctl')
  fs.writeFileSync(
    fakeLaunchctl,
    [
      '#!/bin/sh',
      // `list` is the probe for a loaded job, so only the mutating calls are logged.
      `if [ "$1" != list ]; then printf '%s\\n' "$*" >> ${JSON.stringify(launchctlLog)}; fi`,
      `if [ "$1" = list ] && [ -f ${JSON.stringify(loadedMarker)} ]; then printf '4242\\t0\\tdev.agent-notify.dashboard\\n'; fi`,
      'exit 0',
      '',
    ].join('\n')
  )
  fs.chmodSync(fakeLaunchctl, 0o755)
  const savedHome = process.env.HOME
  const savedPath = process.env.PATH
  process.env.HOME = fakeHome
  process.env.PATH = `${binDir}:${savedPath}`
  try {
    const installContext = {
      nodeBin: '/usr/bin/node',
      scriptPath: path.join(fakeHome, 'dashboard.mjs'),
      repoDir: fakeHome,
      port: 4501,
    }
    captureConsole(() => installDarwinService(installContext))
    assert(
      fs.readFileSync(launchctlLog, 'utf8').trim() === `load -w ${launchedPlist}`,
      'launchd install loads a job that was not running'
    )
    assert(
      fs.readFileSync(launchedPlist, 'utf8').includes('<string>4501</string>'),
      'launchd install writes the reported port into the plist'
    )

    fs.writeFileSync(launchctlLog, '')
    fs.writeFileSync(loadedMarker, '1')
    captureConsole(() => installDarwinService(installContext))
    assert(
      fs.readFileSync(launchctlLog, 'utf8').trim().split('\n').join(' | ') ===
        `unload -w ${launchedPlist} | load -w ${launchedPlist}`,
      'launchd reinstall unloads the running job before loading the rewritten plist'
    )
  } finally {
    process.env.HOME = savedHome
    process.env.PATH = savedPath
    fs.rmSync(fakeHome, { recursive: true, force: true })
  }

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
  // The cache and the in-flight probe are keyed by checkout: with one shared slot
  // the second call would answer with the first directory's status.
  const otherStatus = await checkUpdateStatusAsync(tmpRepoDir, [dashboardPath])
  assert(otherStatus.isGit === true, 'checkUpdateStatusAsync keys the cache by directory')
  assert(otherStatus !== firstStatus, 'checkUpdateStatusAsync does not reuse another directory status')

  // A probe that cannot run reports the last known status instead of nothing, and
  // the entry is aged past the TTL first: that is the only way this path is
  // reached, so the failure path cannot read it through the TTL gate.
  const staleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-stale-'))
  const lastKnown = { isGit: true, hasUpdate: true, checkedAt: Date.now() - 3 * 60 * 60 * 1000 }
  writeUpdateCheckCache(staleDir, lastKnown, Date.now() - 2 * 60 * 60 * 1000)
  const staleStatus = await checkUpdateStatusAsync(staleDir, [path.join(staleDir, 'no-such-probe.mjs')])
  assert(staleStatus.hasUpdate === true, 'a failed update probe reports the last known status')
  assert(staleStatus.stale === true, 'the last known status is marked stale')
  assert(staleStatus.checkedAt === lastKnown.checkedAt, 'the stale status keeps its original checkedAt')
  const noHistoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-nohistory-'))
  const noHistory = await checkUpdateStatusAsync(noHistoryDir, [path.join(noHistoryDir, 'no-such-probe.mjs')])
  assert(noHistory.unavailable === 'the update check could not run', 'a failed probe without history says so')
  assert(noHistory.stale === undefined, 'a status with no history is not labelled stale')
  fs.rmSync(staleDir, { recursive: true, force: true })
  fs.rmSync(noHistoryDir, { recursive: true, force: true })
  await assertUpdateFailureAndBanner()

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
  // The collection cache and its in-flight slot are process-wide, so the ordering
  // this needs (a cold cache with a non-forced collection in flight) is set up in
  // a child process instead of depending on what ran before it.
  const coalesceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-coalesce-'))
  const coalesceProbe = path.join(coalesceDir, 'probe.mjs')
  fs.writeFileSync(
    coalesceProbe,
    `import { getLiveAgents } from ${JSON.stringify(catalogPath)}\n` +
      `const nonForced = getLiveAgents()\n` +
      `const forced = getLiveAgents({ forceFresh: true })\n` +
      `const forcedAgain = getLiveAgents({ forceFresh: true })\n` +
      `const [first, second, third] = await Promise.all([nonForced, forced, forcedAgain])\n` +
      // An async function wraps its return value, so coalescing is observable in
      // the resolved state objects, not in promise identity.
      `console.log(JSON.stringify({ staleForced: second === first, forcedCoalesced: second === third }))\n`
  )
  const coalesced = JSON.parse(execFileSync(process.execPath, [coalesceProbe], { encoding: 'utf8' }))
  assert(!coalesced.staleForced, 'getLiveAgents does not answer a forced request with an older collection')
  assert(coalesced.forcedCoalesced, 'getLiveAgents coalesces concurrent forced collections')
  fs.rmSync(coalesceDir, { recursive: true, force: true })

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
  assert((await resolveBranch(tmpBranchRepo)) === 'branch-probe', 'resolveBranch reads the directory branch')
  assert((await resolveBranch(tmpBranchRepo)) === 'branch-probe', 'resolveBranch serves a repeat lookup from cache')
  assert((await resolveBranch('/nonexistent')) === '', 'resolveBranch missing directory')
  assert((await resolveBranch('')) === '', 'resolveBranch empty directory')
  // A probe that rejects is one row's problem, not the snapshot's: the value has
  // to come back empty rather than propagating into the whole collection.
  const failingProbe = () => Promise.reject(new Error('git could not be spawned'))
  assert(
    (await resolveBranch(`${tmpBranchRepo}-rejected`, failingProbe)) === '',
    'resolveBranch survives a probe that rejects'
  )
  assert(
    (await resolveBranch(`${tmpBranchRepo}-thrower`, () => {
      throw new Error('probe threw synchronously')
    })) === '',
    'resolveBranch survives a probe that throws before returning'
  )
  // A failed probe is reported as empty but must not be cached: caching it would
  // hide a branch that resolves fine again as soon as the probe recovers, for the
  // whole TTL. A result the probe did produce is cached, detached HEAD included.
  let probeAttempts = 0
  const recoveringProbe = () => {
    probeAttempts += 1
    return probeAttempts === 1
      ? Promise.reject(new Error('git could not be spawned'))
      : Promise.resolve('branch-probe')
  }
  const recoveringDir = `${tmpBranchRepo}-recovering`
  assert((await resolveBranch(recoveringDir, recoveringProbe)) === '', 'resolveBranch reports the first failed probe as empty')
  assert(
    (await resolveBranch(recoveringDir, recoveringProbe)) === 'branch-probe',
    'resolveBranch retries after a failed probe instead of serving the failure for the TTL'
  )
  let headProbes = 0
  const headProbe = async () => {
    headProbes += 1
    return 'HEAD'
  }
  const headDir = `${tmpBranchRepo}-detached`
  assert((await resolveBranch(headDir, headProbe)) === '', 'resolveBranch hides a detached HEAD')
  assert((await resolveBranch(headDir, headProbe)) === '', 'resolveBranch serves a detached HEAD from cache')
  assert(headProbes === 1, 'resolveBranch caches a result the probe produced')
  fs.rmSync(tmpBranchRepo, { recursive: true, force: true })
  // Intentional: a removed directory keeps its branch for the cache TTL, and the
  // row it belonged to is gone long before that matters.
  assert((await resolveBranch(tmpBranchRepo)) === 'branch-probe', 'resolveBranch serves a deleted directory from cache')
  assert((await resolveBranch(`${tmpBranchRepo}-never-cached`)) === '', 'resolveBranch never-cached directory')
  // A 0ms timer proves the loop kept running while git was in flight: a
  // synchronous probe would run to completion before the timer could fire.
  const branchLoopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-branch-loop-'))
  let loopRanWhileResolving = false
  const branchTimer = setTimeout(() => {
    loopRanWhileResolving = true
  }, 0)
  await resolveBranch(branchLoopDir)
  clearTimeout(branchTimer)
  assert(loopRanWhileResolving, 'resolveBranch does not block the event loop')
  fs.rmSync(branchLoopDir, { recursive: true, force: true })

  // A snapshot can hold any number of rows, so the probes it triggers are capped.
  // The peak is measured while ten items run through three slots.
  let probesInFlight = 0
  let peakProbes = 0
  const visited = []
  await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
    probesInFlight += 1
    peakProbes = Math.max(peakProbes, probesInFlight)
    await new Promise((resolve) => setTimeout(resolve, 2))
    visited.push(n)
    probesInFlight -= 1
    return n * 2
  })
  assert(peakProbes <= 3, `mapWithConcurrency caps probes in flight (peak ${peakProbes})`)
  assert(visited.length === 10, 'mapWithConcurrency visits every item')

  // The runtimes are faked on PATH so discovery, id assignment, and branch
  // filling are exercised end to end: execEnv keeps the inherited PATH, so a temp
  // directory in front of it is found.
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-fake-bin-'))
  const writeFakeRuntime = (name, payload) => {
    const file = path.join(fakeBin, name)
    fs.writeFileSync(file, `#!/bin/sh\necho '${payload}'\n`)
    fs.chmodSync(file, 0o755)
  }
  writeFakeRuntime(
    'herdr',
    // The second row supplies the id the first row falls back to, so both resolve
    // to herdr-pane-0 before de-duplication.
    '{"result":{"agents":[{"agent_status":"working"},{"agent_status":"idle","pane_id":"pane-0"},{"agent_status":"working","pane_id":"pane-7"}]}}'
  )
  writeFakeRuntime('orca', '{"result":{"worktrees":[{"path":"/tmp","agents":[{},{}]}]}}')
  const stateProbe = path.join(fakeBin, 'probe.mjs')
  fs.writeFileSync(
    stateProbe,
    `import { collectLiveState } from ${JSON.stringify(catalogPath)}\nconsole.log(JSON.stringify(await collectLiveState()))\n`
  )
  const probedState = JSON.parse(
    execFileSync(process.execPath, [stateProbe], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
    })
  )
  const idsFor = (source) =>
    probedState.agents.filter((agent) => agent.source === source).map((agent) => agent.id)
  assert(idsFor('herdr').length === 3, 'collectLiveState reads a runtime from the extended PATH')
  assert(idsFor('herdr').includes('herdr-pane-7'), 'collectLiveState keeps an id the runtime supplied')
  assert(
    new Set(idsFor('herdr')).size === 3,
    'collectLiveState keeps herdr ids unique when an id collides with a fallback'
  )
  assert(new Set(idsFor('orca')).size === 2, 'collectLiveState keeps orca ids unique without paneKey')
  assert(
    probedState.agents.every((agent) => typeof agent.branch === 'string'),
    'collectLiveState leaves a string branch on every record'
  )
  fs.rmSync(fakeBin, { recursive: true, force: true })
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

// The Orca CLI shim lives in Orca's config dir, not /usr/bin, and a service does
// not inherit the PATH an Orca pane injects. Without that directory the name
// resolves to GNOME's screen reader, which rejects `worktree ps --json`.
function orcaShimDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'orca', 'linux-orca-cli-shim')
}

function shimOutranksUsrBin(dirs, shimDir) {
  const bin = dirs.indexOf('/usr/bin')
  return bin === -1 || dirs.indexOf(shimDir) < bin
}

// DEFAULT_EXTRA_DIRS is built at import time, so a config home other than the real
// one needs its own module instance: the query string keeps the two apart.
async function extendedPathWithConfigHome(configHome) {
  const saved = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = configHome
  try {
    const env = await import(`./shared/env.mjs?configHome=${encodeURIComponent(configHome)}`)
    return { dirs: env.getExtendedPathEnv().PATH.split(path.delimiter) }
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = saved
  }
}

async function runOrcaDiscoveryTests() {
  console.log('\nRunning Orca CLI discovery tests...\n')

  // A fake config home, so the assertions do not depend on Orca being installed.
  const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-config-'))
  const installedShim = path.join(installed, 'orca', 'linux-orca-cli-shim')
  fs.mkdirSync(installedShim, { recursive: true })
  try {
    const { dirs } = await extendedPathWithConfigHome(installed)
    assert(dirs.includes(installedShim), 'the extended PATH knows where the Orca CLI shim lives')
    assert(shimOutranksUsrBin(dirs, installedShim), 'the Orca shim outranks /usr/bin/orca, the GNOME screen reader')
  } finally {
    fs.rmSync(installed, { recursive: true, force: true })
  }

  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-config-'))
  try {
    const { dirs } = await extendedPathWithConfigHome(missing)
    assert(!dirs.includes(path.join(missing, 'orca', 'linux-orca-cli-shim')), 'a missing Orca shim dir is not put on PATH')
  } finally {
    fs.rmSync(missing, { recursive: true, force: true })
  }

  // And the shim this machine really has, if it has one.
  const realShim = orcaShimDir()
  if (fs.existsSync(realShim)) {
    assert(shimOutranksUsrBin(getExtendedPathEnv().PATH.split(path.delimiter), realShim), 'the installed Orca shim also outranks /usr/bin')
  }
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// A status CLI that ignores SIGTERM must not stall the snapshot: execFile's
// timeout has to kill it outright, not ask it to stop and then wait for it.
function slowStatusCli(dir) {
  const cli = path.join(dir, 'orca')
  const pidFile = path.join(dir, 'orca.pid')
  fs.writeFileSync(cli, `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\ntrap '' TERM\nexec sleep 30\n`)
  fs.chmodSync(cli, 0o755)
  const runner = path.join(dir, 'collect.mjs')
  fs.writeFileSync(
    runner,
    `import { collectLiveState } from ${JSON.stringify(catalogPath)}\nconst state = await collectLiveState()\nconsole.log(JSON.stringify(state.sources))\n`
  )
  // HOME and XDG_CONFIG_HOME point at the temp dir so the real Orca shim is not
  // put ahead of the fake one: this test is about the timeout, not discovery.
  return {
    runner,
    pidFile,
    env: {
      ...process.env,
      HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, 'config'),
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
    },
  }
}

async function runStatusCommandTimeoutTests() {
  console.log('\nRunning status command timeout tests...\n')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-slow-cli-'))
  try {
    const { runner, pidFile, env } = slowStatusCli(dir)
    const started = Date.now()
    let stdout = ''
    let error = ''
    try {
      stdout = execFileSync(process.execPath, [runner], { encoding: 'utf8', timeout: 20000, env })
    } catch (err) {
      error = err.message.split('\n')[0]
    }
    const elapsed = Date.now() - started
    assert(
      !error && elapsed < 15000,
      `a status CLI that ignores SIGTERM does not stall the snapshot (${error || `${elapsed}ms`})`
    )
    let sources = null
    try {
      sources = JSON.parse(stdout.trim().split('\n').pop())
    } catch {}
    assert(sources?.orca?.available === false, 'an unresponsive status CLI is reported as unavailable, not as empty')
    const childPid = Number((fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : '').trim())
    assert(childPid > 0 && !pidIsAlive(childPid), 'the hung status CLI is killed outright, not asked to stop')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests: the mutation driver's recovery from a killed run
// ─────────────────────────────────────────────────────────────────────────────

// The committed content of a file, read from git rather than from the
// worktree. A fixture taken from the worktree changes under the test's feet
// as soon as somebody edits the file, so the recovery would be proved against
// whatever the worktree happened to hold.
function committedFile(root, file) {
  return execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8' })
}

async function runMutationRestoreTests() {
  console.log('\nRunning mutation driver restore tests...\n')

  const { findLeftoverMutations, findRevertedFixes, restoreLeftoverMutations, isDirty, restoreOutcomeMessage } = await recoveryModules()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-restore-'))
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
  const repoRoot = path.dirname(fileURLToPath(import.meta.url))
  // A real catalogue entry against a real shipped file: the recovery has to
  // reproduce the bytes the driver would have written, and that is only
  // meaningful with the catalogue's own find/replace and the shipped source.
  const MUTATIONS = await loadCatalogue()
  const entry = MUTATIONS.find((m) => m.id === 'stale-status-not-marked')
  const source = committedFile(repoRoot, 'shared/service.mjs')
  const mutations = [entry]

  // The message the driver leaves on the way out has to say what happened to
  // the files it touched. A restore whose writes failed is not a lost lock,
  // and a driver that says otherwise sends the operator looking at a lock it
  // still holds.
  assert(restoreOutcomeMessage({ restored: 0, touched: 1, lostLock: null, failed: true }) === 'the files this driver touched could not be restored', 'a failed write is reported as a failed write')
  assert(restoreOutcomeMessage({ restored: 0, touched: 1, lostLock: null, failed: true }).includes('lock') === false, 'a failed write is not blamed on the lock')
  assert(restoreOutcomeMessage({ restored: 0, touched: 1, lostLock: 'another mutation driver took the lock over', failed: false }).includes('another mutation driver took the lock over'), 'a lost lock is reported as a lost lock')
  assert(restoreOutcomeMessage({ restored: 2, touched: 2, lostLock: null, failed: false }) === 'restored 2 tracked file(s) before exiting', 'a restore that happened is reported as a restore')
  assert(restoreOutcomeMessage({ restored: 0, touched: 0, lostLock: null, failed: false }) === 'there was nothing to restore', 'a driver that touched nothing says so')
  assert(restoreOutcomeMessage({ restored: 0, touched: 0, lostLock: 'the mutation lock file is gone', failed: false }) === 'there was nothing to restore, and the mutation lock file is gone', 'a driver that lost the lock without touching a file does not claim it left files alone')

  try {
    execSync('git init', { cwd: dir, stdio: 'ignore' })
    fs.mkdirSync(path.join(dir, 'shared'))
    fs.writeFileSync(path.join(dir, 'shared/service.mjs'), source)
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'operator notes\n')
    execSync('git add shared/service.mjs notes.txt', { cwd: dir, stdio: 'ignore', env: gitEnv })
    execSync('git commit -m init', { cwd: dir, stdio: 'ignore', env: gitEnv })

    const leftover = source.replace(entry.find, entry.replace)
    assert(leftover !== source, 'the catalogue entry still applies to the shipped file')

    // The operator's own edit to the file the catalogue targets is not a
    // leftover, so the recovery must leave it alone. The file is the one the
    // mutation targets: an edit to a file no mutation touches would prove
    // nothing, because the recovery never looks at that file at all.
    const editedTarget = `${source}\n// operator work in progress\n`
    fs.writeFileSync(path.join(dir, 'shared/service.mjs'), editedTarget)
    assert(findLeftoverMutations({ repoRoot: dir, mutations }).length === 0, 'an unrelated edit to a mutated file is not mistaken for a leftover mutation')
    assert(restoreLeftoverMutations({ repoRoot: dir, mutations }).restored.length === 0, 'an unrelated edit to a mutated file is not restored')
    assert(fs.readFileSync(path.join(dir, 'shared/service.mjs'), 'utf8') === editedTarget, "the operator's edit to a mutated file is left alone")

    // A file no mutation touches is likewise not written to.
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'operator notes, in progress\n')
    assert(restoreLeftoverMutations({ repoRoot: dir, mutations }).restored.length === 0, 'a file no mutation touches is not restored')
    assert(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8') === 'operator notes, in progress\n', 'a file no mutation touches is left alone')

    // A run that was killed outright leaves the mutation applied.
    fs.writeFileSync(path.join(dir, 'shared/service.mjs'), leftover)
    const found = findLeftoverMutations({ repoRoot: dir, mutations })
    assert(found.length === 1, 'a killed run leaves a recognisable leftover')
    assert(found[0]?.id === entry.id, 'the leftover names the mutation that was applied')
    assert(found[0]?.file === entry.file, 'the leftover names the file it was applied to')

    const restored = restoreLeftoverMutations({ repoRoot: dir, mutations })
    assert(restored.restored.length === 1, 'the leftover is restored')
    assert(fs.readFileSync(path.join(dir, 'shared/service.mjs'), 'utf8') === source, 'the committed content is put back')
    assert(restoreLeftoverMutations({ repoRoot: dir, mutations }).restored.length === 0, 'restoring twice changes nothing')

    // A leftover the operator then edited no longer matches, so the recovery
    // must leave it alone rather than undo the operator's work along with it.
    const edited = `${leftover}\n// operator work in progress\n`
    fs.writeFileSync(path.join(dir, 'shared/service.mjs'), edited)
    assert(findLeftoverMutations({ repoRoot: dir, mutations }).length === 0, 'a leftover the operator edited is not a leftover any more')
    assert(restoreLeftoverMutations({ repoRoot: dir, mutations }).restored.length === 0, 'a leftover the operator edited is not restored over their work')
    assert(fs.readFileSync(path.join(dir, 'shared/service.mjs'), 'utf8') === edited, "the operator's edit in the leftover file survives")

    // The same file is named as a reverted fix, so the driver can tell the
    // operator which file to look at instead of leaving them to guess.
    const reverted = findRevertedFixes({ repoRoot: dir, mutations })
    assert(reverted.length === 1, 'a leftover with an edit on top is named as a reverted fix')
    assert(reverted[0]?.file === entry.file, 'the reverted fix names the file it is in')
    assert(reverted[0]?.id === entry.id, 'the reverted fix names the fix that is missing')

    // An operator save that lands between the decision to write and the write
    // itself must not be overwritten. The hook sits in exactly that window,
    // so it is where the save is simulated — once before the temporary file
    // is written, and once between the temporary file and the rename. The
    // second one is the window the re-read immediately before the rename
    // exists to close.
    for (const window of ['before the temporary file', 'between the temporary file and the rename']) {
      fs.writeFileSync(path.join(dir, 'shared/service.mjs'), leftover)
      let calls = 0
      const raced = restoreLeftoverMutations({
        repoRoot: dir,
        mutations,
        beforeWrite: (item) => {
          calls++
          const onTarget = window === 'between the temporary file and the rename' ? 2 : 1
          if (calls === onTarget) fs.writeFileSync(path.join(dir, item.file), `${leftover}\n// the operator saved in this window\n`)
          return true
        },
      })
      assert(raced.restored.length === 0, `a file that changed ${window} is not restored`)
      assert(raced.skipped.length === 1, `a file that changed ${window} is reported as skipped`)
      assert(fs.readFileSync(path.join(dir, 'shared/service.mjs'), 'utf8').includes('// the operator saved in this window'), `the operator's save ${window} survives`)
    }

    // A driver that lost the lock must not write: the lock is re-checked
    // before every write, and a takeover means another driver owns the tree.
    fs.writeFileSync(path.join(dir, 'shared/service.mjs'), leftover)
    const stopped = restoreLeftoverMutations({ repoRoot: dir, mutations, beforeWrite: () => false })
    assert(stopped.restored.length === 0, 'a driver that lost the lock restores nothing')
    assert(fs.readFileSync(path.join(dir, 'shared/service.mjs'), 'utf8') === leftover, 'the leftover is left alone when the lock is lost')

    // A file the operator replaced with a symlink is theirs: the recovery
    // does not write through the link, because the link may point outside the
    // repository and the recovery would put the committed content somewhere
    // the operator never asked for.
    const outsideFile = path.join(os.tmpdir(), `agent-notify-link-target-${process.pid}.mjs`)
    try {
      fs.writeFileSync(outsideFile, leftover)
      fs.unlinkSync(path.join(dir, 'shared/service.mjs'))
      fs.symlinkSync(outsideFile, path.join(dir, 'shared/service.mjs'))
      const linked = restoreLeftoverMutations({ repoRoot: dir, mutations })
      assert(linked.restored.length === 0, 'a symlinked leftover is not written through')
      assert(linked.skipped.length === 1, 'a symlinked leftover is reported as skipped')
      assert(fs.readFileSync(outsideFile, 'utf8') === leftover, 'the file a link points at is left alone')
    } finally {
      try { fs.rmSync(outsideFile, { force: true }) } catch {}
      try { fs.unlinkSync(path.join(dir, 'shared/service.mjs')) } catch {}
      fs.writeFileSync(path.join(dir, 'shared/service.mjs'), leftover)
    }

    // The worktree state is tri-state: a git failure is an unknown state, not
    // a clean one. The gate that decides whether the recovery may run is
    // driven from the driver itself, and the driver-level tests cover it.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-nogit-'))
    try {
      assert(isDirty(outside, { trackedOnly: true }) === null, 'a git failure is an unknown state, not a clean one')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// The driver's own write must not follow a link at the end of the path. The
// check that refuses a linked target is a separate step from the write, so a
// file that is plain when it is checked can be a link by the time it is
// written, and the write itself has to refuse it too.
async function runDriverWriteTests() {
  console.log('\nRunning mutation driver write tests...\n')

  const { writeFileNoFollow } = await recoveryModules()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-nofollow-'))
  try {
    const destination = path.join(dir, 'destination.txt')
    fs.writeFileSync(destination, "the operator's own file\n")
    const link = path.join(dir, 'tracked.mjs')
    fs.symlinkSync(destination, link)
    let refused = false
    try {
      writeFileNoFollow(link, 'the mutation\n')
    } catch {
      refused = true
    }
    assert(refused, "the driver's write refuses a target that is a link")
    assert(fs.readFileSync(destination, 'utf8') === "the operator's own file\n", "the link's destination is left alone")
    const plain = path.join(dir, 'plain.mjs')
    writeFileNoFollow(plain, 'the mutation\n')
    assert(fs.readFileSync(plain, 'utf8') === 'the mutation\n', 'a plain file is written')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// The catalogue must not reach the recovery path. A killed run that left the
// recovery mutated would leave it unable to recognise a leftover, and an
// inverted comparison there would overwrite the operator's own work.
async function runMutationProtectionTests() {
  console.log('\nRunning mutation catalogue protection tests...\n')

  const { isProtectedFile } = await recoveryModules()
  const repoRoot = path.dirname(fileURLToPath(import.meta.url))
  assert(isProtectedFile(repoRoot, 'shared/service.mjs') === false, 'the application code is not protected')
  assert(isProtectedFile(repoRoot, '.agents/skills/verify/scripts/restore.mjs') === true, 'the recovery module is protected')
  assert(isProtectedFile(repoRoot, './.agents/skills/verify/scripts/lib.mjs') === true, 'a protected file is protected however it is spelled')
  assert(isProtectedFile(repoRoot, 'test_cases.test.js') === true, 'the suite the driver reads is protected')
  assert(isProtectedFile(repoRoot, '.agents/skills/verify/scripts-evil/x.mjs') === false, 'a directory that only shares a prefix is not protected')
  // The case of the spelling must not decide the answer: a catalogue entry
  // that spells a protected file in a different case reaches the very same
  // file on a case-insensitive filesystem, and the guard has to hold on
  // every filesystem rather than only where the filesystem itself folds case.
  assert(isProtectedFile(repoRoot, 'TEST_CASES.TEST.JS') === true, 'the suite is protected however its case is spelled')
  assert(isProtectedFile(repoRoot, '.AGENTS/SKILLS/VERIFY/SCRIPTS/RESTORE.MJS') === true, 'the recovery module is protected however its case is spelled')
  assert(isProtectedFile(repoRoot, '.agents/skills/verify/scripts/LEFTOVER.MJS') === true, 'the read-only half of the recovery is protected too')
  assert(isProtectedFile(repoRoot, 'Shared/Service.mjs') === false, 'the application code is not protected however its case is spelled')

  const MUTATIONS = await loadCatalogue()
  const reachable = MUTATIONS.filter((m) => isProtectedFile(repoRoot, m.file))
  assert(reachable.length === 0, 'no catalogue entry reaches the recovery path or the suite')

  // A symlink to a protected file is the same file, so it is protected too:
  // a mutation through the link would reach the recovery just the same.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-link-'))
  try {
    const scripts = path.join(dir, '.agents/skills/verify/scripts')
    fs.mkdirSync(scripts, { recursive: true })
    fs.mkdirSync(path.join(dir, 'shared'))
    fs.writeFileSync(path.join(scripts, 'restore.mjs'), 'the shipped recovery\n')
    fs.symlinkSync(path.join('..', '.agents', 'skills', 'verify', 'scripts', 'restore.mjs'), path.join(dir, 'shared', 'service.mjs'))
    assert(isProtectedFile(dir, 'shared/service.mjs') === true, 'a symlink to the recovery is protected')
    fs.writeFileSync(path.join(dir, 'test_cases.test.js'), 'the suite\n')
    fs.symlinkSync(path.join('..', 'test_cases.test.js'), path.join(dir, 'shared', 'suite.mjs'))
    assert(isProtectedFile(dir, 'shared/suite.mjs') === true, 'a symlink to the suite is protected')
    fs.symlinkSync(path.join('..', '.agents', 'skills', 'verify', 'scripts', 'RESTORE.MJS'), path.join(dir, 'shared', 'shouty.mjs'))
    assert(isProtectedFile(dir, 'shared/shouty.mjs') === true, 'a symlink to the recovery is protected however its case is spelled')

    // A link chain is followed to its end however long it is: the depth bound
    // exists to stop a cycle, not to decide that a real path stops being the
    // file it names. A chain that cannot be followed at all is protected,
    // because a path the driver cannot resolve is one it cannot show to be
    // safe, and this is the shape that used to fail open: a chain of ten links
    // reached the recovery while the guard called it application code.
    for (const hops of [2, 5, 10, 12, 20]) {
      const chain = path.join(dir, `chain-${hops}`)
      fs.mkdirSync(chain, { recursive: true })
      let target = path.join(scripts, 'restore.mjs')
      for (let i = hops - 1; i >= 0; i--) {
        const link = path.join(chain, `l${i}`)
        fs.symlinkSync(target, link)
        target = link
      }
      assert(
        isProtectedFile(dir, path.relative(dir, path.join(chain, 'l0'))) === true,
        `a chain of ${hops} links to the recovery is still the recovery`
      )
    }

    // The cycle the bound is for: two links pointing at each other. It has no
    // end to follow, so the answer has to be the safe one.
    const cycle = path.join(dir, 'cycle')
    fs.mkdirSync(cycle, { recursive: true })
    fs.symlinkSync(path.join(cycle, 'b'), path.join(cycle, 'a'))
    fs.symlinkSync(path.join(cycle, 'a'), path.join(cycle, 'b'))
    assert(
      isProtectedFile(dir, 'cycle/a') === true,
      'a link cycle is protected, because the driver cannot show what it reaches'
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// The driver wiring itself: the `--restore` flag, its exit codes, and the
// recovery it runs. The unit tests above cover the pure functions; this
// covers the command the operator actually types.
async function runMutationRestoreCommandTests() {
  console.log('\nRunning mutation driver restore command tests...\n')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-driver-'))
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
  const repoRoot = path.dirname(fileURLToPath(import.meta.url))
  const MUTATIONS = await loadCatalogue()
  const entry = MUTATIONS.find((m) => m.id === 'stale-status-not-marked')
  const source = committedFile(repoRoot, 'shared/service.mjs')
  const shippedRestore = fs.readFileSync(path.join(repoRoot, '.agents/skills/verify/scripts/restore.mjs'), 'utf8')
  const shippedLeftover = fs.readFileSync(path.join(repoRoot, '.agents/skills/verify/scripts/leftover.mjs'), 'utf8')
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-driver-marker-'))
  const marker = path.join(markerDir, 'loaded')
  // A copy of the deciding half that writes a file the moment it is
  // evaluated, so a test can see when it was loaded.
  const markOnLoad = (text) => `import { writeFileSync as __mark } from 'node:fs'\n__mark(${JSON.stringify(marker)}, 'loaded')\n${text}`

  // A driver run that is meant to be short gets a short leash: a run that
  // turns into a mutation sweep would take minutes, and the test that runs it
  // has to fail rather than wait.
  const runIn = (root, args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [path.join(root, '.agents/skills/verify/scripts/mutate.mjs'), ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv, timeout: 60000 }) }
    } catch (err) {
      return { code: err.status ?? 1, out: `${err.stdout || ''}${err.stderr || ''}` }
    }
  }
  const run = (args) => runIn(dir, args)

  // A throwaway copy of the driver and the suite, in a repository of its own.
  // The driver finds its repository root from where it sits, so a copy has to
  // carry the scripts, the suite and a file the catalogue can mutate.
  const makeRepo = (root, { git = true } = {}) => {
    const rootScripts = path.join(root, '.agents/skills/verify/scripts')
    fs.mkdirSync(rootScripts, { recursive: true })
    fs.mkdirSync(path.join(root, 'shared'), { recursive: true })
    for (const name of ['mutate.mjs', 'restore.mjs', 'leftover.mjs', 'lib.mjs', 'mutations.mjs']) {
      fs.copyFileSync(path.join(repoRoot, '.agents/skills/verify/scripts', name), path.join(rootScripts, name))
    }
    fs.copyFileSync(path.join(repoRoot, 'test_cases.test.js'), path.join(root, 'test_cases.test.js'))
    fs.writeFileSync(path.join(root, 'shared/service.mjs'), source)
    // The PWA tests read these from beside the suite, and this fixture runs the
    // suite in a repository of its own, so the copy has to carry them too.
    fs.cpSync(path.join(repoRoot, 'public'), path.join(root, 'public'), { recursive: true })
    if (git) {
      execSync('git init', { cwd: root, stdio: 'ignore', env: gitEnv })
      execSync('git add .', { cwd: root, stdio: 'ignore', env: gitEnv })
      execSync('git commit -m init', { cwd: root, stdio: 'ignore', env: gitEnv })
    }
    return rootScripts
  }

  try {
    const scripts = makeRepo(dir)
    const leftover = source.replace(entry.find, entry.replace)
    assert(leftover !== source, 'the catalogue entry still applies to the shipped file')

    // A clean tree: the driver has nothing to undo and says so.
    const clean = run(['--restore'])
    assert(clean.code === 0, 'the driver exits 0 when the worktree is clean')
    assert(clean.out.includes('no tracked file has uncommitted changes'), 'the driver says the tracked files are clean')

    // The check is about tracked files because the driver only ever writes a
    // tracked one: an untracked file is not the driver's and is not a leftover
    // either, so it must not turn a successful restore into a refusal. This is
    // the half the contract in SKILL.md used to leave out.
    fs.writeFileSync(path.join(dir, 'operator-notes.txt'), 'not ours\n')
    const withUntracked = run(['--restore'])
    assert(withUntracked.code === 0, 'the driver exits 0 when only an untracked file is present')
    assert(
      withUntracked.out.includes('no tracked file has uncommitted changes'),
      'the driver says the tracked files are clean even with an untracked file present'
    )
    fs.rmSync(path.join(dir, 'operator-notes.txt'))

    // A leftover of a killed run: the driver undoes it and exits 0.
    fs.writeFileSync(path.join(dir, 'shared/service.mjs'), leftover)
    const undone = run(['--restore'])
    assert(undone.code === 0, 'the driver exits 0 after undoing a leftover')
    assert(undone.out.includes('restored shared/service.mjs'), 'the driver says which file it restored')
    assert(fs.readFileSync(path.join(dir, 'shared/service.mjs'), 'utf8') === source, 'the leftover is undone by the driver')

    // A leftover the operator has since edited: the driver refuses to touch
    // it and says the tree is still dirty.
    const edited = `${leftover}\n// operator work in progress\n`
    fs.writeFileSync(path.join(dir, 'shared/service.mjs'), edited)
    const refused = run(['--restore'])
    assert(refused.code === 1, 'the driver exits 1 when the worktree is still dirty')
    assert(refused.out.includes('the tracked files still have uncommitted changes'), 'the driver says the tracked files are still dirty')
    assert(fs.readFileSync(path.join(dir, 'shared/service.mjs'), 'utf8') === edited, "the operator's edit survives the driver")

    // A plain run on the same tree refuses for the same reason, and names the
    // file that looks like a reverted fix.
    const plain = run(['--only', entry.id])
    assert(plain.code === 2, 'the driver exits 2 on a worktree it cannot judge')
    assert(plain.out.includes('shared/service.mjs'), 'the driver names the file to look at')

    // The recovery runs code from the worktree, so it must not run against
    // the operator's uncommitted version of that code: the driver refuses,
    // and the leftover it was asked to undo is left exactly as it was.
    fs.writeFileSync(path.join(dir, 'shared/service.mjs'), leftover)
    fs.writeFileSync(path.join(scripts, 'restore.mjs'), `${shippedRestore}\n// the operator is editing the recovery\n`)
    const editedRecovery = run(['--restore'])
    assert(editedRecovery.code === 2, 'the driver exits 2 when the recovery path is not the shipped one')
    assert(editedRecovery.out.includes('the recovery path has uncommitted changes'), 'the driver says why it skipped the recovery')
    assert(fs.readFileSync(path.join(dir, 'shared/service.mjs'), 'utf8') === leftover, 'the leftover is left alone when the recovery path is edited')
    fs.writeFileSync(path.join(scripts, 'restore.mjs'), shippedRestore)

    // The guard asks git about the content of the modules, not about their
    // timestamps. A module marked assume-unchanged is reported as clean by
    // `git status`, so a guard that asked git that way would be fooled and
    // would run the operator's version of the recovery.
    fs.writeFileSync(path.join(scripts, 'restore.mjs'), `${shippedRestore}\n// the operator is editing the recovery\n`)
    execSync('git update-index --assume-unchanged .agents/skills/verify/scripts/restore.mjs', { cwd: dir, stdio: 'ignore', env: gitEnv })
    const hidden = run(['--restore'])
    assert(hidden.code === 2, 'the driver exits 2 when a gated module is edited and marked assume-unchanged')
    assert(hidden.out.includes('the recovery path has uncommitted changes'), 'the guard sees through the assume-unchanged flag')
    assert(fs.readFileSync(path.join(dir, 'shared/service.mjs'), 'utf8') === leftover, 'the leftover is left alone when the guard is fooled')
    execSync('git update-index --no-assume-unchanged .agents/skills/verify/scripts/restore.mjs', { cwd: dir, stdio: 'ignore', env: gitEnv })
    fs.writeFileSync(path.join(scripts, 'restore.mjs'), shippedRestore)

    // The writing half of the recovery is loaded only after the guard has
    // passed, so a recovery that does not even parse is never evaluated: the
    // driver skips it instead of dying on it.
    fs.writeFileSync(path.join(scripts, 'restore.mjs'), 'export const broken = (\n')
    const brokenRecovery = run(['--restore'])
    assert(brokenRecovery.code === 2, 'the driver exits 2 rather than dying on a recovery it must not run')
    assert(brokenRecovery.out.includes('could not load the leftover recovery') === false, 'the driver does not load the recovery before the guard has passed')
    assert(fs.readFileSync(path.join(dir, 'shared/service.mjs'), 'utf8') === leftover, 'the leftover is left alone when the recovery cannot be loaded')
    fs.writeFileSync(path.join(scripts, 'restore.mjs'), shippedRestore)

    // The same copy, committed: now the guard has nothing to object to, so
    // the driver does load it, and it says so. This is what makes the
    // assertion above worth anything: the message the driver prints when it
    // does load a broken recovery is the one the assertion looks for.
    fs.writeFileSync(path.join(scripts, 'restore.mjs'), 'export const broken = (\n')
    execSync('git add .agents/skills/verify/scripts/restore.mjs', { cwd: dir, stdio: 'ignore', env: gitEnv })
    execSync('git commit -m broken', { cwd: dir, stdio: 'ignore', env: gitEnv })
    const brokenCommitted = run(['--restore'])
    assert(brokenCommitted.code === 2, 'the driver exits 2 when the recovery it is allowed to load does not parse')
    assert(brokenCommitted.out.includes('could not load the leftover recovery'), 'the driver says the recovery could not be loaded')
    fs.writeFileSync(path.join(scripts, 'restore.mjs'), shippedRestore)
    execSync('git add .agents/skills/verify/scripts/restore.mjs', { cwd: dir, stdio: 'ignore', env: gitEnv })
    execSync('git commit -m restore-back', { cwd: dir, stdio: 'ignore', env: gitEnv })

    // The deciding half of the recovery is loaded under the same guard as the
    // writing half. A copy that marks the moment it is evaluated proves the
    // ordering from both sides: the marker is there once the guard has passed,
    // and it is absent when the guard refused.
    const committedLeftover = markOnLoad(shippedLeftover)
    fs.writeFileSync(path.join(scripts, 'leftover.mjs'), committedLeftover)
    execSync('git add .agents/skills/verify/scripts/leftover.mjs', { cwd: dir, stdio: 'ignore', env: gitEnv })
    execSync('git commit -m marker', { cwd: dir, stdio: 'ignore', env: gitEnv })
    fs.writeFileSync(path.join(dir, 'shared/service.mjs'), leftover)
    const guarded = run(['--restore'])
    assert(guarded.code === 0, 'the driver runs when the guard has passed')
    assert(fs.existsSync(marker), 'the deciding half of the recovery is loaded once the guard has passed')
    assert(fs.readFileSync(path.join(dir, 'shared/service.mjs'), 'utf8') === source, 'the deciding half of the recovery finds the leftover')
    fs.rmSync(marker, { force: true })

    // The same copy with an uncommitted change on top: the guard refuses, and
    // the deciding half is never evaluated, so it never gets to say which of
    // the operator's files would be overwritten.
    fs.writeFileSync(path.join(scripts, 'leftover.mjs'), `${committedLeftover}\n// the operator is editing the recovery\n`)
    const refusedLoad = run(['--restore'])
    assert(refusedLoad.code === 2, 'the driver exits 2 when the recovery path is not the shipped one')
    assert(refusedLoad.out.includes('the recovery path has uncommitted changes'), 'the driver says why it skipped the recovery')
    assert(fs.existsSync(marker) === false, 'the deciding half of the recovery is not evaluated before the guard has passed')

    // A deciding half that does not even parse must not kill the driver: it
    // is never reached, because the guard refuses it first.
    fs.writeFileSync(path.join(scripts, 'leftover.mjs'), 'export const broken = (\n')
    const brokenLeftover = run(['--restore'])
    assert(brokenLeftover.code === 2, 'the driver exits 2 rather than dying on a deciding half it must not run')
    assert(brokenLeftover.out.includes('could not load the leftover recovery') === false, 'the driver does not load the deciding half before the guard has passed')
    fs.writeFileSync(path.join(scripts, 'leftover.mjs'), committedLeftover)

    // The catalogue is the list the recovery searches, so it sits behind the
    // guard as well: an edited copy is never evaluated, and the leftover is
    // left alone.
    const catalogueMarker = path.join(markerDir, 'catalogue')
    const markCatalogue = (text) => `import { writeFileSync as __markCatalogue } from 'node:fs'\n__markCatalogue(${JSON.stringify(catalogueMarker)}, 'loaded')\n${text}`
    const shippedMutationsSource = fs.readFileSync(path.join(repoRoot, '.agents/skills/verify/scripts/mutations.mjs'), 'utf8')
    fs.writeFileSync(path.join(scripts, 'mutations.mjs'), `${markCatalogue(shippedMutationsSource)}\n// the operator is editing the catalogue\n`)
    fs.writeFileSync(path.join(dir, 'shared/service.mjs'), leftover)
    const editedCatalogue = run(['--restore'])
    assert(editedCatalogue.code === 2, 'the driver exits 2 when the catalogue has uncommitted changes')
    assert(editedCatalogue.out.includes('the recovery path has uncommitted changes'), 'the driver says the recovery path is not the shipped one')
    assert(fs.existsSync(catalogueMarker) === false, 'the catalogue is not evaluated before the guard has passed')
    assert(fs.readFileSync(path.join(dir, 'shared/service.mjs'), 'utf8') === leftover, 'the leftover is left alone when the catalogue is not the shipped one')
    fs.writeFileSync(path.join(scripts, 'mutations.mjs'), shippedMutationsSource)

    // The guard asks git itself, in the driver, and not of a helper the
    // operator could edit: a helper that always answers "the tree is clean"
    // is not what the guard asks, so it cannot make the guard lie.
    const shippedLib = fs.readFileSync(path.join(repoRoot, '.agents/skills/verify/scripts/lib.mjs'), 'utf8')
    const helperStart = shippedLib.indexOf('export function isDirty(')
    const helperBody = shippedLib.indexOf(') {', helperStart) + 3
    const lyingHelper = `${shippedLib.slice(0, helperBody)}\n  return false\n${shippedLib.slice(helperBody)}`
    fs.writeFileSync(path.join(scripts, 'lib.mjs'), lyingHelper)
    // A probe that no longer parses would prove nothing, so it has to parse.
    try {
      execFileSync(process.execPath, ['--check', path.join(scripts, 'lib.mjs')], { stdio: 'ignore' })
    } catch {
      assert(false, 'the probe that lies about the worktree still parses')
    }
    // The helper lies and one of the gated modules is edited. The guard must
    // still fire, because it does not ask the helper.
    fs.writeFileSync(path.join(scripts, 'leftover.mjs'), `${shippedLeftover}\n// the operator is editing the recovery\n`)
    fs.writeFileSync(path.join(dir, 'shared/service.mjs'), leftover)
    const lyingGate = run(['--restore'])
    assert(lyingGate.code === 2, 'the driver exits 2 when the recovery path is edited')
    assert(lyingGate.out.includes('the recovery path has uncommitted changes'), 'a helper that lies about the worktree cannot silence the guard')
    assert(fs.readFileSync(path.join(dir, 'shared/service.mjs'), 'utf8') === leftover, 'the leftover is left alone when the guard cannot be trusted')
    fs.writeFileSync(path.join(scripts, 'lib.mjs'), shippedLib)
    fs.writeFileSync(path.join(scripts, 'leftover.mjs'), shippedLeftover)
    // The committed copy of the deciding half is the marked one, so the
    // shipped copy has to be committed back before the gate can be clean
    // again.
    execSync('git add .agents/skills/verify/scripts/leftover.mjs', { cwd: dir, stdio: 'ignore', env: gitEnv })
    execSync('git commit -m leftover-back', { cwd: dir, stdio: 'ignore', env: gitEnv })

    // The guard covers the modules the recovery evaluates, and nothing else:
    // a change to a script the recovery never loads says nothing about
    // whether the recovery is the shipped one, so the recovery still runs.
    fs.writeFileSync(path.join(scripts, 'doctor.mjs'), '// a script the recovery never loads\n')
    execSync('git add .agents/skills/verify/scripts/doctor.mjs', { cwd: dir, stdio: 'ignore', env: gitEnv })
    execSync('git commit -m doctor', { cwd: dir, stdio: 'ignore', env: gitEnv })
    fs.writeFileSync(path.join(scripts, 'doctor.mjs'), '// the operator is editing a script the recovery never loads\n')
    const outsideScope = run(['--restore'])
    assert(outsideScope.code === 1, 'the driver reports the tree it could not clean, because the unrelated edit is still there')
    assert(fs.readFileSync(path.join(dir, 'shared/service.mjs'), 'utf8') === source, 'the recovery still undoes the leftover when an unrelated script is edited')

    // The guard fails closed: an answer it does not understand is not a clean
    // tree, so the driver refuses rather than running the recovery.
    const shippedDriver = fs.readFileSync(path.join(repoRoot, '.agents/skills/verify/scripts/mutate.mjs'), 'utf8')
    const gateLine = 'return differs'
    assert(shippedDriver.includes(gateLine), 'the driver still has the guard line the probe replaces')
    fs.writeFileSync(path.join(scripts, 'mutate.mjs'), shippedDriver.replace(gateLine, 'return undefined'))
    fs.writeFileSync(path.join(dir, 'shared/service.mjs'), leftover)
    const failClosed = run(['--restore'])
    assert(failClosed.code === 2, 'the driver exits 2 when the guard answers something it does not understand')
    assert(fs.readFileSync(path.join(dir, 'shared/service.mjs'), 'utf8') === leftover, 'the leftover is left alone when the guard fails closed')
    fs.writeFileSync(path.join(scripts, 'mutate.mjs'), shippedDriver)

    // The catalogue must not be able to reach the recovery path or the suite.
    // A driver that is handed such an entry refuses it, whatever the
    // catalogue says.
    const shippedMutations = fs.readFileSync(path.join(repoRoot, '.agents/skills/verify/scripts/mutations.mjs'), 'utf8')
    fs.writeFileSync(path.join(scripts, 'mutations.mjs'), shippedMutations.replace('export const MUTATIONS = [', "export const MUTATIONS = [\n  { id: 'reaches-the-suite', file: 'test_cases.test.js', find: 'Results:', replace: 'Nope:', expectTest: 'x', description: 'x' },"))
    execSync('git add .agents/skills/verify/scripts/mutations.mjs', { cwd: dir, stdio: 'ignore', env: gitEnv })
    execSync('git commit -m catalogue', { cwd: dir, stdio: 'ignore', env: gitEnv })
    const preflight = run(['--preflight'])
    assert(preflight.code === 1, 'the driver refuses a catalogue entry that reaches the suite')
    assert(preflight.out.includes('reaches-the-suite'), 'the driver names the entry it refused')
    assert(preflight.out.includes("carries the driver's own recovery path or the suite it reads"), 'the driver says why the entry is refused')
    fs.writeFileSync(path.join(scripts, 'mutations.mjs'), shippedMutations)
    execSync('git add .agents/skills/verify/scripts/mutations.mjs', { cwd: dir, stdio: 'ignore', env: gitEnv })
    execSync('git commit -m catalogue-back', { cwd: dir, stdio: 'ignore', env: gitEnv })

    // A git failure is an unknown state, not a clean one: the driver refuses
    // rather than guessing whether the recovery path is the shipped one.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-driver-nogit-'))
    try {
      makeRepo(outside, { git: false })
      fs.writeFileSync(path.join(outside, 'shared/service.mjs'), leftover)
      const noGit = runIn(outside, ['--restore'])
      assert(noGit.code === 2, 'the driver exits 2 when it cannot read the worktree state from git')
      assert(noGit.out.includes('could not read the worktree state from git'), 'the driver says it cannot judge the worktree')
      assert(fs.readFileSync(path.join(outside, 'shared/service.mjs'), 'utf8') === leftover, 'the leftover is left alone when git cannot be read')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }

    // The temporary file sits at a fixed, predictable path, so a link planted
    // there must not receive the committed bytes.
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-outside-'))
    try {
      const planted = path.join(outsideDir, 'planted.txt')
      fs.writeFileSync(planted, "the operator's own file\n")
      fs.symlinkSync(planted, path.join(dir, 'shared/service.mjs.restore-tmp'))
      fs.writeFileSync(path.join(dir, 'shared/service.mjs'), leftover)
      const plantedRun = run(['--restore'])
      assert(plantedRun.out.includes('restored shared/service.mjs'), 'the driver undoes the leftover when a link waits at the temporary path')
      assert(fs.readFileSync(planted, 'utf8') === "the operator's own file\n", 'the recovery does not write through a link at the temporary path')
      assert(fs.readFileSync(path.join(dir, 'shared/service.mjs'), 'utf8') === source, 'the leftover is still undone when a link waited at the temporary path')

      // A link in place of a directory on the path would put the committed
      // bytes outside the repository just as surely as a link at the file.
      const outsideService = path.join(outsideDir, 'service.mjs')
      fs.writeFileSync(outsideService, leftover)
      fs.rmSync(path.join(dir, 'shared'), { recursive: true })
      fs.symlinkSync(outsideDir, path.join(dir, 'shared'))
      const linkedDir = run(['--restore'])
      assert(linkedDir.out.includes('a link that leaves the repository'), 'the driver says the file is reached through a link out of the repository')
      assert(fs.readFileSync(outsideService, 'utf8') === leftover, 'the recovery does not write through a link out of the repository')
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
    // The block above put a link where the shared directory was, so it has to
    // be a directory again before anything else reads a file in it.
    fs.unlinkSync(path.join(dir, 'shared'))
    fs.mkdirSync(path.join(dir, 'shared'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'shared/service.mjs'), source)

    // A flag that is present is a flag. `--restore` with a file name after it
    // is still a restore, and must not turn into a mutation sweep.
    // The unrelated edit of doctor.mjs above is still in the tree, so it is
    // put back: the runs below are about the flags, not about a dirty tree.
    fs.writeFileSync(path.join(scripts, 'doctor.mjs'), '// a script the recovery never loads\n')
    fs.rmSync(path.join(dir, '.agents/skills/verify/artifacts/mutations.json'), { force: true })
    fs.writeFileSync(path.join(dir, 'shared/service.mjs'), leftover)
    const restoreWithFile = run(['--restore', 'shared/service.mjs'])
    assert(restoreWithFile.code === 0, 'the driver exits 0 when --restore is given a file name')
    assert(fs.readFileSync(path.join(dir, 'shared/service.mjs'), 'utf8') === source, 'the leftover is undone when --restore is given a file name')
    assert(fs.existsSync(path.join(dir, '.agents/skills/verify/artifacts/mutations.json')) === false, 'a restore with a file name after it does not run a mutation sweep')

    // The same for the other boolean flag.
    const preflightWithFile = run(['--preflight', 'shared/service.mjs'])
    assert(preflightWithFile.out.includes('mutations are runnable'), '--preflight with a file name after it is still a preflight')
    assert(fs.existsSync(path.join(dir, '.agents/skills/verify/artifacts/mutations.json')) === false, 'a preflight with a file name after it does not run a mutation sweep')

    // A clean filter can hide an edit from git. The filter runs before git
    // compares anything, so a file whose edit the filter removes looks
    // unmodified to `git status` and to any hash git computes. The gate
    // compares the bytes on disk with the bytes in the commit, so it sees
    // the edit the filter hides.
    const filtered = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-driver-filter-'))
    try {
      const filteredScripts = makeRepo(filtered)
      fs.writeFileSync(path.join(filtered, '.gitattributes'), '*.mjs filter=hide-edit\n')
      execSync('git config filter.hide-edit.clean "grep -v HIDDEN_EDIT"', { cwd: filtered, stdio: 'ignore', env: gitEnv })
      const shippedRestoreInFiltered = fs.readFileSync(path.join(filteredScripts, 'restore.mjs'), 'utf8')
      fs.writeFileSync(path.join(filteredScripts, 'restore.mjs'), `${shippedRestoreInFiltered}\n// HIDDEN_EDIT\n`)
      execSync('git add .', { cwd: filtered, stdio: 'ignore', env: gitEnv })
      execSync('git commit -m filtered', { cwd: filtered, stdio: 'ignore', env: gitEnv })
      fs.writeFileSync(path.join(filtered, 'shared/service.mjs'), leftover)
      const filteredRun = runIn(filtered, ['--restore'])
      assert(filteredRun.code === 2, 'the driver exits 2 when a clean filter hides an edit of the recovery path')
      assert(filteredRun.out.includes('the recovery path has uncommitted changes'), 'the gate sees the edit that the clean filter hides')
      assert(fs.readFileSync(path.join(filtered, 'shared/service.mjs'), 'utf8') === leftover, 'the leftover is left alone when a clean filter hides the edit')
    } finally {
      fs.rmSync(filtered, { recursive: true, force: true })
    }

    // A checkout that rewrites line endings holds different bytes for the
    // same code. The gate compares the code, so such a checkout is not an
    // edited recovery path.
    const eol = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-driver-eol-'))
    try {
      const eolScripts = makeRepo(eol)
      execSync('git config core.autocrlf true', { cwd: eol, stdio: 'ignore', env: gitEnv })
      const shippedRestoreInEol = fs.readFileSync(path.join(eolScripts, 'restore.mjs'), 'utf8')
      fs.writeFileSync(path.join(eolScripts, 'restore.mjs'), shippedRestoreInEol.split('\n').join('\r\n'))
      execSync('git add .', { cwd: eol, stdio: 'ignore', env: gitEnv })
      // The line endings are the only change, so the blob does not move and
      // there is nothing to commit. The commit is empty on purpose: the
      // point of the test is what the worktree holds, not what the commit
      // holds.
      execSync('git commit --allow-empty -m eol', { cwd: eol, stdio: 'ignore', env: gitEnv })

      // The recovery path here is CRLF on disk and LF in the commit, which is
      // what the gate has to fold: a gate that called the difference an edit
      // would refuse with exit 2 and never reach the recovery at all. A clean
      // tree alone would not say that, since it is also clean when the
      // checkout keeps the line endings, so the asymmetry is asserted.
      assert(execSync('git status --porcelain --untracked-files=no', { cwd: eol, encoding: 'utf8', env: gitEnv }).trim() === '', 'the rewritten line endings are the checkout\'s, not an edit')
      const committedRestore = execSync('git show HEAD:.agents/skills/verify/scripts/restore.mjs', { cwd: eol, encoding: 'utf8', env: gitEnv })
      const worktreeRestore = fs.readFileSync(path.join(eolScripts, 'restore.mjs'), 'utf8')
      assert(worktreeRestore.includes('\r\n'), 'the recovery path is CRLF in the worktree')
      assert(committedRestore.includes('\r\n') === false, 'the recovery path is LF in the commit')

      // The bytes the checkout puts in the worktree are not the bytes the
      // mutation was written against. A mutation whose anchor spans lines can
      // never match a file the checkout wrote with CRLF, so the run has to say
      // so instead of blaming a killed run. Let git write those bytes itself,
      // so the tree stays clean while the anchor misses.
      const multiLineAnchor = MUTATIONS.find((m) => m.file === 'shared/service.mjs' && m.find.includes('\n'))
      assert(multiLineAnchor, 'the catalogue has a mutation whose anchor spans lines')
      fs.rmSync(path.join(eol, 'shared/service.mjs'))
      execSync('git checkout -- shared/service.mjs', { cwd: eol, stdio: 'ignore', env: gitEnv })
      const eolBytes = fs.readFileSync(path.join(eol, 'shared/service.mjs'), 'utf8')
      assert(eolBytes.includes('\r\n'), 'the checkout writes the line endings it was configured to write')

      const anchorMiss = runIn(eol, ['--only', multiLineAnchor.id])
      assert(anchorMiss.code === 1, 'the run fails when a mutation anchor cannot match')
      assert(anchorMiss.out.includes('cannot run: anchor not found in the worktree'), 'the run says the anchor was not found')
      assert(anchorMiss.out.includes('this checkout rewrites line endings'), 'the run names the rewritten line endings as the reason')
      assert(anchorMiss.out.includes(multiLineAnchor.id), 'the run names the mutation it could not run')
      assert(fs.readFileSync(path.join(eol, 'shared/service.mjs'), 'utf8') === eolBytes, 'the file is left alone when its anchor cannot match')

      // A killed run on this checkout leaves a leftover in the checkout's own
      // bytes: the CRLF file with the mutation applied. The recovery matches
      // bytes against the committed blob, so this one cannot match, and the
      // run has to name the file instead of undoing it. The exit code is the
      // point: 1 means the run got past the gate and into the recovery, while
      // a gate that mistook the CRLF recovery path for an edit would refuse
      // with 2 and never reach it. The bytes are read back from the checkout
      // rather than derived from the blob, so there is one source of truth for
      // what a rewrite of these line endings produces.
      const crlfSource = fs.readFileSync(path.join(eol, 'shared/service.mjs'), 'utf8')
      const crlfLeftover = crlfSource.replace(entry.find, entry.replace)
      fs.writeFileSync(path.join(eol, 'shared/service.mjs'), crlfLeftover)
      const crlfRestore = runIn(eol, ['--restore'])
      assert(crlfRestore.code === 1, 'the driver reaches the recovery on a checkout that rewrites line endings')
      assert(crlfRestore.out.includes('the tracked files still have uncommitted changes'), 'the restore says the tree is still dirty')
      assert(crlfRestore.out.includes(`${entry.file} (${entry.id})`), 'the restore names the file the leftover was found in')
      assert(crlfRestore.out.includes('check them by hand'), 'the restore sends the operator to check the file by hand')
      assert(fs.readFileSync(path.join(eol, 'shared/service.mjs'), 'utf8') === crlfLeftover, 'the file it could not match is not written')
    } finally {
      fs.rmSync(eol, { recursive: true, force: true })
    }

    // The driver puts back the files it mutated, and it puts them where
    // they were. A file the operator replaced with a link while the run was
    // going must not receive the content the driver was going to write.
    const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-driver-linked-'))
    const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-driver-victim-'))
    try {
      const linkedScripts = makeRepo(linked)
      const victim = path.join(victimDir, 'victim.txt')
      // The link points at a copy of the file, so a write through it would
      // show up, and the copy still holds the anchor, so the next mutation
      // really does try to write there.
      const victimBytes = `${source}\n// the operator's own file\n`
      fs.writeFileSync(victim, victimBytes)
      // The suite the driver runs is replaced by one that swaps the mutated
      // file for a link, so the driver's own undo is the write under test.
      const mutated = path.join(linked, 'shared/service.mjs')
      fs.writeFileSync(path.join(linked, 'test_cases.test.js'), [
        `import { unlinkSync, symlinkSync } from 'node:fs'`,
        `unlinkSync(${JSON.stringify(mutated)})`,
        `symlinkSync(${JSON.stringify(victim)}, ${JSON.stringify(mutated)})`,
        `console.log('Results: 1/1 passed')`,
        `// ${entry.expectTest}`,
        '',
      ].join('\n'))
      // Two mutations on the same file: the first one is undone through the
      // link, and the second one finds the link where the file was.
      fs.writeFileSync(path.join(linkedScripts, 'mutations.mjs'), `export const MUTATIONS = [
  {
    id: 'first-of-two',
    file: 'shared/service.mjs',
    description: 'the first of two mutations',
    find: ${JSON.stringify(entry.find)},
    replace: ${JSON.stringify(entry.replace)},
    expectTest: ${JSON.stringify(entry.expectTest)},
  },
  {
    id: 'second-of-two',
    file: 'shared/service.mjs',
    description: 'the second of two mutations',
    find: ${JSON.stringify(entry.find)},
    replace: ${JSON.stringify(entry.replace)},
    expectTest: ${JSON.stringify(entry.expectTest)},
  },
]
`)
      execSync('git add .', { cwd: linked, stdio: 'ignore', env: gitEnv })
      execSync('git commit -m linked', { cwd: linked, stdio: 'ignore', env: gitEnv })
      const linkedRun = runIn(linked, [])
      assert(fs.readFileSync(victim, 'utf8') === victimBytes, 'the driver does not write the file it mutated through a link')
      assert(linkedRun.out.includes('the path is not a plain file inside the repository'), 'the driver says it refused to write through a link')
      assert(linkedRun.out.includes('cannot run: shared/service.mjs is not a plain file inside the repository'), 'the driver refuses to mutate a file that is a link')
    } finally {
      fs.rmSync(linked, { recursive: true, force: true })
      fs.rmSync(victimDir, { recursive: true, force: true })
    }

    // A write that fails is reported as a failed write, not as a crash. A
    // file the operator replaced with a directory while the run was going
    // cannot be written to, and the driver has to say so rather than die on
    // it and leave the operator guessing.
    const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-driver-blocked-'))
    try {
      makeRepo(blocked)
      const mutated = path.join(blocked, 'shared/service.mjs')
      fs.writeFileSync(path.join(blocked, 'test_cases.test.js'), [
        `import { unlinkSync, mkdirSync } from 'node:fs'`,
        `unlinkSync(${JSON.stringify(mutated)})`,
        `mkdirSync(${JSON.stringify(mutated)})`,
        `console.log('Results: 1/1 passed')`,
        `// ${entry.expectTest}`,
        '',
      ].join('\n'))
      execSync('git add .', { cwd: blocked, stdio: 'ignore', env: gitEnv })
      execSync('git commit -m blocked', { cwd: blocked, stdio: 'ignore', env: gitEnv })
      const blockedRun = runIn(blocked, [])
      assert(blockedRun.out.includes('could not restore the file:'), 'the driver says the write failed instead of dying on it')
    } finally {
      fs.rmSync(blocked, { recursive: true, force: true })
    }

    // The recovery searches the tree git says the driver is in, not the tree
    // an edited helper points at. The helper is not behind the gate, so it
    // must not be able to send the recovery somewhere else.
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-driver-decoy-'))
    try {
      makeRepo(decoy)
      fs.writeFileSync(path.join(decoy, 'shared/service.mjs'), leftover)
      const shippedLibInDir = fs.readFileSync(path.join(scripts, 'lib.mjs'), 'utf8')
      fs.writeFileSync(path.join(scripts, 'lib.mjs'), shippedLibInDir.replace(
        "export const REPO_ROOT = path.resolve(SKILL_ROOT, '..', '..', '..')",
        `export const REPO_ROOT = ${JSON.stringify(decoy)}`,
      ))
      fs.writeFileSync(path.join(dir, 'shared/service.mjs'), leftover)
      const redirected = run(['--restore'])
      assert(redirected.out.includes('restored shared/service.mjs'), 'the recovery undoes the leftover in the tree git says the driver is in')
      assert(fs.readFileSync(path.join(dir, 'shared/service.mjs'), 'utf8') === source, 'the leftover in the tree git says the driver is in is undone')
      assert(fs.readFileSync(path.join(decoy, 'shared/service.mjs'), 'utf8') === leftover, 'the recovery leaves the tree an edited helper points at alone')
      fs.writeFileSync(path.join(scripts, 'lib.mjs'), shippedLibInDir)
    } finally {
      fs.rmSync(decoy, { recursive: true, force: true })
    }

    // A broken recovery module must fail the recovery tests, not take the
    // whole suite down with it: the suite is what decides whether a mutation
    // was caught, so it has to be able to report a broken recovery rather
    // than vanish. A suite whose catalogue does not parse still prints its
    // results. The nested suite is told not to run this test again, or the
    // two suites would nest forever.
    if (!process.env.AGENT_NOTIFY_NO_NESTED_SUITE) {
      const nested = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notify-driver-nested-'))
      try {
        const tracked = execSync('git ls-files', { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean)
        for (const file of tracked) {
          const target = path.join(nested, file)
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.copyFileSync(path.join(repoRoot, file), target)
        }
        execSync('git init', { cwd: nested, stdio: 'ignore', env: gitEnv })
        execSync('git add .', { cwd: nested, stdio: 'ignore', env: gitEnv })
        execSync('git commit -m init', { cwd: nested, stdio: 'ignore', env: gitEnv })
        fs.writeFileSync(path.join(nested, '.agents/skills/verify/scripts/mutations.mjs'), 'export const MUTATIONS = [\n')
        execSync('git add .', { cwd: nested, stdio: 'ignore', env: gitEnv })
        execSync('git commit -m broken-catalogue', { cwd: nested, stdio: 'ignore', env: gitEnv })
        let nestedCode = 0
        let nestedOut = ''
        try {
          nestedOut = execFileSync(process.execPath, ['test_cases.test.js'], { cwd: nested, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...gitEnv, AGENT_NOTIFY_NO_NESTED_SUITE: '1' } })
        } catch (err) {
          nestedCode = err.status ?? 1
          nestedOut = `${err.stdout || ''}${err.stderr || ''}`
        }
        assert(nestedOut.includes('Results:'), 'the suite still reports its results when a recovery module cannot be loaded')
        assert(nestedOut.includes('the mutation restore tests could not run'), 'the recovery test group is named when it cannot run')
        assert(nestedCode === 1, 'the suite fails when a recovery module cannot be loaded')
      } finally {
        fs.rmSync(nested, { recursive: true, force: true })
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// A broken recovery module must fail the recovery tests, not take the whole
// suite down with it: the suite is the thing that decides whether a mutation
// was caught, and it has to be able to report a broken recovery rather than
// vanish. So each recovery test runs behind a guard that turns a thrown
// error into a failed test and lets the rest of the suite report.
async function runRecoveryTest(name, fn) {
  try {
    await fn()
  } catch (err) {
    assert(false, `${name}: ${err && err.message ? err.message : err}`)
  }
}

async function main() {
  runIntegrationTests()
  await runUnitTests()
  await runHerdrUnitTests()
  runOrcaMainUnitTests()
  await runDashboardUnitTests()
  runAllowedHostTests()
  runPwaTests()
  await runTailscaleTests()
  await runOrcaDiscoveryTests()
  await runStatusCommandTimeoutTests()
  await runRecoveryTest('the mutation restore tests could not run', runMutationRestoreTests)
  await runRecoveryTest('the mutation driver write tests could not run', runDriverWriteTests)
  await runRecoveryTest('the mutation protection tests could not run', runMutationProtectionTests)
  await runRecoveryTest('the mutation restore command tests could not run', runMutationRestoreCommandTests)

  console.log(`\nResults: ${results.pass}/${results.total} passed, ${results.fail} failed`)
  if (results.fail > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Test runner error:', err)
  process.exit(1)
})
