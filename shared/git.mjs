// ─── Best-effort git branch detection ────────────────────────────────────────

import { execFile, execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { getExtendedPathEnv } from './env.mjs'

// Resolved once: git has to be found on the extended PATH, because a dashboard
// started by systemd or launchd inherits a minimal one.
const gitEnv = getExtendedPathEnv()

function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

// Return the current branch for the given directory, or '' if not a git repo.
export function detectGitBranch(dir) {
  if (!dir || !isDirectory(dir)) return ''

  try {
    const branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2000,
      env: gitEnv,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return branch.trim()
  } catch {
    return ''
  }
}

// Async form for request paths: the sync form blocks the event loop for up to its
// timeout, and one dashboard request resolves the branch of every agent at once.
// Resolves to '' instead of rejecting, like the sync form.
export function detectGitBranchAsync(dir) {
  if (!dir || !isDirectory(dir)) return Promise.resolve('')

  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8', timeout: 2000, env: gitEnv },
      (err, stdout) => resolve(err ? '' : stdout.trim())
    )
  })
}

// Return the git root for the given directory, or '' if not a git repo.
export function detectGitRoot(dir) {
  if (!dir || !isDirectory(dir)) return ''

  try {
    const root = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 2000,
      env: gitEnv,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return root.trim()
  } catch {
    return ''
  }
}
