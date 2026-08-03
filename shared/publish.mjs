// ─── ntfy publisher ──────────────────────────────────────────────────────────
// Prefer curl (system TLS), then node:http(s). Never use global fetch.

import { requestOnce } from './http.mjs'
import { publishWithCurl } from './publish-curl.mjs'
import { publishWithNodeHttp } from './publish-node.mjs'
import { failResult, logTransportFailure } from './publish-result.mjs'
import { buildPublishHeaders, buildPublishUrl } from './url.mjs'

const NTFY_LOCAL_URL = 'http://127.0.0.1:10081'
const PROBE_TIMEOUT_MS = 800
const HEALTHY_LOCAL_STATUSES = new Set([200, 404, 405])

async function resolveNtfyUrl(config) {
  try {
    const res = await requestOnce(`${NTFY_LOCAL_URL}/`, {
      method: 'GET',
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    if (HEALTHY_LOCAL_STATUSES.has(res.statusCode)) return NTFY_LOCAL_URL
  } catch {
    // Local server unreachable - fall back to configured URL.
  }
  return config.NTFY_URL
}

async function buildRequest(notification, config) {
  const baseUrl = await resolveNtfyUrl(config)
  return {
    url: buildPublishUrl(baseUrl, config.NTFY_TOPIC),
    headers: buildPublishHeaders(notification, config),
    body: notification.body || '',
  }
}

async function deliver(url, headers, body) {
  const curlResult = await publishWithCurl(url, headers, body)
  if (curlResult.ok) return curlResult
  logTransportFailure(curlResult)

  const nodeResult = await publishWithNodeHttp(url, headers, body)
  if (!nodeResult.ok) logTransportFailure(nodeResult)
  return nodeResult
}

export async function publishToNtfy(notification) {
  const config = notification.config
  if (!config?.NTFY_URL) {
    console.error('[ntfy] missing NTFY_URL')
    return failResult('none', 'missing NTFY_URL')
  }

  const { url, headers, body } = await buildRequest(notification, config)
  return deliver(url, headers, body)
}

export function isEnabled() {
  return true
}
