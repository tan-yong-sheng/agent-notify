import { buildAuthHeaders } from './auth.mjs'

export function buildPublishUrl(baseUrl, topic) {
  const root = String(baseUrl).replace(/\/+$/, '')
  return `${root}/${encodeURIComponent(topic || 'agent-alerts')}`
}

export function buildPublishHeaders(notification, config) {
  return {
    Title: notification.title,
    Priority: String(notification.priority ?? ''),
    Tags: notification.tags || '',
    'Content-Type': 'text/plain; charset=utf-8',
    ...buildAuthHeaders(config.NTFY_API_KEY),
  }
}
