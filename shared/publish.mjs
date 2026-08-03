// ─── ntfy publisher: URL resolution, curl/fetch fallback ────────────────────

import { execSync } from 'node:child_process'
import { buildAuthHeaders } from './auth.mjs'

const NTFY_LOCAL_URL = 'http://127.0.0.1:10081'

function isHealthyProbe(res) {
  return res.ok || res.status === 404 || res.status === 405
}

// Probe the local ntfy server. If it responds, use local URL; else default to
// the configured public URL. This keeps notifications fast on local networks.
async function resolveNtfyUrl(config) {
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 800) // 800ms quick probe
    const res = await fetch(`${NTFY_LOCAL_URL}/`, { signal: controller.signal })
    return isHealthyProbe(res) ? NTFY_LOCAL_URL : config.NTFY_URL
  } catch {
    // Local server unreachable — fallback to configured URL
  }
  return config.NTFY_URL
}

// Publish via curl subprocess. Used when native fetch is unavailable or
// when the user prefers curl (e.g. for local SSL cert handling).
function publishWithCurl(url, headers, body) {
  try {
    const args = ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST']
    for (const [key, value] of Object.entries(headers)) {
      args.push('-H', `${key}: ${value}`)
    }
    args.push('-d', body)
    args.push(url)
    const cmd = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
    const stdout = execSync(cmd, { stdio: 'pipe' }).toString().trim()
    const code = parseInt(stdout, 10)
    return code >= 200 && code < 300
  } catch {
    return false
  }
}

async function publishWithFetch(url, headers, body) {
  try {
    const res = await fetch(url, { method: 'POST', headers, body })
    if (!res.ok) {
      const text = await res.text()
      console.error(`[ntfy] publish failed: ${res.status} ${text}`)
    }
  } catch (err) {
    console.error('[ntfy] network error:', err.message)
  }
}

// Main publish function.
export async function publishToNtfy(notification) {
  const config = notification.config
  if (!config || !config.NTFY_URL) {
    console.error('[ntfy] missing NTFY_URL')
    return
  }
  const baseUrl = await resolveNtfyUrl(config)
  const topic = encodeURIComponent(config.NTFY_TOPIC)
  const url = `${baseUrl}/${topic}`

  const headers = {
    'Title': notification.title,
    'Priority': notification.priority,
    'Tags': notification.tags,
    'Content-Type': 'text/plain; charset=utf-8',
    ...buildAuthHeaders(config.NTFY_API_KEY),
  }

  // 1. Try curl first (faster, handles local SSL)
  if (publishWithCurl(url, headers, notification.body)) return

  // 2. Fallback to native fetch
  await publishWithFetch(url, headers, notification.body)
}

export function isEnabled() {
  return true
}
