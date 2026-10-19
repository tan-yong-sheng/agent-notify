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
// their other work. The deciding half of the recovery lives in leftover.mjs
// and is loaded under the same guard, because it decides which of the
// operator's files would be overwritten.
//
// The mutation catalogue must not target this directory. A killed run that
// left this file mutated would leave the recovery unable to recognise a
// leftover, and an inverted comparison here would overwrite the operator's own
// work. The rule and the code it protects both live under the scripts
// directory, so the catalogue cannot reach either.

import fs from 'node:fs'
import path from 'node:path'
import { findLeftoverMutations, expectedBytes, readCommittedFile, readWorkingFile } from './leftover.mjs'

// Whether the file really sits inside the repository. The leaf is checked
// separately, because a link there is the operator's own file; this resolves
// the directories above it, which a link can point out of the repository.
//
// The recovery does not use the shared helpers for this: they live in a
// module the driver loads before the gate, and the recovery must not depend
// on anything that is not behind the gate.
function insideRepo(repoRoot, target) {
  try {
    const root = fs.realpathSync(repoRoot)
    const dir = fs.realpathSync(path.dirname(target))
    return dir === root || dir.startsWith(root + path.sep)
  } catch {
    return false
  }
}

// Put the committed bytes back for every leftover found, and report the files
// that were restored so the operator can see what changed.
//
// The write goes through a temporary file and a rename, so an interrupt
// cannot leave a half-written file behind: the target is either the leftover
// or the committed content. The working file's mode is kept, so a mode the
// operator set survives; for a file nobody touched that is the committed mode,
// and restoring the content then leaves the tree clean.
//
// The file is re-read and re-matched twice: once before the temporary file is
// written, and once more immediately before the rename. The decision to write
// was taken earlier, and an operator save that lands in between must not be
// overwritten. The window that is left is the rename syscall itself.
//
// A symlink is not written through. The link may point outside the
// repository, and the recovery would put the committed content somewhere the
// operator never asked for. A tracked path that is a symlink holds the link
// text in git, so it cannot be a leftover in the first place; the case that
// matters is an operator who replaced a tracked file with a link, and that
// file is theirs to put back.
//
// The directories above the file are resolved as well, because a link there
// would put the committed content outside the repository just as surely as a
// link at the file itself.
//
// The temporary file is created exclusively, at a path that is fixed and
// therefore predictable: a link planted there must not receive the committed
// bytes either.
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
      skipped.push({ file: leftover.file, reason: 'the committed content no longer produces this leftover' })
      continue
    }
    const working = readWorkingFile(repoRoot, leftover.file)
    if (working === null || !working.equals(expected)) {
      skipped.push({ file: leftover.file, reason: 'the file changed while the leftover was being recovered' })
      continue
    }
    const target = path.join(repoRoot, leftover.file)
    try {
      if (fs.lstatSync(target).isSymbolicLink()) {
        skipped.push({ file: leftover.file, reason: 'the file is a symlink, so the recovery does not write through it' })
        continue
      }
    } catch {}
    if (!insideRepo(repoRoot, target)) {
      skipped.push({ file: leftover.file, reason: 'the file is reached through a link that leaves the repository, so the recovery does not write through it' })
      continue
    }
    let mode = 0o644
    try {
      mode = fs.statSync(target).mode & 0o777
    } catch {}
    const temp = `${target}.restore-tmp`
    try {
      // The temporary path is predictable, so anything standing there is
      // removed first and the file is created exclusively: the committed
      // bytes cannot land in a link's destination.
      fs.rmSync(temp, { force: true })
      fs.writeFileSync(temp, committed, { mode, flag: 'wx' })
      fs.chmodSync(temp, mode)
      if (beforeWrite && !beforeWrite(leftover)) break
      const latest = readWorkingFile(repoRoot, leftover.file)
      if (latest === null || !latest.equals(expected)) {
        skipped.push({ file: leftover.file, reason: 'the file changed between the check and the write' })
        continue
      }
      fs.renameSync(temp, target)
    } catch (err) {
      throw new Error(`could not restore ${leftover.file}: ${err.message}`)
    } finally {
      try {
        fs.rmSync(temp, { force: true })
      } catch {}
    }
    if (fs.readFileSync(target).equals(committed) === false) {
      throw new Error(`could not restore ${leftover.file}`)
    }
    restored.push(leftover.file)
  }
  return { restored, skipped }
}
