// Puts back the worktree a killed mutation run left dirty.
//
// The driver edits tracked files in place and puts them back when it exits. A
// run that is killed outright (SIGKILL) never reaches that step, so one
// mutation stays applied in the worktree and every later run refuses to
// start, because it cannot tell that leftover apart from the operator's own
// work.
//
// This is the only module on the recovery path that writes. The driver loads
// it dynamically, and only after it has asked git whether the recovery path
// still holds the committed code: an operator's uncommitted version of this
// file is their code, not the shipped recovery, and must not be run against
// their other work. The read-only half of the recovery lives in leftover.mjs.
//
// The leftover is recognisable exactly: the working file holds byte-for-byte
// what one catalogue mutation produces from the committed file. A file that
// differs in any other way is not a leftover, so it is never written to.
// Restoring therefore undoes the driver's own edit and touches nothing else.
//
// The mutation catalogue must not target this directory. A killed run that
// left this file mutated would leave the recovery unable to recognise a
// leftover, and an inverted comparison here would overwrite the operator's own
// work. The rule and the code it protects both live under the scripts
// directory, so the catalogue cannot reach either.

import fs from 'node:fs'
import path from 'node:path'
import { findLeftoverMutations, readCommittedFile, readWorkingFile, expectedBytes } from './leftover.mjs'

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
// The file is re-read and re-matched twice: once before the temporary file is
// written, and once more immediately before the rename. The decision to write
// was taken earlier, and an operator save that lands in between must not be
// overwritten. The window that is left is the rename syscall itself.
//
// `beforeWrite` is called before each write, and again just before the
// rename. Returning anything falsy stops the recovery, so a driver that has
// lost its lock can stop touching the tree.
export function restoreLeftoverMutations({ repoRoot, mutations, beforeWrite, cache }) {
  const restored = []
  const skipped = []
  for (const leftover of findLeftoverMutations({ repoRoot, mutations, cache })) {
    if (beforeWrite && !beforeWrite(leftover)) break
    const committed = readCommittedFile(repoRoot, leftover.file)
    const expected = committed === null ? null : expectedBytes(committed, leftover.mutation)
    if (expected === null) {
      skipped.push(leftover.file)
      continue
    }
    const working = readWorkingFile(repoRoot, leftover.file)
    if (working === null || !working.equals(expected)) {
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
          const latest = readWorkingFile(repoRoot, leftover.file)
          if (latest === null || !latest.equals(expected)) {
            skipped.push(leftover.file)
            continue
          }
          if (beforeWrite && !beforeWrite(leftover)) break
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
