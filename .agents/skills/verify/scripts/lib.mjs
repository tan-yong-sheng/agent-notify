// Shared helpers for the verification drivers. Kept in one place so every driver
// reports, waits, and cleans up the same way.
//
// This file is the drivers' own plumbing. The leftover recovery does not use
// it: the recovery reads the committed and the working bytes with the reader
// in leftover.mjs, so that everything the recovery depends on is loaded
// together, behind the driver's gate, and never before it.

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

// Whether the worktree has changes. The answer is tri-state: true, false, or
// null when git could not be read. An unknown state is not a clean one, so
// the caller must not act on it as if the tree were untouched.
//
// This helper is not the guard the driver uses before it runs the leftover
// recovery: a guard that lived in a file the operator can edit could be
// edited to lie. The driver asks git itself, about the modules the recovery
// evaluates.
export function isDirty(dir = REPO_ROOT, { trackedOnly = false } = {}) {
  try {
    const args = ['status', '--porcelain']
    if (trackedOnly) args.push('--untracked-files=no')
    return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim() !== ''
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
// A chain deeper than this is not a link an operator meant to write; it is a
// cycle or a machine-generated nest. The bound exists to stop the walk, not to
// limit how many links a real path may hold.
const MAX_SYMLINK_DEPTH = 32

function canonicalPath(repoRoot, target) {
  return resolvePath(path.resolve(repoRoot, target), [], 0)
}

// The real path of a link chain, or null when the chain cannot be followed to
// the end. Returning the unresolved path instead would hand back a string that
// names nothing comparable, and a protected file reached through a long chain
// would then compare unequal to the protected path it really is.
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
      if (depth >= MAX_SYMLINK_DEPTH) return null
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
//
// A path whose link chain cannot be followed is protected, because the driver
// cannot show that it is not: a chain too long to resolve has no comparable
// name, and treating it as unprotected would let a catalogue entry reach the
// protected files through a nest of links.
export function isProtectedFile(repoRoot, file) {
  const scripts = canonicalPath(repoRoot, SCRIPTS_REL)
  const suite = canonicalPath(repoRoot, SUITE_REL)
  const target = canonicalPath(repoRoot, file)
  if (target === null || scripts === null || suite === null) return true
  if (samePath(target, suite) || samePath(target, scripts)) return true
  return isUnder(target, scripts)
}

// Write to a path without following a link at the end of it.
//
// The driver checks a path before it writes to it, and a check that is a
// separate step from the write leaves a window: a file that is a plain file
// when it is checked can be a link by the time it is written, and the write
// would then put the content into the link's destination. Opening the file
// itself with O_NOFOLLOW closes that window for the last component of the
// path, so a link there fails the write instead of receiving it. The
// directories above the file are not covered by the flag; those are checked
// by the caller, and the same gap is left open by the recovery's write.
export function writeFileNoFollow(target, content) {
  const noFollow = fs.constants.O_NOFOLLOW || 0
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow
  const fd = fs.openSync(target, flags)
  try {
    fs.writeFileSync(fd, content)
  } finally {
    fs.closeSync(fd)
  }
}

// What the driver says on its way out, in words that do not claim a restore
// that did not happen. The three cases are different problems and the
// operator has to be able to tell them apart: a restore that happened, a
// restore that was refused because the lock was lost, and a restore whose
// writes failed. A driver that lost the lock says so, and a driver whose
// writes failed says that instead of blaming a lock it still holds.
export function restoreOutcomeMessage({ restored, touched, lostLock, failed }) {
  if (lostLock) {
    // A driver that touched nothing has no files to leave alone, so it says
    // that instead of claiming it left files it never wrote.
    return touched === 0
      ? `there was nothing to restore, and ${lostLock}`
      : `left the files this driver touched alone, because ${lostLock}`
  }
  if (touched === 0) return 'there was nothing to restore'
  if (failed) {
    return restored > 0
      ? `restored ${restored} of the ${touched} tracked file(s) it touched, and the rest could not be restored`
      : 'the files this driver touched could not be restored'
  }
  return `restored ${restored} tracked file(s) before exiting`
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
