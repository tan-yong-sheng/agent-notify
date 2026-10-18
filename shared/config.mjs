// ─── Notification configuration loading (env vars + .env fallbacks) ──────────
// Exposed env vars: PLATFORM_DESKTOP, PLATFORM_NTFY, NTFY_URL, NTFY_TOPIC,
// NTFY_API_KEY, NTFY_PRIORITY_DONE, NTFY_PRIORITY_BLOCKED.
// Everything else uses internal defaults.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadEnv } from './env.mjs'

function resolveConfigValue(envFromConfigDir, envKey, defaultValue) {
  return process.env[envKey] || envFromConfigDir[envKey] || defaultValue
}

function loadEnvFromDir(configDir) {
  return configDir ? loadEnv(path.join(configDir, '.env')) : {}
}

function hasEnvFile(dir) {
  return Boolean(dir) && existsSync(path.join(dir, '.env'))
}

// Pick the first candidate directory that already has a .env file.
// Falls back to fallbackDir (or the first candidate) when none exist yet.
export function resolveConfigDir(candidates = [], fallbackDir = null) {
  const hit = candidates.find(hasEnvFile)
  if (hit) return hit
  return fallbackDir || candidates.find(Boolean) || null
}

function parseBool(value) {
  return value === 'true' || value === '1' || value === true
}

// ─── Dashboard port ─────────────────────────────────────────────────────────
// Shared by the dashboard server and the service installer, so an install
// message reports the port the installed service will actually bind.

const DEFAULT_DASHBOARD_PORT = 3333

function portValueFrom(argv, index) {
  const arg = argv[index]
  return arg.startsWith('--port=') ? arg.slice('--port='.length) : argv[index + 1]
}

// Returns the raw flag value so resolvePort can judge the whole string; parsing
// here would hide a malformed value behind a valid numeric prefix.
function parseCliPort(argv = []) {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i].startsWith('--port=')) {
      return portValueFrom(argv, i)
    }
  }
  return null
}

// `parseInt` accepts a numeric prefix and ignores the rest, so a trailing-garbage
// flag (`--port=3333junk`) or a fractional environment value
// (`DASHBOARD_PORT=3333.5`) would silently bind 3333 instead of falling back.
function resolvePort(value) {
  const text = String(value ?? '').trim()
  return /^\d+$/.test(text) ? asPortNumber(text) : null
}

function asPortNumber(text) {
  const parsed = Number(text)
  return parsed >= 1 && parsed <= 65535 ? parsed : null
}

export function resolveDashboardPort(argv = process.argv, env = process.env, fileEnv = {}) {
  return (
    resolvePort(parseCliPort(argv)) ||
    resolvePort(env.DASHBOARD_PORT || fileEnv.DASHBOARD_PORT) ||
    DEFAULT_DASHBOARD_PORT
  )
}

function parsePriority(value, defaultValue) {
  const num = Number(value)
  if (Number.isFinite(num) && num >= 1 && num <= 5) return num
  return defaultValue
}

export function loadNtfyConfig(configDir) {
  const envFromConfigDir = loadEnvFromDir(configDir)

  return {
    PLATFORM_DESKTOP: parseBool(
      resolveConfigValue(envFromConfigDir, 'PLATFORM_DESKTOP', 'true')
    ),
    PLATFORM_NTFY: parseBool(
      resolveConfigValue(envFromConfigDir, 'PLATFORM_NTFY', 'false')
    ),
    NTFY_URL: resolveConfigValue(envFromConfigDir, 'NTFY_URL', 'http://localhost:10081'),
    NTFY_TOPIC: resolveConfigValue(envFromConfigDir, 'NTFY_TOPIC', 'agent-alerts'),
    NTFY_API_KEY: resolveConfigValue(envFromConfigDir, 'NTFY_API_KEY', ''),
    NTFY_PRIORITY_DONE: parsePriority(
      resolveConfigValue(envFromConfigDir, 'NTFY_PRIORITY_DONE', '4'),
      4
    ),
    NTFY_PRIORITY_BLOCKED: parsePriority(
      resolveConfigValue(envFromConfigDir, 'NTFY_PRIORITY_BLOCKED', '5'),
      5
    ),
  }
}
