export function okResult(transport, status) {
  return { ok: true, transport, status }
}

export function failResult(transport, error, status) {
  if (status == null) return { ok: false, transport, error }
  return { ok: false, transport, error, status }
}

export function isSuccessStatus(statusCode) {
  return statusCode >= 200 && statusCode < 300
}

export function logTransportFailure(result) {
  const status = result.status ? ` status=${result.status}` : ''
  console.error(`[ntfy] ${result.transport} failed:${status} ${result.error || 'unknown error'}`)
}
