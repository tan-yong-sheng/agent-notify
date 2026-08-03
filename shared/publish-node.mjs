import { requestOnce } from './http.mjs'
import { failResult, okResult, isSuccessStatus } from './publish-result.mjs'

const PUBLISH_TIMEOUT_MS = 10_000

function nodeHttpFailure(statusCode, body) {
  const snippet = body.slice(0, 200)
  const detail = snippet ? `HTTP ${statusCode} ${snippet}` : `HTTP ${statusCode}`
  return failResult('node-http', detail, statusCode)
}

export async function publishWithNodeHttp(url, headers, body) {
  try {
    const res = await requestOnce(url, {
      method: 'POST',
      headers,
      body,
      timeoutMs: PUBLISH_TIMEOUT_MS,
    })
    if (isSuccessStatus(res.statusCode)) return okResult('node-http', res.statusCode)
    return nodeHttpFailure(res.statusCode, res.body)
  } catch (err) {
    return failResult('node-http', err.message || String(err))
  }
}
