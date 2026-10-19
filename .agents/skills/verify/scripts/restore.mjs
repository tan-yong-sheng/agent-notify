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
// would overwrite the operator's own work.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { countOccurrences } from './lib.mjs'

// The committed content of a file as bytes, or null when there is none: the
// file is untracked, or the repository has no commit yet.
export function readCommittedFile(repoRoot, file) {
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

// The mutations that are applied to the worktree right now, in the sense that
// the file holds exactly the mutated bytes of the committed file.
export function findLeftoverMutations({ repoRoot, mutations }) {
  const leftovers = []
  for (const mutation of mutations) {
    const committed = readCommittedFile(repoRoot, mutation.file)
    if (committed === null) continue
    const text = committed.toString('utf8')
    // An anchor that is not unique cannot be applied unambiguously, so the
    // driver would have refused this mutation and it cannot be a leftover.
    if (countOccurrences(text, mutation.find) !== 1) continue
    // The driver writes `read.replace(find, replace)` into the file it read
    // from the worktree, so the same expression on the committed content
    // reproduces the bytes it would have written.
    const expected = text.replace(mutation.find, mutation.replace)
    const working = readWorkingFile(repoRoot, mutation.file)
    if (working === null) continue
    if (working.toString('utf8') !== expected) continue
    leftovers.push({ id: mutation.id, file: mutation.file, committed })
  }
  return leftovers
}

// Put the committed bytes back for every leftover found, and report the files
// that were restored so the operator can see what changed.
//
// The write goes through a temporary file and a rename, so an interrupt
// cannot leave a half-written file behind: the target is either the leftover
// or the committed content.
//
// `beforeWrite` is called before each write. Returning false stops the
// recovery, so a driver that has lost its lock can stop touching the tree.
export function restoreLeftoverMutations({ repoRoot, mutations, beforeWrite }) {
  const restored = []
  for (const leftover of findLeftoverMutations({ repoRoot, mutations })) {
    if (beforeWrite && beforeWrite(leftover) === false) break
    const target = path.join(repoRoot, leftover.file)
    const temp = `${target}.restore-tmp`
    try {
      fs.writeFileSync(temp, leftover.committed)
      fs.renameSync(temp, target)
    } finally {
      try {
        fs.rmSync(temp, { force: true })
      } catch {}
    }
    if (fs.readFileSync(target).equals(leftover.committed) === false) {
      throw new Error(`could not restore ${leftover.file}`)
    }
    restored.push(leftover.file)
  }
  return restored
}
