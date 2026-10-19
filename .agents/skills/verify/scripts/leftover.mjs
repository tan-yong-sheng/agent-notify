// Recognises the worktree state a killed mutation run leaves behind.
//
// The driver edits tracked files in place and puts them back when it exits. A
// run that is killed outright (SIGKILL) never reaches that step, so one
// mutation stays applied and every later run refuses to start, because it
// cannot tell that leftover apart from the operator's own work.
//
// The leftover is recognisable exactly: the working file holds byte-for-byte
// what one catalogue mutation produces from the committed file. A file that
// differs in any other way is not a leftover.
//
// This module only reads. It decides nothing and writes nothing, so the
// driver may load it before it has judged the worktree. The half that writes
// lives in restore.mjs, and the driver loads that only after it has proved,
// from git, that the recovery path is the committed code and not the
// operator's uncommitted version of it.
//
// The mutation catalogue must not target this directory. A killed run that
// left these files mutated would leave the recovery unable to recognise a
// leftover, and an inverted comparison here would make the recovery overwrite
// the operator's own work. The rule and the code it protects both live under
// the scripts directory, so the catalogue cannot reach either.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { countOccurrences } from './lib.mjs'

// The directory holding the verification scripts, and the suite the driver
// reads to decide whether a mutation was caught.
const SCRIPTS_REL = path.join('.agents', 'skills', 'verify', 'scripts')
const SUITE_REL = 'test_cases.test.js'

// The real path of a file, with symlinks resolved. A path that does not exist
// on disk keeps its resolved path, because there is nothing on disk to
// canonicalise.
function canonicalPath(repoRoot, target) {
  const abs = path.resolve(repoRoot, target)
  try {
    return fs.realpathSync(abs)
  } catch {
    return abs
  }
}

// Two paths name the same file when they are the same string.
function samePath(a, b) {
  return a === b
}

// Whether a path lies inside a directory.
function isUnder(child, parent) {
  return child.startsWith(parent + path.sep)
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

// The bytes the working file holds right now, or null when it cannot be read.
export function readWorkingFile(repoRoot, file) {
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
export function expectedBytes(committed, mutation) {
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
// The replacement must be absent from the committed file, or holding it in the
// working file says nothing: the shipped code already contains that text
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
