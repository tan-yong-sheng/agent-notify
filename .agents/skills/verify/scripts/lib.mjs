// Shared helpers for the verification drivers. Kept in one place so every driver
// reports, waits, and cleans up the same way.

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..')
export const REPO_ROOT = path.resolve(SKILL_ROOT, '..', '..', '..')
export const ARTIFACTS = path.join(SKILL_ROOT, 'artifacts')
export const DASHBOARD = path.join(REPO_ROOT, 'dashboard.mjs')
export const BROWSER = path.join(SCRIPT_DIR, 'browser.mjs')

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[key] = true
    else {
      flags[key] = next
      i++
    }
  }
  return flags
}

export function flagValue(flags, key, fallback) {
  return flags[key] && flags[key] !== true ? String(flags[key]) : fallback
}

export function countOccurrences(haystack, needle) {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

export function tryJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export async function httpGet(url, options) {
  try {
    const res = await fetch(url, options)
    const text = await res.text()
    return { status: res.status, text, json: tryJson(text) }
  } catch (err) {
    return { status: 0, text: '', json: null, error: err.message }
  }
}

// fetch() drops a custom Host header (a forbidden header name in undici), so the
// DNS-rebinding check goes through node:http directly.
export function rawGet(port, pathName, hostHeader, timeout = 5000) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathName, method: 'GET', headers: { Host: hostHeader }, timeout },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode, text: body, json: tryJson(body) }))
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (err) => resolve({ status: 0, text: '', json: null, error: err.message }))
    req.end()
  })
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

// Ready means "the agents endpoint answers with the shape the page consumes",
// not merely that a socket is open.
export async function waitForDashboard(port, timeout = 15000) {
  const deadline = Date.now() + timeout
  let reason = 'no response'
  while (Date.now() < deadline) {
    const res = await httpGet(`http://127.0.0.1:${port}/api/agents`)
    if (res.status === 200 && res.json && Array.isArray(res.json.agents)) return { ready: true }
    reason = res.error || `HTTP ${res.status}`
    await sleep(120)
  }
  return { ready: false, reason }
}

export function startDashboard({ script = DASHBOARD, port, args = [] }) {
  const child = spawn(process.execPath, [script, '--port', String(port), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const state = {
    child,
    output: '',
    closed: null,
    stop() {
      try {
        child.kill('SIGKILL')
      } catch {}
    },
  }
  child.stdout.on('data', (d) => (state.output += d))
  child.stderr.on('data', (d) => (state.output += d))
  state.closed = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  return state
}

export function gitHead(dir = REPO_ROOT) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir }).toString().trim()
  } catch {
    return 'unknown'
  }
}

export function isDirty(dir = REPO_ROOT, { trackedOnly = false } = {}) {
  try {
    const args = ['status', '--porcelain']
    if (trackedOnly) args.push('--untracked-files=no')
    return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim() !== ''
  } catch {
    return null
  }
}

// One report per driver: every check prints the same way, evidence is written
// once, and the exit code is the reason a run failed.
export function makeReport(title) {
  const results = []
  return {
    results,
    check(name, ok, detail = '') {
      results.push({ name, ok: Boolean(ok), detail: String(detail) })
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
    },
    writeEvidence(fileName) {
      fs.mkdirSync(ARTIFACTS, { recursive: true })
      const file = path.isAbsolute(fileName) ? fileName : path.join(ARTIFACTS, fileName)
      fs.writeFileSync(
        file,
        JSON.stringify({ title, at: new Date().toISOString(), head: gitHead(), results }, null, 2)
      )
      console.log(`evidence: ${file}`)
      return file
    },
    finish() {
      const failed = results.filter((r) => !r.ok)
      console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
      if (failed.length) process.exitCode = 1
      return failed.length === 0
    },
  }
}

export function runBrowser(args, { cwd = REPO_ROOT, timeout = 45000 } = {}) {
  const result = { status: 1, stdout: '', stderr: '' }
  try {
    result.stdout = execFileSync(process.execPath, [BROWSER, ...args], {
      cwd,
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    result.status = 0
  } catch (err) {
    result.status = typeof err.status === 'number' ? err.status : 1
    result.stdout = err.stdout?.toString() || ''
    result.stderr = err.stderr?.toString() || err.message
  }
  return result
}
