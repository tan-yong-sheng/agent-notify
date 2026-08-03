// ─── Best-effort git branch detection ────────────────────────────────────────

import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'

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
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return branch.trim()
  } catch {
    return ''
  }
}

// Return the git root for the given directory, or '' if not a git repo.
export function detectGitRoot(dir) {
  if (!dir || !isDirectory(dir)) return ''

  try {
    const root = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return root.trim()
  } catch {
    return ''
  }
}
