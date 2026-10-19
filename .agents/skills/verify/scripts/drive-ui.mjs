#!/usr/bin/env node

// Drives the dashboard UI in a real browser against deterministic fixtures.
//
// Usage: node .agents/skills/verify/scripts/drive-ui.mjs [--port <free port>] [--out .agents/skills/verify/artifacts/ui]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseArgs,
  flagValue,
  freePort,
  sleep,
  httpGet,
  waitForDashboard,
  startDashboard,
  makeReport,
  runBrowser,
  ARTIFACTS,
  REPO_ROOT,
} from './lib.mjs'

const flags = parseArgs(process.argv.slice(2))
// Default to a port nothing else can claim. A fixed default would let the browser
// attach to an instance this run did not start, which silently proves the wrong thing.
const port = flags.port && flags.port !== true ? Number(flags.port) : await freePort()
const stubScript = path.join(REPO_ROOT, '.agents', 'skills', 'verify', 'scripts', 'serve-stub.mjs')
const outDir = path.resolve(REPO_ROOT, flagValue(flags, 'out', path.join(ARTIFACTS, 'ui')))
const report = makeReport('drive-ui')
// A private session file: `launch` can never adopt a browser someone else
// started, and `close` can only ever stop the Chrome this run launched.
const browserState = path.join(os.tmpdir(), `verify-browser-${process.pid}.json`)
console.log(`drive-ui: driving a stub on port ${port}`)

function runBrowserHere(args) {
  return runBrowser(['--state', browserState, ...args])
}

function browser(args) {
  const result = runBrowserHere(args)
  if (result.status !== 0) {
    throw new Error(`browser ${args[0]} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ')}`)
  }
  return result.stdout.trim()
}

function evalIn(expression) {
  return JSON.parse(browser(['eval', expression]))
}

function rowsText() {
  return evalIn(`Array.from(document.querySelectorAll('#agent-table-body tr')).map((tr) => tr.innerText.replace(/\\n/g, ' | '))`)
}

function rowIds() {
  return evalIn(`Array.from(document.querySelectorAll('#agent-table-body tr')).map((tr) => {
    const cell = tr.querySelector('.action-text');
    return cell ? cell.dataset.agentId : '';
  })`)
}

function payloadIds() {
  return evalIn('allAgents.map((a) => a.id)')
}

async function setFixture(name) {
  const res = await httpGet(`http://127.0.0.1:${port}/control/fixture?name=${name}`)
  if (res.status !== 200) throw new Error(`cannot set fixture ${name}: HTTP ${res.status}`)
}

async function waitForPayload(expected, timeout = 12000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (JSON.stringify(payloadIds()) === JSON.stringify(expected)) return true
    await sleep(250)
  }
  return false
}

const stub = startDashboard({ script: stubScript, port, args: ['--fixture', 'mixed'] })
let browserStarted = false

try {
  const stubReady = await waitForDashboard(port)
  if (!stubReady.ready) throw new Error(`stub never became ready: ${stubReady.reason}\n${stub.output}`)
  fs.mkdirSync(outDir, { recursive: true })

  const launched = runBrowserHere(['launch'])
  browserStarted = launched.status === 0 || /already running/.test(launched.stdout)
  if (!browserStarted) throw new Error(`cannot launch a browser: ${launched.stderr.trim()}`)
  browser(['open', `http://127.0.0.1:${port}/`])

  // ── page identity and source health ───────────────────────────────────────
  report.check('the page is titled Agent Monitor', evalIn('document.title') === 'Agent Monitor')
  report.check('the header names the product', evalIn('document.querySelector("h1").innerText').includes('Agent Monitor'))
  const sources = evalIn('document.getElementById("sources-status").innerText')
  report.check('both agent sources report health', sources.includes('Orca') && sources.includes('Herdr'), sources.replace(/\n/g, ' '))
  report.check('the sync indicator updates', evalIn('document.getElementById("last-updated").innerText').startsWith('Synced'))

  // ── the table ─────────────────────────────────────────────────────────────
  const counts = evalIn(`({
    working: document.getElementById('count-working').innerText,
    blocked: document.getElementById('count-blocked').innerText,
    idle: document.getElementById('count-idle').innerText,
    all: document.getElementById('tab-count-all').innerText,
  })`)
  report.check(
    'the status counts match the fixture',
    counts.working === '1' && counts.blocked === '1' && counts.idle === '1' && counts.all === '3',
    JSON.stringify(counts)
  )

  const rows = rowsText()
  const table = rows.join('\n')
  report.check('every agent gets a row', rows.length === 3, `${rows.length} rows`)
  // innerText reflects the CSS text-transform, so the badges read uppercase while
  // the host tags stay as authored.
  report.check('rows show status, host, agent, branch and activity', /WORKING/.test(table) && /BLOCKED/.test(table) && /DONE \/ IDLE/.test(table) && /Orca/.test(table) && /Herdr/.test(table) && /feat\/alpha/.test(table), '')
  const charlieRow = rows.find((row) => row.includes('charlie-docs')) || ''
  report.check('a blank branch renders as a dash', /—/.test(charlieRow) && !/feat\/|fix\//.test(charlieRow), charlieRow.replace(/\s+/g, ' ').slice(0, 60))
  report.check('the settled row shows a relative age', /(m ago|h ago|just now)/.test(table))

  // ── search ────────────────────────────────────────────────────────────────
  browser(['type', '--selector', '#search-box', '--value', 'bravo'])
  let filtered = rowsText()
  report.check('search narrows the table to a match', filtered.length === 1 && filtered[0].includes('bravo-web'), `${filtered.length} rows`)

  browser(['type', '--selector', '#search-box', '--value', 'zzz-nothing'])
  filtered = rowsText()
  report.check('no match shows the empty state', filtered.length === 1 && filtered[0].includes('No agents match the current filter.'), filtered[0]?.slice(0, 40) || '')

  browser(['type', '--selector', '#search-box', '--value', ''])
  report.check('clearing the query restores every row', rowsText().length === 3)

  // ── filter tabs ───────────────────────────────────────────────────────────
  browser(['click', '--selector', '.filter-tab[data-filter="blocked"]'])
  report.check('the Blocked tab shows only blocked agents', rowsText().length === 1 && rowsText()[0].includes('bravo-web'))
  browser(['click', '--selector', '.filter-tab[data-filter="working"]'])
  report.check('the Working tab shows only working agents', rowsText().length === 1 && rowsText()[0].includes('alpha-service'))
  browser(['click', '--selector', '.filter-tab[data-filter="all"]'])
  report.check('the All tab restores every row', rowsText().length === 3)

  // ── prompt inspection ─────────────────────────────────────────────────────
  browser(['click', '--selector', '.action-text[data-agent-id="orca:alpha"]'])
  const modalOpen = evalIn('getComputedStyle(document.getElementById("modal-backdrop")).display')
  const modalText = evalIn('document.getElementById("modal-content").innerText')
  report.check('clicking the activity cell opens the detail panel', modalOpen === 'flex', `display: ${modalOpen}`)
  report.check('the panel carries the tool and the full prompt', modalText.includes('TOOL: Bash') && modalText.includes('PROMPT:') && modalText.includes('Run the suite'), modalText.split('\n')[0])
  browser(['click', '--selector', '.modal-close'])
  report.check('closing the panel hides it', evalIn('getComputedStyle(document.getElementById("modal-backdrop")).display') === 'none')

  report.check('the update banner is visible', evalIn('document.getElementById("update-banner").style.display') !== 'none')
  const banner = evalIn('document.getElementById("update-commit").innerText')
  report.check('a stale update status is labelled as last known', banner.endsWith('(last known, the update check could not run)'), banner)

  // ── evidence before the order journey mutates the fixture ─────────────────
  browser(['aria', '--path', path.join(outDir, 'mixed.aria.txt')])
  browser(['screenshot', '--path', path.join(outDir, 'mixed.png')])
  report.check('aria and screenshot evidence are captured', fs.existsSync(path.join(outDir, 'mixed.aria.txt')) && fs.statSync(path.join(outDir, 'mixed.png')).size > 1000, outDir)

  // ── polling ───────────────────────────────────────────────────────────────
  const pollsBefore = (await httpGet(`http://127.0.0.1:${port}/control/polls`)).json.polls
  await sleep(7000)
  const pollsAfter = (await httpGet(`http://127.0.0.1:${port}/control/polls`)).json.polls
  report.check('the page polls for new state', pollsAfter - pollsBefore >= 2, `${pollsAfter - pollsBefore} polls in 7s`)
  report.check('polling does not reload the page', evalIn('performance.getEntriesByType("navigation").length') === 1)

  // ── row order stability (the journey this run is expected to fail) ────────
  await setFixture('mixed')
  const expectedMixed = (await httpGet(`http://127.0.0.1:${port}/api/agents`)).json.agents.map((a) => a.id)
  report.check('the mixed fixture is loaded', await waitForPayload(expectedMixed), expectedMixed.join(', '))
  const orderBefore = rowIds()

  await setFixture('swapped')
  const expectedSwapped = (await httpGet(`http://127.0.0.1:${port}/api/agents`)).json.agents.map((a) => a.id)
  report.check('the upstream order changed', JSON.stringify(expectedSwapped) !== JSON.stringify(expectedMixed), `payload now ${expectedSwapped.join(', ')}`)
  report.check('the reordered payload reaches the page', await waitForPayload(expectedSwapped, 12000))
  const orderAfter = rowIds()
  report.check(
    'rows keep their position when the upstream order changes',
    JSON.stringify(orderBefore) === JSON.stringify(orderAfter),
    `before [${orderBefore.join(', ')}] after [${orderAfter.join(', ')}]` +
      (JSON.stringify(orderBefore) === JSON.stringify(orderAfter) ? '' : ' — known defect: the table is rebuilt from the payload order on every poll')
  )

  report.writeEvidence('drive-ui.json')
} finally {
  if (browserStarted) runBrowserHere(['close'])
  stub.stop()
  report.finish()
}
