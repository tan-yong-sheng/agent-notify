// ─── Notification dispatcher ────────────────────────────────────────────────
// Decides whether to send to ntfy, desktop, or both based on AGENT_NOTIFY_MODE.

import { publishToNtfy, isEnabled } from './publish.mjs'
import { isNtfyMode, isDesktopMode } from './desktop.mjs'

async function sendToNtfy(notification, config) {
  if (isNtfyMode(config)) {
    await publishToNtfy({ ...notification, config })
  }
}

async function sendToDesktop(notification, config, showDesktop) {
  if (isDesktopMode(config) && showDesktop) {
    await showDesktop(notification.title, notification.body)
  }
}

// Dispatch a notification to configured backends.
// `showDesktop` is an optional callback: (title, body) => Promise<void> | void.
// For Orca it should call orca.host.call('notifications.show', ...).
// For Herdr it should call showDesktopNotification from ./desktop.mjs.
export async function dispatchNotification(notification, config, showDesktop) {
  if (!isEnabled(config)) return
  await sendToNtfy(notification, config)
  await sendToDesktop(notification, config, showDesktop)
}
