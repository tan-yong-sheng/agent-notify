// ─── Desktop / terminal popout notifications for Herdr ───────────────────────
// Inspired by pi-notify's terminal backend:
// https://github.com/tan-yong-sheng/pi-notify
//
// Tries terminal escape sequences first (OSC 99 for Kitty, OSC 777 for
// iTerm2/WezTerm/Ghostty), then falls back to OS-native notifications.

import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'

function sanitizeTerminalText(s) {
  return String(s).replace(/[\x00-\x1f\x7f]/g, '')
}

function escapeXml(unsafe) {
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function notifyOSC99(title, body) {
  process.stdout.write(`\x1b]99;i=1:d=0;${sanitizeTerminalText(title)}\x1b\\`)
  process.stdout.write(`\x1b]99;i=1:p=body;${sanitizeTerminalText(body)}\x1b\\`)
}

function notifyOSC777(title, body) {
  process.stdout.write(`\x1b]777;notify;${sanitizeTerminalText(title)};${sanitizeTerminalText(body)}\x07`)
}

function windowsToastScript(title, body) {
  const safeTitle = escapeXml(title)
  const safeBody = escapeXml(body)
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
    '',
    '$template = @"',
    '<toast activationType="foreground">',
    '  <visual>',
    '    <binding template="ToastText02">',
    `      <text id="1">${safeTitle}</text>`,
    `      <text id="2">${safeBody}</text>`,
    '    </binding>',
    '  </visual>',
    '</toast>',
    '"@',
    '',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$xml.LoadXml($template)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Agent Notify").Show($toast)',
  ].join('\r\n')
}

function notifyWindows(title, body) {
  const scriptPath = path.join(tmpdir(), `agent-notify-${Date.now()}.ps1`)
  try {
    writeFileSync(scriptPath, windowsToastScript(title, body), { encoding: 'utf8' })
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true },
      (error) => {
        try {
          unlinkSync(scriptPath)
        } catch {}
        if (error) {
          console.error('Windows toast failed:', error.message)
        }
      }
    )
  } catch (err) {
    console.error('Windows toast setup failed:', err.message)
  }
}

function notifyMacOS(title, body) {
  execFile(
    'osascript',
    ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`],
    (error) => {
      if (error) {
        console.error('macOS notification failed:', error.message)
      }
    }
  )
}

function notifyLinux(title, body) {
  execFile('notify-send', [title, body], (error) => {
    if (error) {
      console.error('Linux notification failed:', error.message)
    }
  })
}

function notifyOSNative(title, body) {
  switch (process.platform) {
    case 'win32':
      notifyWindows(title, body)
      break
    case 'darwin':
      notifyMacOS(title, body)
      break
    default:
      notifyLinux(title, body)
  }
}

// Show a desktop / terminal popout notification.
// Tries terminal sequences first, then OS-native fallback.
export function showDesktopNotification(title, body) {
  const safeTitle = sanitizeTerminalText(title)
  const safeBody = sanitizeTerminalText(body)

  try {
    notifyOSC99(safeTitle, safeBody)
  } catch {
    // Terminal may not support OSC 99.
  }

  try {
    notifyOSC777(safeTitle, safeBody)
  } catch {
    // Terminal may not support OSC 777.
  }

  // Always try OS-native as well; if the terminal captured the OSC sequence
  // the user gets one notification, otherwise they still get something.
  notifyOSNative(safeTitle, safeBody)
}

// Check whether desktop notifications are enabled for the given config.
export function isDesktopMode(config) {
  return config.PLATFORM_DESKTOP === true
}

// Check whether ntfy notifications are enabled for the given config.
export function isNtfyMode(config) {
  return config.PLATFORM_NTFY === true
}
