// ─── Integration + unit tests for agent-notify ───────────────────────────────
// Runs the Herdr adapter in integration mode and unit-tests shared/ntfy.mjs.

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { loadEnv, loadNtfyConfig, buildTags, isEnabled, buildAuthHeaders, isDesktopMode, isNtfyMode } from './shared/ntfy.mjs'
import { dispatchNotification } from './shared/notify.mjs'
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

const results = { pass: 0, fail: 0, total: 0 }

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

  // configDir .env overrides fallback defaults but not env vars
  delete process.env.NTFY_TOPIC
  delete process.env.NTFY_URL
  const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntfy-config-'))
  const tmpConfigEnv = path.join(tmpConfigDir, '.env')
  fs.writeFileSync(tmpConfigEnv, 'NTFY_TOPIC=from-config-dir\n')
  const fromDir = loadNtfyConfig(tmpConfigDir, '/nonexistent-fallback')
  assert(fromDir.NTFY_TOPIC === 'from-config-dir', 'loadNtfyConfig configDir .env')
  assert(fromDir.NTFY_URL === 'http://localhost:10081', 'loadNtfyConfig configDir fallback default')
  fs.unlinkSync(tmpConfigEnv)
  fs.rmdirSync(tmpConfigDir)

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

  // both platform calls desktop and attempts ntfy
  let bothDesktopCalled = false
  await dispatchNotification(
    { title: 'Test', body: 'Body' },
    { PLATFORM_DESKTOP: true, PLATFORM_NTFY: true, NTFY_URL: 'http://localhost:10081' },
    () => { bothDesktopCalled = true }
  )
  assert(bothDesktopCalled === true, 'dispatchNotification both calls desktop')

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

  const ws = extractWorkspaceContext({ data: { workspace: 'repo', tab: 'editor', pane_id: 'p1' } }, {})
  assert(ws.workspace === 'repo', 'extractWorkspaceContext workspace')
  assert(ws.tab === 'editor', 'extractWorkspaceContext tab')
  assert(ws.paneId === 'p1', 'extractWorkspaceContext paneId')

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

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  runIntegrationTests()
  await runUnitTests()
  await runHerdrUnitTests()

  console.log(`\nResults: ${results.pass}/${results.total} passed, ${results.fail} failed`)
  if (results.fail > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Test runner error:', err)
  process.exit(1)
})
