// ─── Notification configuration loading (env vars + .env fallbacks) ──────────
// Exposed env vars: PLATFORM_DESKTOP, PLATFORM_NTFY, NTFY_URL, NTFY_TOPIC,
// NTFY_API_KEY. Everything else uses internal defaults.

import path from 'node:path'
import { loadEnv } from './env.mjs'

function resolveConfigValue(envFromConfigDir, envFromFallback, envKey, defaultValue) {
  return process.env[envKey] || envFromConfigDir[envKey] || envFromFallback[envKey] || defaultValue
}

function loadEnvFromDir(configDir) {
  return configDir ? loadEnv(path.join(configDir, '.env')) : {}
}

function parseBool(value) {
  return value === 'true' || value === '1' || value === true
}

export function loadNtfyConfig(configDir, fallbackPath = '/opt/herdr-ntfy-notify/.env') {
  const envFromConfigDir = loadEnvFromDir(configDir)
  const envFromFallback = fallbackPath ? loadEnv(fallbackPath) : {}

  return {
    PLATFORM_DESKTOP: parseBool(
      resolveConfigValue(envFromConfigDir, envFromFallback, 'PLATFORM_DESKTOP', 'true')
    ),
    PLATFORM_NTFY: parseBool(
      resolveConfigValue(envFromConfigDir, envFromFallback, 'PLATFORM_NTFY', 'false')
    ),
    NTFY_URL: resolveConfigValue(envFromConfigDir, envFromFallback, 'NTFY_URL', 'http://localhost:10081'),
    NTFY_TOPIC: resolveConfigValue(envFromConfigDir, envFromFallback, 'NTFY_TOPIC', 'agent-alerts'),
    NTFY_API_KEY: resolveConfigValue(envFromConfigDir, envFromFallback, 'NTFY_API_KEY', ''),
  }
}
