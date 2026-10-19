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
// This module is the decision half of the recovery: it decides which working
// files the recovery would overwrite, so it sits on the recovery path and the
// driver loads it only after git has confirmed that the recovery path still
// holds the committed code. A static import would evaluate an operator's
// uncommitted version of this file before the guard had a say, and that
// version would then decide which of their files to overwrite. The writing
// half lives in restore.mjs, and the driver loads that under the same guard.
//
// The mutation catalogue must not target this directory. A killed run that
// left these files mutated would leave the recovery unable to recognise a
// leftover, and an inverted comparison here would make the recovery overwrite
// the operator's own work. The rule lives in lib.mjs, under the same
// directory, so the catalogue cannot reach the rule or the code it protects.
//
// The recovery does not check that rule itself: the gate makes sure the
// catalogue it searches is the shipped one, and the shipped catalogue holds no
// entry that reaches the recovery path, because the driver refuses such an
// entry. The recovery therefore cannot be pointed at these files.
//
// Everything the recovery needs lives in this module and in the module that
// writes: the reader that fetches the committed and the working bytes, the
// counter that checks an anchor is unique, and the two halves of the recovery
// itself. The driver loads all of it with a dynamic import and only after its
// gate has passed, so an operator's uncommitted version of any of it is never
// evaluated. A shared helper in a module the driver loads up front would break
// that: the driver would have evaluated the operator's version of the reader
// before the gate had a say.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// How many times a piece of text appears in another. An anchor that is not
// unique cannot be applied unambiguously, so the driver would have refused the
// mutation and the recovery cannot recognise it as a leftover either.
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
