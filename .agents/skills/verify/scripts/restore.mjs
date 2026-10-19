// Recovers a worktree that a killed mutation run left dirty.
//
// The driver edits tracked files in place and puts them back when it exits. A
// run that is killed outright (SIGKILL) never reaches that step, so one
// mutation stays applied in the worktree and every later run refuses to
// start, because it cannot tell that leftover apart from the operator's own
// work.
//
// The leftover is recognisable exactly: the working file holds byte-for-byte
// what one catalogue mutation produces from the committed file. A file that
// differs in any other way is not a leftover, so it is never written to.
// Restoring therefore undoes the driver's own edit and touches nothing else.
//
// This module sits on the driver's recovery path, so the mutation catalogue
// must not target it. A killed run that left this file mutated would leave
// the recovery unable to recognise a leftover, and an inverted comparison here
// would overwrite the operator's own work. The rule and the code it protects
// both live under the scripts directory, so the catalogue cannot reach either.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { countOccurrences } from './lib.mjs'

// The directory holding the verification scripts.
export function scriptsDir(repoRoot) {
  return path.resolve(repoRoot, '.agents/skills/verify/scripts')
}

// The real path of a file, with symlinks resolved and the on-disk case
// taken. A file that does not exist keeps its resolved-but-not-canonical
// path, because there is nothing on disk to canonicalise.
function canonical(repoRoot, target) {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

// The files the mutation catalogue must not target. The suite is protected for
// the same reason as the scripts: the driver reads it to decide whether a
// mutation was caught, so an entry that deleted an assertion would unmake the
// proof. The comparison is on the canonical path, so a symlink to a protected
// file and a differently cased spelling of it on a case-insensitive
// filesystem are the same file and are refused too.
export function isProtectedFile(repoRoot, file) {
  const scripts = canonical(repoRoot, scriptsDir(repoRoot))
  const suite = canonical(repoRoot, path.resolve(repoRoot, 'test_cases.test.js'))
  const target = canonical(repoRoot, path.resolve(repoRoot, file))
  return target === suite || target === scripts || target.startsWith(scripts + path.sep)
}

// Whether the verification scripts have uncommitted changes. The recovery runs
// code from the worktree, so when that code is the operator's uncommitted
// version it is not the shipped recovery and must not be trusted with the
// tree. Only tracked modifications count: a stray untracked file in the
// directory does not change the code the recovery runs.
//
// The answer is tri-state: true, false, or null when git could not be read.
// An unknown state is not a clean one, so the caller must not act on it.
export function scriptsAreDirty(repoRoot) {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=no', '--', path.relative(repoRoot, scriptsDir(repoRoot))], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return out !== ''
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

function readWorkingFile(repoRoot, file) {
  try {
    return fs.readFileSync(path.join(repoRoot, file))
  } catch {
    return null
  }
}

// The bytes a mutation leaves behind: the committed content with the
// mutation's find replaced by its replacement, exactly as the driver writes
// it. A mutation that replaces text with itself changes nothing, so it can
// never be a leftover.
function expectedBytes(committed, mutation) {
  if (mutation.find === mutation.replace) return null
  const text = committed.toString('utf8')
  // An anchor that is not unique cannot be applied unambiguously, so the
  // driver would have refused this mutation and it cannot be a leftover.
  if (countOccurrences(text, mutation.find) !== 1) return null
  return Buffer.from(text.replace(mutation.find, mutation.replace), 'utf8')
}

// The mutations that are applied to the worktree right now, in the sense that
// the file holds exactly the mutated bytes of the committed file.
export function findLeftoverMutations({ repoRoot, mutations, cache }) {
  const leftovers = []
  for (const mutation of mutations) {
    // A protected file is never a leftover to undo, even if the catalogue
    // somehow held one: this module is the last line of defence for the
    // rule that keeps the catalogue off the recovery path.
    if (isProtectedFile(repoRoot, mutation.file)) continue
    const committed = readCommittedFile(repoRoot, mutation.file, cache)
    if (committed === null) continue
    const expected = expectedBytes(committed, mutation)
    if (expected === null) continue
    const working = readWorkingFile(repoRoot, mutation.file)
    if (working === null) continue
    if (!working.equals(expected)) continue
    leftovers.push({ id: mutation.id, file: mutation.file, committed, expected, mutation })
  }
  return leftovers
}

// The files where a shipped fix looks reverted in the worktree: the working
// file holds the mutation's replacement and no longer holds the fix it
// replaced. A leftover that the operator has since edited looks like this, and
// so does a fix reverted by hand, so the driver can name the file instead of
// leaving the operator to guess.
//
// The replacement must be absent from the committed file, or holding it in
// the working file says nothing: the shipped code already contains that text
// somewhere else.
export function findRevertedFixes({ repoRoot, mutations, cache }) {
  const reverted = []
  for (const mutation of mutations) {
    // An empty replacement matches every file, so it says nothing.
    if (!mutation.replace) continue
    const committed = readCommittedFile(repoRoot, mutation.file, cache)
    if (committed === null) continue
    const text = committed.toString('utf8')
    if (countOccurrences(text, mutation.find) !== 1) continue
    if (text.includes(mutation.replace)) continue
    const working = readWorkingFile(repoRoot, mutation.file)
    if (working === null) continue
    const current = working.toString('utf8')
    if (current.includes(mutation.find)) continue
    if (!current.includes(mutation.replace)) continue
    reverted.push({ id: mutation.id, file: mutation.file })
  }
  return reverted
}

// Put the committed bytes back for every leftover found, and report the files
// that were restored so the operator can see what changed.
//
// The write goes through a temporary file and a rename, so an interrupt
// cannot leave a half-written file behind: the target is either the leftover
// or the committed content. A symlink is written through instead, the way the
// driver's own restore writes, so the recovery does not replace a link with a
// regular file. The working file's mode is kept, so a mode the operator set
// survives; for a file nobody touched that is the committed mode, and
// restoring the content then leaves the tree clean.
//
// The file is re-read and re-matched immediately before the write. The
// decision to write was taken earlier, and an operator save or a commit that
// landed in between must not be overwritten.
//
// `beforeWrite` is called before each write. Returning anything falsy stops
// the recovery, so a driver that has lost its lock can stop touching the
// tree.
export function restoreLeftoverMutations({ repoRoot, mutations, beforeWrite, cache }) {
  const restored = []
  const skipped = []
  for (const leftover of findLeftoverMutations({ repoRoot, mutations, cache })) {
    if (beforeWrite && !beforeWrite(leftover)) break
    const committed = readCommittedFile(repoRoot, leftover.file)
    const working = readWorkingFile(repoRoot, leftover.file)
    const expected = committed === null ? null : expectedBytes(committed, leftover.mutation)
    if (expected === null || working === null || !working.equals(expected)) {
      skipped.push(leftover.file)
      continue
    }
    const target = path.join(repoRoot, leftover.file)
    let mode = 0o644
    try {
      mode = fs.statSync(target).mode & 0o777
    } catch {}
    try {
      if (fs.lstatSync(target).isSymbolicLink()) {
        fs.writeFileSync(target, committed)
      } else {
        const temp = `${target}.restore-tmp`
        try {
          fs.writeFileSync(temp, committed, { mode })
          fs.chmodSync(temp, mode)
          fs.renameSync(temp, target)
        } finally {
          try {
            fs.rmSync(temp, { force: true })
          } catch {}
        }
      }
    } catch (err) {
      throw new Error(`could not restore ${leftover.file}: ${err.message}`)
    }
    if (fs.readFileSync(target).equals(committed) === false) {
      throw new Error(`could not restore ${leftover.file}`)
    }
    restored.push(leftover.file)
  }
  return { restored, skipped }
}
