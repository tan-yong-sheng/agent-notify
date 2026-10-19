#!/usr/bin/env node

// Proves the suite still bites: each mutation reverts one shipped fix and the
// named test must fail. A mutation that survives means the test is decorative.
//
// Usage:
//   node .agents/skills/verify/scripts/mutate.mjs --preflight     check anchors, write nothing
//   node .agents/skills/verify/scripts/mutate.mjs --restore        undo a killed run's leftover, change nothing else
//   node .agents/skills/verify/scripts/mutate.mjs [--only <id>] [--runtime node|bun]
//
// The run refuses to start on a dirty worktree: it edits tracked files in place
// and restores them from memory, so a clean tree is the recovery path. It also
// restores on SIGINT/SIGTERM/SIGHUP and on exit. A `kill -9` is the one case
// those handlers cannot cover, so the next run looks for the leftover it left:
// a file whose bytes are exactly what one catalogue mutation produces from the
// committed file. That leftover is undone before the tree is judged; any other
// dirty file still stops the run.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs, flagValue, makeReport, REPO_ROOT, SKILL_ROOT, ARTIFACTS, gitHead, isDirty, countOccurrences } from './lib.mjs'
import { MUTATIONS } from './mutations.mjs'
import { readCommittedFile, findRevertedFixes, isProtectedFile } from './leftover.mjs'

const flags = parseArgs(process.argv.slice(2))
const preflight = flags.preflight === true
const restoreOnly = flags.restore === true
const only = flagValue(flags, 'only', '')
const runtime = flagValue(flags, 'runtime', 'node')
const testFile = path.join(REPO_ROOT, 'test_cases.test.js')
const testSource = fs.readFileSync(testFile, 'utf8')

// The catalogue targets shipped fixes in the application, never the tooling
// that verifies it: the recovery and the rule that protects it live under the
// scripts directory, so the catalogue cannot reach either. The driver refuses
// such an entry, and `--preflight` reports it as SKIP, so the invariant is
// structural rather than a convention somebody has to remember.
//
// An anchor that is gone from the worktree but still in HEAD is what a killed
// run leaves behind. An anchor that is gone from both was reverted in a
// commit, and no amount of restoring brings it back.
function missingAnchorReason(mutation) {
  const committed = readCommittedFile(REPO_ROOT, mutation.file)
  if (committed !== null && countOccurrences(committed.toString('utf8'), mutation.find) === 0) {
    return 'anchor not found in the worktree or in HEAD — this fix looks reverted in a commit, or moved to another file; check git log for this file'
  }
  const source = fs.existsSync(path.join(REPO_ROOT, mutation.file)) ? fs.readFileSync(path.join(REPO_ROOT, mutation.file), 'utf8') : ''
  // A checkout that rewrites line endings cannot match an LF anchor, and
  // restoring cannot help either, so sending the operator to --restore would
  // be a dead end.
  if (source.includes('\r\n') && !committed?.toString('utf8').includes('\r\n')) {
    return 'anchor not found in the worktree — this checkout rewrites line endings, so the anchor cannot match; the mutation needs a checkout that keeps LF'
  }
  return 'anchor not found in the worktree — a killed mutation run may have replaced it; run with --restore'
}

function inspect(mutation) {
  const target = path.join(REPO_ROOT, mutation.file)
  if (isProtectedFile(REPO_ROOT, mutation.file)) {
    return { usable: false, reason: "this file carries the driver's own recovery path or the suite it reads, and must not be mutated" }
  }
  if (!fs.existsSync(target)) return { usable: false, reason: `missing file ${mutation.file}` }
  const source = fs.readFileSync(target, 'utf8')
  const anchors = countOccurrences(source, mutation.find)
  if (anchors === 0) return { usable: false, reason: missingAnchorReason(mutation) }
  if (anchors > 1) return { usable: false, reason: `anchor appears ${anchors} times` }
  if (!testSource.includes(mutation.expectTest)) {
    return { usable: false, reason: `no test labelled "${mutation.expectTest}"` }
  }
  return { usable: true, target, source }
}

const selected = MUTATIONS.filter((m) => !only || m.id === only)
if (!selected.length) {
  console.error(only ? `no mutation with id "${only}"` : 'no mutations defined')
  process.exit(2)
}

if (preflight) {
  let bad = 0
  for (const mutation of selected) {
    const state = inspect(mutation)
    if (state.usable) console.log(`ok    ${mutation.id}`)
    else {
      bad++
      console.log(`SKIP  ${mutation.id} — ${state.reason}`)
    }
  }
  console.log(`\n${selected.length - bad}/${selected.length} mutations are runnable`)
  process.exit(bad ? 1 : 0)
}

// A lock left by a dead run must not block every later run, and a recycled pid
// must not be mistaken for the holder. Only a pid that is alive but provably
// something else lets a new run take the lock over.
function mutationDriverIsAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
  } catch (err) {
    return err.code === 'EPERM' // alive, just not ours to signal; ESRCH means gone
  }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('mutate.mjs')
  } catch {
    // Nothing to read: macOS and Windows have no /proc, and Linux may not let us
    // look. A live pid is all the OS will tell us, and admitting a second driver
    // is worse than refusing one, so refuse.
    return true
  }
}

// The lock is a plain file: whoever creates it with O_EXCL owns it. Reading it is
// allowed to fail — a half-written or half-deleted file means "no usable holder".
function readLockHolder(file = lockFile) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// The files this driver has mutated, with the content to put back. Declared
// before the lock so the exit and signal handlers can reach it.
const touched = new Map()

// This driver edits tracked files in place, so two runs in one checkout race:
// each restores the other's mutation and the evidence file is written twice.
const lockFile = path.join(ARTIFACTS, '.mutate.lock')
fs.mkdirSync(ARTIFACTS, { recursive: true })
for (let attempt = 0; ; attempt++) {
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' })
    break
  } catch (err) {
    if (err.code !== 'EEXIST' || attempt > 1) {
      console.error(`refusing to run: cannot take the mutation lock at ${lockFile} (${err.code || err.message})`)
      process.exit(2)
    }
    const holder = readLockHolder()
    if (mutationDriverIsAlive(holder?.pid)) {
      console.error(`refusing to run: another mutation driver (pid ${holder.pid}, started ${holder.at}) is working in this checkout`)
      process.exit(2)
    }
    // Taking over a stale lock is itself a race: two starts can both decide the
    // holder is dead. Rename instead of deleting, because a rename moves exactly
    // one file atomically; then check that what moved is the lock that was judged
    // stale. A driver that moved a fresh lock puts it back and refuses, so it can
    // never delete a live holder's lock.
    const stale = `${lockFile}.stale-${process.pid}`
    try {
      fs.renameSync(lockFile, stale)
    } catch {
      continue
    }
    const moved = readLockHolder(stale)
    if (moved?.pid !== holder?.pid || moved?.at !== holder?.at) {
      try {
        fs.renameSync(stale, lockFile)
      } catch {}
      console.error(`refusing to run: the mutation lock changed while it was being taken over (holder pid ${moved?.pid ?? 'unknown'})`)
      process.exit(2)
    }
    fs.rmSync(stale, { force: true })
  }
}
if (readLockHolder()?.pid !== process.pid) {
  console.error('refusing to run: the mutation lock was not ours after it was taken; another driver started at the same time')
  process.exit(2)
}
let lockReleased = false
const releaseLock = () => {
  // Only the holder may remove the lock: a driver that lost it to a takeover
  // must not delete the new owner's.
  if (lockReleased) return
  if (readLockHolder()?.pid !== process.pid) return
  try {
    fs.rmSync(lockFile, { force: true })
    lockReleased = true
  } catch {}
}

// Whether this driver still owns the lock. A driver that has already
// released it is done, so its own exit handler is not a takeover.
const lockIsOurs = () => lockReleased || readLockHolder()?.pid === process.pid

// The `finally` at the end of the run covers ordinary failures. A signal
// arriving while the test child runs would skip it, so restore from the
// in-memory copy on the way out. These handlers are registered before the
// leftover recovery, so an interrupt during the recovery still releases the
// lock and the tree is left as it was found.
//
// A driver that has lost the lock does not write: another driver has taken
// the lock over and may be mutating the very file this one would write, so
// writing would corrupt that run's evidence.
let restored = false
function restoreOnce() {
  if (restored) return
  restored = true
  if (!lockIsOurs()) {
    console.error('not restoring the files this driver touched: the mutation lock was taken over')
    releaseLock()
    return
  }
  for (const [file, source] of touched) {
    try {
      fs.writeFileSync(file, source)
    } catch (err) {
      console.error(`could not restore ${file}: ${err.message}`)
    }
  }
  releaseLock()
}
process.on('exit', restoreOnce)
const INTERRUPTS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP'])
for (const signal of INTERRUPTS) {
  process.on(signal, () => {
    restoreOnce()
    console.error(`\n${signal}: restored ${touched.size} tracked file(s) before exiting`)
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
}

// Say what the recovery found, in facts rather than guesses about who owns the
// changes. A leftover that the operator has since edited no longer matches
// byte for byte, so it is named as a reverted fix instead of being claimed.
function reportUnrecovered() {
  const reverted = findRevertedFixes({ repoRoot: REPO_ROOT, mutations: MUTATIONS, cache: committedCache })
  if (!reverted.length) {
    console.error('           no file matches a leftover of a killed mutation run exactly')
    return
  }
  console.error('           these files look like a shipped fix reverted in the working tree, which is what a leftover of a killed run looks like once it has been edited:')
  for (const file of reverted) console.error(`             ${file.file} (${file.id})`)
  console.error('           check them by hand; --restore only handles a file that matches a leftover exactly')
}

// A run that was killed outright never reached its restore step, so it left one
// mutation applied and every later run refused to start on the tree it dirtied
// itself. The leftover is recognisable exactly — the file holds what one
// catalogue mutation produces from the committed file — so it is undone here,
// under the lock, before the tree is judged. The whole catalogue is searched,
// not just the selected mutations, because the leftover may be any of them.
//
// The lock is re-checked before every write: a driver that lost the lock to a
// takeover must not rewrite the file the new owner is mutating.
//
// The recovery runs code from the worktree. If the operator has uncommitted
// edits to the scripts that carry it, that code is theirs and not the shipped
// one, so the recovery is skipped rather than run against their other work.
//
// The guard is asked of git directly, in the driver's own plumbing, and not of
// the recovery path: a guard that lived inside the code it guards could be
// edited away by the very operator it is meant to hold back. Only tracked
// modifications count, because a stray untracked file in the directory does
// not change the code the recovery runs.
//
// A git failure is not a clean tree, so the driver refuses rather than
// guessing.
//
// Only once the guard has passed is the writing half of the recovery loaded,
// and it is loaded with a dynamic import: a static import would evaluate the
// operator's uncommitted restore.mjs before the guard had a say, so the
// recovery would run code it just refused to trust. The read-only half lives
// in leftover.mjs and is loaded with the driver, because it cannot write.
const committedCache = new Map()
let recovered = { restored: [], skipped: [] }
let recoverySkipped = false
const scriptsPath = path.relative(REPO_ROOT, path.join(SKILL_ROOT, 'scripts'))
const scriptsState = isDirty(REPO_ROOT, { trackedOnly: true, paths: [scriptsPath] })
if (scriptsState === true) {
  recoverySkipped = true
  console.error('skipping the leftover recovery: the verification scripts have uncommitted changes, so the recovery is not the shipped one')
} else if (scriptsState === null) {
  console.error('refusing to run: could not read the worktree state from git, so the leftover recovery cannot be trusted')
  releaseLock()
  process.exit(2)
} else {
  let restoreLeftoverMutations
  try {
    ;({ restoreLeftoverMutations } = await import('./restore.mjs'))
  } catch (err) {
    console.error(`refusing to run: could not load the leftover recovery (${err.message})`)
    releaseLock()
    process.exit(2)
  }
  try {
    recovered = restoreLeftoverMutations({
      repoRoot: REPO_ROOT,
      mutations: MUTATIONS,
      cache: committedCache,
      beforeWrite: () => lockIsOurs(),
    })
  } catch (err) {
    console.error(`refusing to run: could not undo the leftover of a killed run (${err.message})`)
    releaseLock()
    process.exit(2)
  }
}
for (const file of recovered.restored) {
  console.log(`restored ${file} — a killed mutation run had left it mutated`)
}
for (const file of recovered.skipped) {
  console.error(`left ${file} alone: it changed while the leftover was being recovered`)
}
if (readLockHolder()?.pid !== process.pid) {
  console.error('refusing to run: the mutation lock was taken over while the leftover was being recovered')
  releaseLock()
  process.exit(2)
}

if (restoreOnly) {
  if (recoverySkipped) {
    console.error('the leftover recovery was skipped, so the worktree was not touched')
    releaseLock()
    process.exit(2)
  }
  const dirty = isDirty(REPO_ROOT, { trackedOnly: true })
  if (dirty === null) {
    console.error('refusing to run: could not read the worktree state from git')
    releaseLock()
    process.exit(2)
  }
  if (dirty) {
    console.error('the worktree still has uncommitted changes')
    reportUnrecovered()
    releaseLock()
    process.exit(1)
  }
  console.log('the worktree is clean')
  releaseLock()
  process.exit(0)
}

const dirty = isDirty(REPO_ROOT, { trackedOnly: true })
if (dirty === null) {
  console.error('refusing to run: could not read the worktree state from git')
  releaseLock()
  process.exit(2)
}
if (dirty) {
  console.error('refusing to run: tracked files have uncommitted changes, so a broken mutation could not be told apart from your work')
  reportUnrecovered()
  releaseLock()
  process.exit(2)
}

function classify(mutation, output) {
  if (output.includes(`✗ ${mutation.expectTest}`)) return { ok: true, detail: `caught by "${mutation.expectTest}"` }
  if (!/Results:/.test(output)) {
    // An uncaught error kills the suite before it prints a summary. That fails
    // the build, but it is not proof that the named test bites: the run may have
    // died before reaching it. Report it as an abort — never as a caught test.
    if (/SyntaxError/.test(output)) return { ok: false, detail: 'the replacement does not parse' }
    if (output.includes(mutation.file)) {
      return {
        ok: true,
        abort: true,
        detail: `the suite aborted inside ${mutation.file} before printing a summary, so "${mutation.expectTest}" never reported — abort evidence, not a caught test`,
      }
    }
    return { ok: false, detail: 'the suite aborted without naming the mutated file' }
  }
  return { ok: false, detail: `SURVIVED: "${mutation.expectTest}" still passed` }
}

function writeMutationLog(id, output) {
  const dir = path.join(ARTIFACTS, 'mutations')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.log`)
  fs.writeFileSync(file, output)
  return file
}

const report = makeReport('mutate')
let noticedByAbort = 0
let interrupted = null
let completed = 0
const abortedIds = []

function restoreAll() {
  // A driver that has lost the lock does not write: the driver that took the
  // lock over may be mutating the file this one would write.
  if (!lockIsOurs()) {
    console.error('not restoring the files this driver touched: the mutation lock was taken over')
    return
  }
  for (const [file, source] of touched) {
    fs.writeFileSync(file, source)
    if (fs.readFileSync(file, 'utf8') !== source) report.check(`restored ${path.relative(REPO_ROOT, file)}`, false, 'file differs from the original after restore')
  }
  restored = true
}

// The `finally` below covers ordinary failures. A signal arriving while the test
// child runs would skip it, so restore from the in-memory copy on the way out.
// The handlers are registered above, next to the lock, so they are in place
// before the leftover recovery runs.

try {
  for (const mutation of selected) {
    if (readLockHolder()?.pid !== process.pid) {
      interrupted = 'another mutation driver took the lock over'
      break
    }
    const state = inspect(mutation)
    if (!state.usable) {
      report.check(mutation.id, false, `cannot run: ${state.reason}`)
      continue
    }
    if (!touched.has(state.target)) touched.set(state.target, state.source)
    const started = Date.now()
    let output = ''
    try {
      fs.writeFileSync(state.target, state.source.replace(mutation.find, mutation.replace))
      output = execFileSync(runtime, ['test_cases.test.js'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 900000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      output = `${err.stdout || ''}${err.stderr || ''}`
      // Ctrl+C reaches this process only after the synchronous child has died, so
      // an interrupt surfaces here as a killed child, not through the handler
      // below. Record it, stop, and report the run as interrupted instead of
      // counting the half-run mutation as a failure and sweeping the rest.
      if (err.signal && INTERRUPTS.has(err.signal)) interrupted = `${err.signal} while running ${mutation.id}`
    } finally {
      fs.writeFileSync(state.target, state.source)
    }
    if (interrupted) break
    completed++
    const reported = /Results:/.test(output)
    const verdict = classify(mutation, output)
    if (verdict.abort) {
      noticedByAbort++
      abortedIds.push(mutation.id)
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(0)
    const detail = `${mutation.description} — ${verdict.detail}${reported ? '' : ` (see ${path.relative(REPO_ROOT, writeMutationLog(mutation.id, output))})`} in ${seconds}s`
    report.check(mutation.id, verdict.ok, detail)
  }
} finally {
  restoreAll()
  releaseLock()
}

if (interrupted) {
  console.error(
    `\nstopped by ${interrupted} after ${completed} of ${selected.length} mutation(s). Every touched file is restored and the lock is released; nothing was recorded, so the evidence file still describes the last complete run.`
  )
  process.exit(130)
}

if (noticedByAbort) {
  console.log(`\nNOTE  ${noticedByAbort} mutation(s) were noticed only by an abort inside the mutated file: ${abortedIds.join(', ')}`)
  console.log('      Their named test never reported, so they are not proof that it bites. The captured output is in artifacts/mutations/<id>.log.')
}

const after = isDirty(REPO_ROOT, { trackedOnly: true })
if (after === null) report.check('the worktree is clean after the run', false, 'could not read the worktree state from git')
else if (after) report.check('the worktree is clean after the run', false, 'mutation driver left changes behind')
else report.check('the worktree is clean after the run', true)
report.check('the run matches the checked-out revision', true, gitHead())
// A `--only` run must not overwrite the full catalogue's evidence with three
// checks, so a focused run gets its own file next to it.
report.writeEvidence(only ? 'mutations-partial.json' : 'mutations.json')
report.finish()
