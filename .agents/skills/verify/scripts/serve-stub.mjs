#!/usr/bin/env node

// Deterministic fixture server for driving the dashboard UI. It serves the real
// page from dashboard.mjs, so the browser exercises the shipped HTML, CSS and
// script, but the agent data comes from fixtures the run controls instead of the
// machine's live Orca/Herdr state.
//
// Usage: node .agents/skills/verify/scripts/serve-stub.mjs [--port 4740] [--fixture mixed]
//   GET /                the real dashboard page
//   GET /api/agents      the current fixture
//   GET /api/update      a stale update status (banner proof)
//   GET /control/fixture?name=<name>   switch fixture
//   GET /control/polls   how many /api/agents requests the page has made
//
// Fixtures: mixed (3 agents), swapped (same agents, reordered), empty.

import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderDashboardHtml } from '../../../../dashboard.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..', '..')

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[key] = true
      else {
        flags[key] = next
        i++
      }
    }
  }
  return flags
}

const flags = parseArgs(process.argv.slice(2))
const port = Number(flags.port || 4740)
const startedAt = Date.now()
let polls = 0

const AGENTS = [
  {
    id: 'orca:alpha',
    source: 'orca',
    agent: 'pi',
    displayName: 'alpha-service',
    cwd: '/tmp/verify-fixtures/alpha-service',
    branch: 'feat/alpha',
    status: 'working',
    tool: 'Bash',
    toolInput: { command: 'node test_cases.test.js' },
    prompt: 'Run the suite and report the failing assertion with its file and line.',
    updatedAt: startedAt - 4000,
  },
  {
    id: 'orca:bravo',
    source: 'orca',
    agent: 'claude',
    displayName: 'bravo-web',
    cwd: '/tmp/verify-fixtures/bravo-web',
    branch: 'fix/bravo',
    status: 'blocked',
    tool: 'Edit',
    toolInput: { file: 'src/app.mjs' },
    prompt: 'Waiting for approval before rewriting the migration.',
    updatedAt: startedAt - 65000,
  },
  {
    id: 'herdr:charlie',
    source: 'herdr',
    agent: 'pi',
    displayName: 'charlie-docs',
    cwd: '/tmp/verify-fixtures/charlie-docs',
    branch: '',
    status: 'done',
    tool: '',
    toolInput: null,
    prompt: '',
    updatedAt: startedAt - 600000,
  },
]

// Same three agents, same ids, different source order and fresher timestamps:
// the payload a poll can return when the upstream list reorders under us.
const SWAPPED = [AGENTS[2], AGENTS[0], AGENTS[1]].map((agent, index) => ({
  ...agent,
  updatedAt: startedAt - index * 1000,
}))

const FIXTURES = {
  mixed: { agents: AGENTS, sources: { orca: { available: true }, herdr: { available: true } } },
  swapped: { agents: SWAPPED, sources: { orca: { available: true }, herdr: { available: true } } },
  empty: { agents: [], sources: { orca: { available: false }, herdr: { available: false } } },
}

const staleStatus = {
  isGit: true,
  hasUpdate: true,
  stale: true,
  localSha: 'aaaaaaa',
  remoteSha: 'bbbbbbb',
  checkedAt: startedAt - 2 * 60 * 60 * 1000,
}

let current = flags.fixture && flags.fixture !== true ? String(flags.fixture) : 'mixed'

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const json = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' })
    res.end(JSON.stringify(body))
  }

  if (url.pathname === '/api/agents') {
    polls++
    return json(FIXTURES[current] || FIXTURES.mixed)
  }
  if (url.pathname === '/api/update') return json(staleStatus)
  if (url.pathname === '/control/fixture') {
    const name = url.searchParams.get('name')
    if (!FIXTURES[name]) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      return res.end(`unknown fixture "${name}"; have ${Object.keys(FIXTURES).join(', ')}`)
    }
    current = name
    return json({ fixture: current })
  }
  if (url.pathname === '/control/polls') return json({ polls })
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(renderDashboardHtml())
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not Found')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`stub dashboard on http://127.0.0.1:${port} (fixture: ${current}, page renders ${path.basename(REPO_ROOT)})`)
})
