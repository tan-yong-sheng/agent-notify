#!/usr/bin/env node

// Drives the dashboard's non-browser surface: startup, the JSON endpoints, the
// listen-failure path, and launching through a symlink.
//
// Usage: node .agents/skills/verify/scripts/drive-api.mjs [--port 4741]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseArgs,
  flagValue,
  freePort,
  httpGet,
  rawGet,
  waitForDashboard,
  startDashboard,
  makeReport,
  DASHBOARD,
} from './lib.mjs'

const flags = parseArgs(process.argv.slice(2))
const basePort = flags.port && flags.port !== true ? Number(flags.port) : await freePort()
const report = makeReport('drive-api')
const started = []

function launch(port, script = DASHBOARD) {
  const proc = startDashboard({ script, port })
  started.push(proc)
  return proc
}

try {
  // ── startup and endpoint contracts ────────────────────────────────────────
  const t0 = Date.now()
  const proc = launch(basePort)
  const ready = await waitForDashboard(basePort)
  report.check('a cold start reaches a usable state', ready.ready, ready.ready ? `in ${Date.now() - t0}ms` : ready.reason)

  if (ready.ready) {
    report.check('startup names the port it bound', proc.output.includes(String(basePort)), proc.output.trim().split('\n')[1] || '')

    const page = await httpGet(`http://127.0.0.1:${basePort}/`)
    report.check('the page is the dashboard', page.status === 200 && page.text.includes('<title>Agent Monitor</title>'), `HTTP ${page.status}`)

    const agents = await httpGet(`http://127.0.0.1:${basePort}/api/agents`)
    const sources = agents.json?.sources || {}
    report.check('agents payload carries rows and source health', Array.isArray(agents.json?.agents) && 'orca' in sources && 'herdr' in sources, `${agents.json?.agents?.length ?? '?'} agents`)

    const update = await httpGet(`http://127.0.0.1:${basePort}/api/update`)
    report.check('update payload is a status object', typeof update.json?.hasUpdate === 'boolean', `hasUpdate=${update.json?.hasUpdate}`)

    const missing = await httpGet(`http://127.0.0.1:${basePort}/nope`)
    report.check('an unknown route is a 404', missing.status === 404, `HTTP ${missing.status}`)

    const rebound = await rawGet(basePort, '/api/agents', 'attacker.example')
    report.check('a DNS-rebinding Host header is refused', rebound.status === 403, `HTTP ${rebound.status}`)
  }

  // ── a second instance on the same port fails cleanly ──────────────────────
  const clash = launch(basePort)
  const clashCode = await clash.closed
  const clashOutput = clash.output
  report.check('a port clash exits non-zero', clashCode === 1, `exit ${clashCode}`)
  report.check('the clash message is actionable', /already in use/.test(clashOutput), clashOutput.trim().split('\n').pop() || '')
  report.check('the clash prints no stack trace', !/\n\s+at /.test(clashOutput))

  // ── launching through a symlink still serves ──────────────────────────────
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-link-'))
  const link = path.join(linkDir, 'dashboard-link.mjs')
  fs.symlinkSync(DASHBOARD, link)
  const symlinkPort = basePort + 1
  const linked = launch(symlinkPort, link)
  const linkedReady = await waitForDashboard(symlinkPort)
  report.check('a symlinked dashboard still serves', linkedReady.ready, linkedReady.ready ? '' : linkedReady.reason)
  linked.stop()
  fs.rmSync(linkDir, { recursive: true, force: true })

  report.writeEvidence('drive-api.json')
} finally {
  for (const proc of started) proc.stop()
  report.finish()
}
