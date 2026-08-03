// ─── ntfy auth header construction ───────────────────────────────────────────

export function buildAuthHeaders(token) {
  if (!token) return {}
  if (token.includes(':')) {
    const encoded = Buffer.from(token).toString('base64')
    return { 'Authorization': `Basic ${encoded}` }
  }
  return { 'Authorization': `Bearer ${token}` }
}
