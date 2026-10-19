// Recovers a worktree that a killed mutation run left dirty.
//
// The driver edits tracked files in place and puts them back when it exits. A
// run that is killed outright (SIGKILL) never reaches that step, so one
// mutation stays applied in the worktree and every later run refuses to
// start, because it cannot tell that leftover apart from the operator's own
// work.
//
// The leftover is recognisable exactly: the working file is byte-for-byte what
// one catalogue mutation produces from the committed file. A file that differs
// in any other way is not a leftover, so it is never written to. Restoring
// therefore undoes the driver's own edit and touches nothing else.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { countOccurrences } from './lib.mjs'

// The committed content of a file, or null when there is none: the file is
// untracked, or the repository has no commit yet.
export function readCommittedFile(repoRoot, file) {
  try {
    return execFileSync('git', ['show', `HEAD:${file}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return null
  }
}

function readWorkingFile(repoRoot, file) {
  try {
    return fs.readFileSync(path.join(repoRoot, file), 'utf8')
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
    // An anchor that is not unique cannot be applied unambiguously, so the
    // driver would have refused this mutation and it cannot be a leftover.
    if (countOccurrences(committed, mutation.find) !== 1) continue
    const working = readWorkingFile(repoRoot, mutation.file)
    if (working === null) continue
    if (working !== committed.replace(mutation.find, mutation.replace)) continue
    leftovers.push({ id: mutation.id, file: mutation.file, committed })
  }
  return leftovers
}

// Put the committed bytes back for every leftover found, and report the files
// that were restored so the operator can see what changed.
export function restoreLeftoverMutations({ repoRoot, mutations }) {
  const restored = []
  for (const leftover of findLeftoverMutations({ repoRoot, mutations })) {
    const target = path.join(repoRoot, leftover.file)
    fs.writeFileSync(target, leftover.committed)
    if (fs.readFileSync(target, 'utf8') !== leftover.committed) {
      throw new Error(`could not restore ${leftover.file}`)
    }
    restored.push(leftover.file)
  }
  return restored
}
