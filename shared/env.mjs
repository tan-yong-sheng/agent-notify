// ─── .env file parser ────────────────────────────────────────────────────────

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function stripQuotes(value) {
  const quote = value[0]
  if (quote !== '"' && quote !== "'") return value
  return value.endsWith(quote) ? value.slice(1, -1) : value
}

function parseEnvLine(line) {
  const match = line.match(/^([^#]\S*)\s*=\s*(.*)$/)
  if (!match) return null
  return [match[1].trim(), stripQuotes(match[2].trim())]
}

function readEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null
  return fs.readFileSync(filePath, 'utf-8')
}

// Returns a flat object from any .env file path (KEY=VALUE, supports quotes).
export function loadEnv(filePath) {
  const content = readEnvFile(filePath)
  if (content === null) return {}
  const env = {}
  for (const line of content.split('\n')) {
    const parsed = parseEnvLine(line)
    if (parsed) env[parsed[0]] = parsed[1]
  }
  return env
}

const configHome = () => process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')

// Orca installs its CLI shim in its config dir, not in /usr/bin, and a service does
// not inherit the PATH an Orca pane injects. Without this entry `orca` resolves to
// GNOME's screen reader, which shares the name and rejects `worktree ps --json`,
// so Orca agents disappear from the dashboard exactly when it runs as a service.
const DEFAULT_EXTRA_DIRS = [
  '/home/linuxbrew/.linuxbrew/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
  path.join(configHome(), 'orca', 'linux-orca-cli-shim'),
]

// Builds process.env with common binary directories prepended to PATH if they exist.
export function getExtendedPathEnv(extraDirs) {
  const dirs = extraDirs ?? DEFAULT_EXTRA_DIRS
  const pathStr = process.env.PATH ?? ''
  const current = pathStr.split(path.delimiter)
  const additions = dirs.filter((d) => !current.includes(d) && fs.existsSync(d))
  return { ...process.env, PATH: [...additions, ...current].join(path.delimiter) }
}
