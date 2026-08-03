// ─── Notification configuration loading (env vars + .env fallbacks) ──────────
// Exposed env vars: PLATFORM_DESKTOP, PLATFORM_NTFY, NTFY_URL, NTFY_TOPIC,
// NTFY_API_KEY. Everything else uses internal defaults.

import path from 'node:path'
import { loadEnv } from './env.mjs'

function resolveConfigValue(envFromConfigDir, envKey, defaultValue) {
  return process.env[envKey] || envFromConfigDir[envKey] || defaultValue
}

function loadEnvFromDir(configDir) {
  return configDir ? loadEnv(path.join(configDir, '.env')) : {}
}

function parseBool(value) {
  return value === 'true' || value === '1' || value === true
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
