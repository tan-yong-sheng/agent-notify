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
  // The settled row says when it settled, in the same words an Orca row uses.
  // The old column said "9s ago" on one row and "just now" on the next for the
  // same kind of fact, and Herdr's answer was never anything but "just now".
  report.check('the settled row names when it settled', /Settled \d+[mh] ago/.test(charlieRow), charlieRow.replace(/\s+/g, ' ').slice(0, 80))

  // rowsText() joins a card's cells with " | ", and the badge is its own cell,
  // so the row text is compared with that separator flattened out.
  const flat = (row) => row.replace(/\s*\|\s*/g, ' ')
  const alphaRow = rows.find((row) => row.includes('alpha-service')) || ''
  // Orca reports when a run began, so its duration is a measurement. This
  // fixture row is deliberately inexact to prove the page no longer prints a
  // duration it cannot measure, even when the server sends one.
  report.check('an unmeasurable start shows no duration', !/WORKING ·/.test(flat(alphaRow)), flat(alphaRow).slice(0, 80))
  report.check('a running row is active now rather than ago', /Active now/.test(flat(alphaRow)), flat(alphaRow).slice(0, 80))

  const bravoRow = rows.find((row) => row.includes('bravo-web')) || ''
  // An exact start is the only kind that prints, and it prints without a marker
  // because there is no lower bound to admit.
  report.check('an exact start shows a measured duration', /BLOCKED · 1m\b/.test(flat(bravoRow)) && !/1m\+/.test(flat(bravoRow)), flat(bravoRow).slice(0, 80))

  // ── search ────────────────────────────────────────────────────────────────
  browser(['type', '--selector', '#search-box', '--value', 'bravo'])
  let filtered = rowsText()
  report.check('search narrows the table to a match', filtered.length === 1 && filtered[0].includes('bravo-web'), `${filtered.length} rows`)

  browser(['type', '--selector', '#search-box', '--value', 'zzz-nothing'])
  filtered = rowsText()
  report.check('no match shows the empty state', filtered.length === 1 && filtered[0].includes('No agents match the current filter.'), filtered[0]?.slice(0, 40) || '')

  browser(['type', '--selector', '#search-box', '--value', ''])
  report.check('clearing the query restores every row', rowsText().length === 3)

  // Typing a host name is the filter the header's health tags do not provide:
  // the tags report whether a runtime answers, not which rows came from it. The
  // cancel is the one the page already has — clearing the box.
  browser(['type', '--selector', '#search-box', '--value', 'herdr'])
  const herdrRows = rowsText()
  report.check('searching a host name narrows to that runtime', herdrRows.length === 1 && herdrRows[0].includes('charlie-docs'), `${herdrRows.length} rows`)
  browser(['type', '--selector', '#search-box', '--value', 'orca'])
  const orcaRows = rowsText()
  report.check('searching the other host name narrows to its rows', orcaRows.length === 2 && orcaRows.every((r) => r.includes('orca') === false) && orcaRows.every((r) => /alpha-service|bravo-web/.test(r)), `${orcaRows.length} rows`)
  browser(['type', '--selector', '#search-box', '--value', ''])
  report.check('clearing the host query is the cancel', rowsText().length === 3)

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

  // ── keyboard operation ────────────────────────────────────────────────────
  // The row affordances were a span and a div, unreachable without a mouse. They
  // are buttons now, so the journey is driven with real key events: Tab to one,
  // press it, and check the effect the user would see. Focus also has to survive
  // the 3 s poll, which rebuilds these rows out from under the keyboard.
  browser(['eval', 'document.activeElement.blur()'])
  const tabTargets = []
  for (let i = 0; i < 8; i++) {
    browser(['key', 'tab'])
    tabTargets.push(evalIn('document.activeElement.className'))
  }
  report.check('the filter tabs are reachable by keyboard', tabTargets.some((c) => /filter-tab/.test(c)), tabTargets.join(' → '))
  report.check('a row affordance is reachable by keyboard', tabTargets.some((c) => /path-chip/.test(c)), tabTargets.join(' → '))

  const ringShown = evalIn(`(() => {
    const el = document.querySelector('.path-chip');
    el.focus();
    const cs = getComputedStyle(el);
    return { width: cs.outlineWidth, style: cs.outlineStyle, offset: cs.outlineOffset, accent: cs.outlineColor };
  })()`)
  report.check('a keyboard-focused row control shows a ring', ringShown.style === 'solid' && ringShown.width === '2px', `${ringShown.style} ${ringShown.width} ${ringShown.accent}`)
  report.check('the ring does not sit on the element itself', ringShown.offset === '2px', ringShown.offset)

  const focusSurvivesPoll = evalIn(`new Promise((resolve) => {
    const el = document.querySelector('.path-chip');
    el.focus();
    const before = el.dataset.copyPath;
    setTimeout(() => resolve({ before, after: document.activeElement.dataset?.copyPath ?? null, tag: document.activeElement.tagName }), 4500);
  })`)
  report.check(
    'focus survives a poll that rebuilds the row',
    focusSurvivesPoll.after === focusSurvivesPoll.before && focusSurvivesPoll.tag === 'BUTTON',
    `before ${focusSurvivesPoll.before} → after ${focusSurvivesPoll.after}`
  )
  browser(['key', 'enter'])
  const toastAfterEnter = evalIn('document.getElementById("toast").innerText')
  report.check('Enter on a focused path copies it', toastAfterEnter === 'Copied to clipboard!', toastAfterEnter)

  browser(['eval', `document.querySelector('.action-text[data-agent-id="orca:alpha"]').focus()`])
  browser(['key', 'enter'])
  const keyboardModal = evalIn('getComputedStyle(document.getElementById("modal-backdrop")).display')
  report.check('Enter on a focused prompt opens the panel', keyboardModal === 'flex', `display: ${keyboardModal}`)
  browser(['click', '--selector', '.modal-close'])

  const inert = evalIn(`(() => {
    const plain = document.querySelector('.action-text.action-plain');
    return { tag: plain?.tagName ?? null, hasId: plain?.hasAttribute('data-agent-id') ?? null, tabIndex: plain?.tabIndex ?? null };
  })()`)
  report.check('the row with nothing to expand is not a button', inert.tag === 'DIV' && inert.hasId === false && inert.tabIndex === -1, JSON.stringify(inert))

  // ── a Herdr duration is not shown, because it cannot be measured ──────────
  // Herdr reports no timestamps, so an observed duration counts from when this
  // page started looking. An agent four hours into a run was labelled "32m+" on
  // a dashboard started 32 minutes earlier, so the column is Orca-only.
  await setFixture('herdr-running')
  const runningIds = (await httpGet(`http://127.0.0.1:${port}/api/agents`)).json.agents.map((a) => a.id)
  report.check('the herdr-running fixture is loaded', await waitForPayload(runningIds), runningIds.join(', '))
  const runningRows = rowsText()
  const deltaRow = flat(runningRows[0] || '')
  report.check('an unrecorded running Herdr row shows no duration', /WORKING/.test(deltaRow) && !/·/.test(deltaRow), deltaRow.slice(0, 80))
  report.check('a running Herdr row is still active now', /Active now/.test(deltaRow), deltaRow.slice(0, 80))

  // Once the adapter has recorded when the run began, Herdr gets a real
  // duration instead of the observation-window estimate that was removed.
  await setFixture('herdr-recorded')
  const recordedIds = (await httpGet(`http://127.0.0.1:${port}/api/agents`)).json.agents.map((a) => a.id)
  report.check('the herdr-recorded fixture is loaded', await waitForPayload(recordedIds), recordedIds.join(', '))
  const recordedRow = flat(rowsText()[0] || '')
  report.check('a recorded Herdr start shows a measured duration', /WORKING · 4h/.test(recordedRow), recordedRow.slice(0, 80))
  await setFixture('mixed')
  const restoredIds = (await httpGet(`http://127.0.0.1:${port}/api/agents`)).json.agents.map((a) => a.id)
  report.check('the mixed fixture is restored', await waitForPayload(restoredIds), restoredIds.join(', '))

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

  // ── the same table on a phone ─────────────────────────────────────────────
  // The narrow layout reshapes each row into a card with flex order, so a cell
  // can be dropped without any markup change. The host tag went missing on a
  // phone through a `display: none` in the media query, which every check above
  // missed because they all run at the desktop width.
  browser(['viewport', '--width', '320', '--height', '568', '--mobile'])
  browser(['open', `http://127.0.0.1:${port}/`])
  const phone = evalIn(`(() => {
    const rows = [...document.querySelectorAll('#agent-table-body tr')];
    const row = rows[0];
    const tag = row.querySelector('.tag-source');
    return {
      width: innerWidth,
      rows: rows.length,
      header: getComputedStyle(document.querySelector('thead')).display,
      card: getComputedStyle(row).display,
      hostVisible: tag ? tag.getBoundingClientRect().width > 0 : false,
      hostText: tag ? tag.innerText : '',
      agent: row.children[2].innerText.trim(),
      offsetWidth: document.documentElement.scrollWidth,
    };
  })()`)
  report.check('the phone viewport is the width the run asked for', phone.width === 320, `${phone.width}px`)
  report.check('every row is still rendered on a phone', phone.rows === 3, `${phone.rows} rows`)
  report.check('the table becomes cards below 900px', phone.header === 'none' && phone.card === 'flex', `thead ${phone.header}, row ${phone.card}`)
  report.check('a card still says which runtime found the row', phone.hostVisible && /Orca|Herdr/.test(phone.hostText), phone.hostText || 'no host tag')
  report.check('the card still names the agent', Boolean(phone.agent), phone.agent)
  report.check('a phone card does not scroll sideways', phone.offsetWidth <= 320, `document ${phone.offsetWidth}px`)
  browser(['screenshot', '--path', path.join(outDir, 'phone.png')])
  report.check('the phone screenshot is captured', fs.statSync(path.join(outDir, 'phone.png')).size > 1000, path.join(outDir, 'phone.png'))

  report.writeEvidence('drive-ui.json')
} finally {
  if (browserStarted) runBrowserHere(['close'])
  stub.stop()
  report.finish()
}
