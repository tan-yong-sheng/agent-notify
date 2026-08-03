// ─── Notification dispatcher ────────────────────────────────────────────────
// Sends to ntfy and/or desktop independently so one backend cannot block the other.

import { publishToNtfy, isEnabled } from './publish.mjs'
import { isNtfyMode, isDesktopMode } from './desktop.mjs'

function skipped(reason) {
  return { ok: true, skipped: true, reason }
}

function failed(error) {
  return { ok: false, error: error?.message || String(error) }
}

function settledValue(settled) {
  if (settled.status === 'fulfilled') return settled.value
  return failed(settled.reason)
}

async function sendToNtfy(notification, config) {
  if (!isNtfyMode(config)) return skipped('ntfy-disabled')
  return publishToNtfy({ ...notification, config }).catch(failed)
}

async function sendToDesktop(notification, config, showDesktop) {
  if (!isDesktopMode(config) || !showDesktop) return skipped('desktop-disabled')
  return Promise.resolve(showDesktop(notification.title, notification.body))
    .then(() => ({ ok: true }))
    .catch(failed)
}

// Dispatch a notification to configured backends in parallel.
// `showDesktop` is an optional callback: (title, body) => Promise<void> | void.
// For Orca it should call orca.host.call('notifications.show', ...).
// For Herdr it should call showDesktopNotification from ./desktop.mjs.
// Returns { ntfy, desktop } result objects for optional logging.
export async function dispatchNotification(notification, config, showDesktop) {
  if (!isEnabled(config)) {
    return { ntfy: skipped('disabled'), desktop: skipped('disabled') }
  }

  const [ntfySettled, desktopSettled] = await Promise.allSettled([
    sendToNtfy(notification, config),
    sendToDesktop(notification, config, showDesktop),
  ])

  return {
    ntfy: settledValue(ntfySettled),
    desktop: settledValue(desktopSettled),
  }
}
