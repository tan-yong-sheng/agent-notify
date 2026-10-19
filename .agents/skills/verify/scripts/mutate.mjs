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
import { fileURLToPath } from 'node:url'
import { parseArgs, flagValue, makeReport, restoreOutcomeMessage, REPO_ROOT, ARTIFACTS, gitHead, isDirty, isProtectedFile } from './lib.mjs'

const flags = parseArgs(process.argv.slice(2))
// A flag that is present is a flag, whatever follows it: `--restore` must
// not turn into a full mutation sweep because a file name came after it.
const preflight = Object.hasOwn(flags, 'preflight')
const restoreOnly = Object.hasOwn(flags, 'restore')
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

// The catalogue, the reader and the writer are the modules the recovery and
// the run depend on. The driver loads them with a dynamic import, and only
// once the gate has passed, so that an operator's uncommitted version of any
// of them is never evaluated. A static import would evaluate it while the
// driver starts, before the gate had a say, and that version would then decide
// which of the operator's files the recovery overwrites.
//
// The preflight is the one path that loads them without the gate: it changes
// nothing, it only reports what the catalogue would do.
let MUTATIONS = null
let countOccurrences = null
let readCommittedFile = null
let restoreLeftoverMutations = null
let leftoverModule = null

async function loadCatalogueModules() {
  const [catalogue, leftover] = await Promise.all([import('./mutations.mjs'), import('./leftover.mjs')])
  MUTATIONS = catalogue.MUTATIONS
  countOccurrences = leftover.countOccurrences
  readCommittedFile = leftover.readCommittedFile
  leftoverModule = leftover
}

if (preflight) {
  try {
    await loadCatalogueModules()
  } catch (err) {
    console.error(`refusing to run: could not load the catalogue (${err.message})`)
    process.exit(2)
  }
  const selected = MUTATIONS.filter((m) => !only || m.id === only)
  if (!selected.length) {
    console.error(only ? `no mutation with id "${only}"` : 'no mutations defined')
    process.exit(2)
  }
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
  console.error(`refusing to run: the mutation lock was not ours after it was taken (${lockProblem() ?? 'the lock names another driver'})`)
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

// Whether this driver still holds the lock, and what happened to it if not.
// The lock file can be gone (somebody removed it) or unreadable (a
// half-written file), and neither of those is another driver taking over.
function lockState() {
  if (!fs.existsSync(lockFile)) return 'gone'
  const holder = readLockHolder()
  if (holder === null) return 'unreadable'
  return holder.pid === process.pid ? 'ours' : 'other'
}

// What stopped this driver from holding the lock, in words the operator can
// act on. A takeover, a deleted lock file and an unreadable one are three
// different problems, and saying "another driver took over" when there is no
// other driver sends the operator looking in the wrong place.
function lockProblem() {
  const state = lockState()
  if (state === 'other') return 'another mutation driver took the lock over'
  if (state === 'gone') return 'the mutation lock file is gone'
  if (state === 'unreadable') return 'the mutation lock file cannot be read'
  return null
}

// Whether this driver may still write. A driver that has already released
// its own lock is done, so its own exit handler is not a takeover.
const lockIsOurs = () => lockReleased || lockState() === 'ours'

// The `finally` at the end of the run covers ordinary failures. A signal
// arriving while the test child runs would skip it, so restore from the
// in-memory copy on the way out. These handlers are registered before the
// leftover recovery, so an interrupt during the recovery still releases the
// lock and the tree is left as it was found.
//
// A driver that has lost the lock does not write: another driver has taken
// the lock over and may be mutating the very file this one would write, so
// writing would corrupt that run's evidence.
// What the driver did about the files it touched. The message on the way out
// has to say what happened, not what the driver hoped happened: a restore
// that happened, a restore that was refused because the lock was lost, and a
// restore whose writes failed are three different problems, and the operator
// has to be able to tell them apart.
let restoreOutcome = null

// The driver puts back the files it mutated, and it puts them where they
// were. A file the operator replaced with a link, or a directory above it
// replaced with one, would put the content somewhere the operator never
// asked for, so a link is refused here for the same reason the recovery
// refuses one. The recovery keeps its own copy of this rule: it may not
// depend on a module the guard has not cleared.
function writeTargetIsSafe(target) {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) return false
    const dir = fs.realpathSync(path.dirname(target))
    const root = fs.realpathSync(REPO_ROOT)
    return dir === root || dir.startsWith(root + path.sep)
  } catch {
    return false
  }
}

function restoreOnce() {
  if (restoreOutcome) return restoreOutcome
  if (!lockIsOurs()) {
    const problem = lockProblem()
    console.error(`not restoring the files this driver touched: ${problem}`)
    restoreOutcome = { restored: 0, touched: touched.size, lostLock: problem, failed: false }
    releaseLock()
    return restoreOutcome
  }
  let count = 0
  let failed = false
  for (const [file, source] of touched) {
    if (!writeTargetIsSafe(file)) {
      failed = true
      console.error(`could not restore ${file}: the path is not a plain file inside the repository`)
      continue
    }
    try {
      fs.writeFileSync(file, source)
      count++
    } catch (err) {
      failed = true
      console.error(`could not restore ${file}: ${err.message}`)
    }
  }
  releaseLock()
  restoreOutcome = { restored: count, touched: touched.size, lostLock: null, failed }
  return restoreOutcome
}

process.on('exit', () => { restoreOnce() })
const INTERRUPTS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP'])
for (const signal of INTERRUPTS) {
  process.on(signal, () => {
    const outcome = restoreOnce()
    console.error(`\n${signal}: ${restoreOutcomeMessage(outcome)}`)
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
}

// Say what the recovery found, in facts rather than guesses about who owns the
// changes. A leftover that the operator has since edited no longer matches
// byte for byte, so it is named as a reverted fix instead of being claimed.
//
// The naming lives in the recovery path, so it is only available when the
// guard let that path load. When the guard refused, the driver says so rather
// than naming files from code it did not trust.
function reportUnrecovered() {
  if (!leftoverModule || !MUTATIONS) {
    console.error('           the recovery path was not loaded, so the files that look reverted are not named')
    return
  }
  const reverted = leftoverModule.findRevertedFixes({ repoRoot: gitRoot, mutations: MUTATIONS, cache: committedCache })
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
// edits to the modules that carry it, that code is theirs and not the shipped
// one, so the recovery is skipped rather than run against their other work.
//
// The gate asks git about those modules and about nothing else, and it asks
// git itself: the decision procedure lives here, in the driver, and not in
// the code it gates. A gate whose own implementation sat inside the gated set
// could be edited to lie, and the recovery would then run the operator's
// version of itself.
//
// The gate covers exactly the modules the recovery evaluates: the two halves
// of the recovery, the reader they fetch the committed and the working bytes
// with, and the catalogue the recovery searches. Every one of them is loaded
// with a dynamic import, after the gate has passed, so listing a module here
// is not just a promise but the whole truth about it. A change to a script the
// recovery never loads says nothing about whether the recovery is the shipped
// one, so it does not stop the recovery.
//
// Only tracked modifications count, because a stray untracked file in the
// directory does not change the code the recovery runs.
//
// The answer is tri-state, and only a clean tree lets the recovery run: an
// unknown answer is not a clean one, and neither is an answer the driver does
// not understand.
//
// Only once the gate has passed is the recovery path loaded. Both halves are
// behind the gate, not just the writing one, because the reading half decides
// which of the operator's files the recovery would overwrite.
//
// The repository root, as git sees it. The recovery searches and writes this
// tree, so the root comes from git and not from a module the operator could
// edit: an uncommitted `lib.mjs` must not be able to point the recovery at
// another directory while the gate answers "clean".
const GATE_SCRIPTS_DIR = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)))
function repositoryRoot() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: GATE_SCRIPTS_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim()
  return fs.realpathSync(root)
}

let gitRoot = null
try {
  gitRoot = repositoryRoot()
} catch {
  gitRoot = null
}

// The gate compares the content of the modules with the content in the
// commit. It does not ask git whether the file is modified: `git status`
// answers from the index's stat cache, so a module the operator marked
// assume-unchanged or skip-worktree is reported as clean while its bytes
// differ from the committed ones, and the recovery would then run the
// operator's version of itself.
//
// The comparison is between the bytes on disk and the bytes in the commit.
// A checkout that rewrites line endings holds different bytes for the same
// code, so a difference that is only the line endings is the same file; any
// other difference is a different file and stops the recovery. The gate does
// not ask git what the filters would do to the file, so no filter
// configuration can hide an edit from it.
//
// The paths come from the driver's own location, and the root comes from
// git, so nothing an operator can edit in another module can point the gate
// at the wrong files.
const RECOVERY_MODULES = ['leftover.mjs', 'restore.mjs', 'mutations.mjs']

// Two files that differ only in the line endings a checkout rewrites hold
// the same code.
function sameCode(working, committed) {
  if (working.equals(committed)) return true
  return withoutCarriageReturns(working).equals(withoutCarriageReturns(committed))
}

function withoutCarriageReturns(buffer) {
  return Buffer.from(buffer.toString('binary').split('\r\n').join('\n'), 'binary')
}

function recoveryPathState() {
  try {
    if (!gitRoot) return null
    const scriptsDir = path.relative(gitRoot, GATE_SCRIPTS_DIR).split(path.sep).join('/')
    const differs = RECOVERY_MODULES.some((name) => {
      const rel = `${scriptsDir}/${name}`
      const working = fs.readFileSync(path.join(GATE_SCRIPTS_DIR, name))
      const committed = execFileSync('git', ['cat-file', 'blob', `HEAD:${rel}`], {
        cwd: gitRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return !sameCode(working, committed)
    })
    return differs
  } catch {
    return null
  }
}
const committedCache = new Map()
let recovered = { restored: [], skipped: [] }
let recoverySkipped = false
const recoveryState = recoveryPathState()
if (recoveryState === false) {
  try {
    await loadCatalogueModules()
    ;({ restoreLeftoverMutations } = await import('./restore.mjs'))
  } catch (err) {
    console.error(`refusing to run: could not load the leftover recovery (${err.message})`)
    releaseLock()
    process.exit(2)
  }
  try {
    recovered = restoreLeftoverMutations({
      repoRoot: gitRoot,
      mutations: MUTATIONS,
      cache: committedCache,
      beforeWrite: () => lockIsOurs(),
    })
  } catch (err) {
    console.error(`refusing to run: could not undo the leftover of a killed run (${err.message})`)
    releaseLock()
    process.exit(2)
  }
} else if (recoveryState === true) {
  recoverySkipped = true
  console.error('skipping the leftover recovery: the recovery path has uncommitted changes, so the recovery is not the shipped one')
} else {
  console.error('refusing to run: could not read the worktree state from git, so the leftover recovery cannot be trusted')
  releaseLock()
  process.exit(2)
}
for (const file of recovered.restored) {
  console.log(`restored ${file} — its bytes were exactly what one catalogue mutation produces`)
}
for (const { file, reason } of recovered.skipped) {
  console.error(`left ${file} alone: ${reason}`)
}
if (lockProblem()) {
  console.error(`refusing to run: ${lockProblem()} while the leftover was being recovered`)
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
    console.error('the tracked files still have uncommitted changes')
    reportUnrecovered()
    releaseLock()
    process.exit(1)
  }
  console.log('no tracked file has uncommitted changes')
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

// The tree is clean, so the gate passed and the catalogue is loaded.
if (!MUTATIONS) {
  console.error('refusing to run: the mutation catalogue was not loaded')
  releaseLock()
  process.exit(2)
}
const selected = MUTATIONS.filter((m) => !only || m.id === only)
if (!selected.length) {
  console.error(only ? `no mutation with id "${only}"` : 'no mutations defined')
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
let lockLost = false
let completed = 0
const abortedIds = []

function restoreAll() {
  // A driver that has lost the lock does not write: the driver that took the
  // lock over may be mutating the file this one would write.
  if (!lockIsOurs()) {
    lockLost = true
    restoreOutcome = { restored: 0, touched: touched.size, lostLock: lockProblem(), failed: false }
    return
  }
  let count = 0
  let failed = false
  for (const [file, source] of touched) {
    if (!writeTargetIsSafe(file)) {
      failed = true
      report.check(`restored ${path.relative(REPO_ROOT, file)}`, false, 'the path is not a plain file inside the repository')
      continue
    }
    try {
      fs.writeFileSync(file, source)
      count++
      if (fs.readFileSync(file, 'utf8') !== source) report.check(`restored ${path.relative(REPO_ROOT, file)}`, false, 'file differs from the original after restore')
    } catch (err) {
      failed = true
      report.check(`restored ${path.relative(REPO_ROOT, file)}`, false, `could not restore the file: ${err.message}`)
    }
  }
  restoreOutcome = { restored: count, touched: touched.size, lostLock: null, failed }
}

// The `finally` below covers ordinary failures. A signal arriving while the test
// child runs would skip it, so restore from the in-memory copy on the way out.
// The handlers are registered above, next to the lock, so they are in place
// before the leftover recovery runs.

try {
  for (const mutation of selected) {
    const problem = lockProblem()
    if (problem) {
      interrupted = problem
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
      // A driver that has lost the lock does not write, not even to undo its
      // own mutation: the driver that holds the lock now may be mutating the
      // very file this one would write, and overwriting it would corrupt
      // that run's evidence.
      if (!lockIsOurs()) lockLost = true
      else if (writeTargetIsSafe(state.target)) fs.writeFileSync(state.target, state.source)
      else report.check(`restored ${path.relative(REPO_ROOT, state.target)}`, false, 'the path is not a plain file inside the repository')
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
  const outcome = lockLost
    ? 'the lock was lost, so the files this driver touched were left as they are and the lock was not released'
    : 'every touched file is restored and the lock is released'
  console.error(
    `\nstopped by ${interrupted} after ${completed} of ${selected.length} mutation(s). ${outcome}; nothing was recorded, so the evidence file still describes the last complete run.`
  )
  process.exit(130)
}

if (noticedByAbort) {
  console.log(`\nNOTE  ${noticedByAbort} mutation(s) were noticed only by an abort inside the mutated file: ${abortedIds.join(', ')}`)
  console.log('      Their named test never reported, so they are not proof that it bites. The captured output is in artifacts/mutations/<id>.log.')
}

const after = isDirty(REPO_ROOT, { trackedOnly: true })
if (after === null) report.check('the tracked files are clean after the run', false, 'could not read the worktree state from git')
else if (after) report.check('the tracked files are clean after the run', false, 'mutation driver left changes behind')
else report.check('the tracked files are clean after the run', true)
report.check('the run matches the checked-out revision', true, gitHead())
// A `--only` run must not overwrite the full catalogue's evidence with three
// checks, so a focused run gets its own file next to it.
report.writeEvidence(only ? 'mutations-partial.json' : 'mutations.json')
report.finish()
