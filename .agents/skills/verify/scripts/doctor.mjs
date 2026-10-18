#!/usr/bin/env node

// Read-only health check: "is this dashboard instance worth driving?"
// It never starts, stops, or changes anything.
//
// Usage: node .agents/skills/verify/scripts/doctor.mjs [--port 3333] [--expect-sha SHA]

import { parseArgs, flagValue, httpGet, rawGet, gitHead, isDirty, REPO_ROOT } from './lib.mjs'

const flags = parseArgs(process.argv.slice(2))
const port = Number(flagValue(flags, 'port', process.env.DASHBOARD_PORT || 3333))
const expectSha = flagValue(flags, 'expect-sha', '')

const lines = []
let healthy = true

function check(name, ok, detail) {
  lines.push(`${ok ? 'ok  ' : 'BAD '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) healthy = false
}

const agents = await httpGet(`http://127.0.0.1:${port}/api/agents`)
const sources = agents.json?.sources
// `typeof null === 'object'`, so a null `sources` must be refused explicitly.
const sourcesOk = Boolean(sources) && typeof sources === 'object' && !Array.isArray(sources) && 'orca' in sources && 'herdr' in sources
const shapeOk = agents.status === 200 && Array.isArray(agents.json?.agents) && sourcesOk
check(
  `port ${port} serves the dashboard API`,
  shapeOk,
  agents.status === 0
    ? `nothing listening (${agents.error})`
    : shapeOk
      ? `${agents.json.agents.length} agents`
      : `HTTP ${agents.status}, unexpected body`
)

if (shapeOk) {
  const page = await httpGet(`http://127.0.0.1:${port}/`)
  check('page serves the dashboard HTML', page.status === 200 && /<title>Agent Monitor<\/title>/.test(page.text), `HTTP ${page.status}`)

  const update = await httpGet(`http://127.0.0.1:${port}/api/update`)
  check('update endpoint answers with a status object', update.status === 200 && typeof update.json?.hasUpdate === 'boolean', `HTTP ${update.status}`)

  const forbidden = await rawGet(port, '/api/agents', 'evil.example')
  check('a foreign Host header is refused', forbidden.status === 403, `HTTP ${forbidden.status}`)
} else if (agents.status === 200) {
  check('port is not held by an unrelated server', false, 'another process answered instead; start the dashboard on a free port with --port')
}

const head = gitHead(REPO_ROOT)
check('checkout revision', true, `${head}${isDirty(REPO_ROOT) ? ' (dirty worktree)' : ''}`)
if (expectSha && head !== expectSha) check(`checkout matches --expect-sha ${expectSha}`, false, `found ${head}`)

console.log(lines.join('\n'))
console.log(healthy ? '\ninstance looks drivable' : '\ninstance is not drivable')
process.exit(healthy ? 0 : 1)
