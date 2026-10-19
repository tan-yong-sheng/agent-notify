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

import { countOccurrences, isProtectedFile, readCommittedFile, readWorkingFile } from './lib.mjs'

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
