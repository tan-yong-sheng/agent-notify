// ─── .env file parser ────────────────────────────────────────────────────────

import fs from 'node:fs'

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
