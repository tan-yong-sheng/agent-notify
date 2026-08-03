// ─── Small node:http(s) client used by ntfy publish ──────────────────────────
// Avoid global fetch. Orca plugin workers run under ELECTRON_RUN_AS_NODE, where
// Electron's bundled undici fetch is crash-prone.

import http from 'node:http'
import https from 'node:https'

const DEFAULT_TIMEOUT_MS = 10_000
const CLIENTS = { 'http:': http, 'https:': https }

function collectBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('error', reject)
    res.on('end', () => {
      resolve({
        statusCode: res.statusCode || 0,
        body: Buffer.concat(chunks).toString('utf8'),
      })
    })
  })
}

function asBody(value) {
  if (value == null) return null
  return String(value)
}

function openRequest(parsed, method, headers) {
  const client = CLIENTS[parsed.protocol] || http
  return client.request({
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || undefined,
    path: `${parsed.pathname}${parsed.search}`,
    method,
    headers,
  })
}

function sendBody(req, body) {
  if (body != null) req.write(body)
  req.end()
}

function runRequest(parsed, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = openRequest(parsed, method, headers)
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`))
    })
    req.on('response', (res) => {
      collectBody(res).then(resolve, reject)
    })
    sendBody(req, body)
  })
}

// One-shot HTTP(S) request. Returns { statusCode, body }.
export function requestOnce(targetUrl, options = {}) {
  const method = options.method || 'GET'
  const headers = options.headers || {}
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS
  return runRequest(new URL(targetUrl), method, headers, asBody(options.body), timeoutMs)
}
