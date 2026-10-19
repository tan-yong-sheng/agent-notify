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

// Whether the worktree has changes, and whether any of them are in the given
// paths. The paths are resolved against `dir`, which is the directory the git
// command runs in, so a caller passes the path the way git sees it from there.
// The answer is tri-state: true, false, or null when git could not be read.
// An unknown state is not a clean one, so the caller must not act on it as if
// the tree were untouched.
export function isDirty(dir = REPO_ROOT, { trackedOnly = false, paths = [] } = {}) {
  try {
    const args = ['status', '--porcelain']
    if (trackedOnly) args.push('--untracked-files=no')
    // An absolute pathspec means the same file whatever directory git is run
    // in, so a caller cannot pass a path that git reads as somewhere else.
    if (paths.length) args.push('--', ...paths.map((p) => path.resolve(dir, p)))
    return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim() !== ''
  } catch {
    return null
  }
}

// The committed content of a file as bytes, or null when there is none: the
// file is untracked, or the repository has no commit yet.
//
// A `cache` map of file to content keeps a run from asking git for the same
// file once per catalogue entry.
export function readCommittedFile(repoRoot, file, cache) {
  if (cache) {
    if (cache.has(file)) return cache.get(file)
    const content = readCommittedFileUncached(repoRoot, file)
    cache.set(file, content)
    return content
  }
  return readCommittedFileUncached(repoRoot, file)
}

// The bytes the working file holds right now, or null when it cannot be read.
export function readWorkingFile(repoRoot, file) {
  try {
    return fs.readFileSync(path.join(repoRoot, file))
  } catch {
    return null
  }
}

function readCommittedFileUncached(repoRoot, file) {
  try {
    return execFileSync('git', ['show', `HEAD:${file}`], {
      cwd: repoRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return null
  }
}

// The directory holding the verification scripts, and the suite the mutation
// driver reads to decide whether a mutation was caught.
const SCRIPTS_REL = path.join('.agents', 'skills', 'verify', 'scripts')
const SUITE_REL = 'test_cases.test.js'

// The real path of a file, with symlinks resolved. A path that does not exist
// on disk keeps the canonical form of the directory that holds it, so a
// differently cased spelling of a file is still compared against the same
// directory the protected files live in. A symlink is followed even when its
// target is missing, because a link to a protected file reaches it just as
// well as the file itself does.
function canonicalPath(repoRoot, target) {
  return resolvePath(path.resolve(repoRoot, target), [], 0)
}

function resolvePath(abs, tail, depth) {
  const parts = [...tail]
  let current = abs
  for (;;) {
    let link = null
    try {
      if (fs.lstatSync(current).isSymbolicLink()) link = fs.readlinkSync(current)
    } catch {}
    if (link !== null) {
      // A link that points at itself must not spin forever.
      if (depth > 8) return abs
      return resolvePath(path.resolve(path.dirname(current), link), parts, depth + 1)
    }
    try {
      const real = fs.realpathSync(current)
      return parts.length ? path.join(real, ...parts) : real
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return abs
      parts.unshift(path.basename(current))
      current = parent
    }
  }
}

// Two paths name the same file when they are the same string or the same
// string in a different case. The case-insensitive half is deliberate: a
// catalogue entry that spells a protected file with a different case reaches
// the very same file on a case-insensitive filesystem, and the guard must not
// depend on which filesystem the operator happens to run on. Comparing the
// case-folded paths refuses that spelling everywhere, which is the safe side
// to err on: a file the driver refuses to mutate is never a wrong refusal
// that costs the operator anything.
function samePath(a, b) {
  return a === b || a.toLowerCase() === b.toLowerCase()
}

// Whether a path lies inside a directory, compared the same way.
function isUnder(child, parent) {
  return child.toLowerCase().startsWith(parent.toLowerCase() + path.sep.toLowerCase())
}

// The files the mutation catalogue must not target. The suite is protected for
// the same reason as the scripts: the driver reads it to decide whether a
// mutation was caught, so an entry that deleted an assertion would unmake the
// proof.
//
// The comparison is on the canonical path, so a symlink to a protected file is
// the protected file, and it folds case, so a differently cased spelling is
// refused on every filesystem rather than only where the filesystem itself
// folds case.
export function isProtectedFile(repoRoot, file) {
  const scripts = canonicalPath(repoRoot, SCRIPTS_REL)
  const suite = canonicalPath(repoRoot, SUITE_REL)
  const target = canonicalPath(repoRoot, file)
  if (samePath(target, suite) || samePath(target, scripts)) return true
  return isUnder(target, scripts)
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
