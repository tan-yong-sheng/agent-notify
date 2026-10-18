// ─── Cross-Platform Service & Update Manager ────────────────────────────────
// Manages OS user-space background daemons:
// - Linux: systemd --user (~/.config/systemd/user/agent-monitor.service)
// - macOS: launchd agent (~/Library/LaunchAgents/dev.agent-notify.dashboard.plist)
// - Windows: Startup folder launcher
//
// Also provides git-based update checks and one-command upgrades.

import { execSync, execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getExtendedPathEnv } from './env.mjs'

const SERVICE_NAME = 'agent-monitor'
const MACOS_LABEL = 'dev.agent-notify.dashboard'

function runQuiet(command, args) {
  try {
    if (Array.isArray(args)) {
      execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } else {
      execSync(command, { stdio: ['ignore', 'pipe', 'pipe'] })
    }
    return { ok: true, detail: '' }
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr) : ''
    return { ok: false, detail: (stderr || err.message || '').trim().split('\n')[0] }
  }
}

// Stopping an already-removed service is expected; any other failure is worth
// reporting, because the unit file is deleted either way.
function isUnitMissingError(result) {
  return /not loaded|could not be found|could not find|no such file|not found|not running/i.test(result.detail || '')
}

function reportUninstallResult({ label, removed, failures }) {
  if (failures.length) {
    console.log(`\n⚠️  Uninstalled ${label} with ${failures.length} problem(s):`)
    for (const failure of failures) console.log(`   - ${failure}`)
    console.log(`   ${removed ? 'The unit file was removed' : 'No unit file was present'}; re-run --service install to restore it.\n`)
    return
  }
  console.log(`\n🛑 Successfully stopped and uninstalled ${label}.\n`)
}

function rejectUnrepresentable(value) {
  const raw = String(value)
  if (/[\n\r\u0000]/.test(raw)) {
    throw new Error('Refusing to write a systemd unit: a path contains a newline or NUL character')
  }
  return raw
}

// `WorkingDirectory=` is not a command line: it keeps internal spaces, and it
// supports neither quoting nor C-style escapes (checked against the real parser:
// a quoted path is rejected as "not absolute" and `\"`/`\\` arrive verbatim).
// `%` is still a specifier, and a trailing `\` still continues the line.
function systemdPathValue(value) {
  const raw = rejectUnrepresentable(value)
  if (raw.endsWith('\\')) {
    throw new Error('Refusing to write a systemd unit: a path ends with a backslash, which would continue the line')
  }
  return raw.replace(/%/g, '%%')
}

// `ExecStart=` is a command line: it splits on unquoted whitespace, so an argument
// containing a space is quoted, and `%` (specifier) and `$` (variable expansion)
// are doubled. Escapes are processed here, unlike in `WorkingDirectory=`.
function systemdExecValue(value) {
  const escaped = rejectUnrepresentable(value).replace(/%/g, '%%').replace(/\$/g, () => '$$')
  return /^[A-Za-z0-9_@./:+-]+$/.test(escaped) ? escaped : `"${escaped.replace(/(["\\])/g, '\\$1')}"`
}

// Plist values are XML text, so `&` or `<` in a path would corrupt the document.
function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
}

export function getServicePlatform() {
  return process.platform
}

export function resolveServiceRuntime(customExecPath) {
  const currentExec = customExecPath || process.execPath
  if (currentExec.includes('bun')) {
    return currentExec
  }

  // Check if bun is installed and available in extended PATH
  const env = getExtendedPathEnv()
  try {
    const bunPath = execSync('which bun', { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
    if (bunPath && fs.existsSync(bunPath)) {
      return bunPath
    }
  } catch {}

  return currentExec
}

// ─── Systemd (Linux) ─────────────────────────────────────────────────────────

function getSystemdDir() {
  return path.join(os.homedir(), '.config', 'systemd', 'user')
}

function getSystemdServicePath() {
  return path.join(getSystemdDir(), `${SERVICE_NAME}.service`)
}

export function buildSystemdUnit(nodeBin, scriptPath, repoDir) {
  return `[Unit]
Description=Agent Monitor Dashboard (Orca & Herdr)
After=network.target

[Service]
Type=simple
WorkingDirectory=${systemdPathValue(repoDir)}
ExecStart=${systemdExecValue(nodeBin)} ${systemdExecValue(scriptPath)}
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`
}

function installLinuxService({ nodeBin, scriptPath, repoDir }) {
  const dir = getSystemdDir()
  fs.mkdirSync(dir, { recursive: true })
  const serviceFile = getSystemdServicePath()
  fs.writeFileSync(serviceFile, buildSystemdUnit(nodeBin, scriptPath, repoDir), 'utf8')

  execSync('systemctl --user daemon-reload', { stdio: 'inherit' })
  execSync(`systemctl --user enable --now ${SERVICE_NAME}.service`, { stdio: 'inherit' })
  console.log(`\n✅ Successfully installed and started ${SERVICE_NAME} via systemd --user!`)
  console.log(`   Status: http://localhost:3333`)
  console.log(`   Manage with: node dashboard.mjs --service [status|restart|uninstall|logs]\n`)
}

function uninstallLinuxService() {
  const failures = []
  for (const [action, command] of [
    ['stop', `systemctl --user stop ${SERVICE_NAME}.service`],
    ['disable', `systemctl --user disable ${SERVICE_NAME}.service`],
  ]) {
    const result = runQuiet(command)
    if (!result.ok && !isUnitMissingError(result)) failures.push(`${action}: ${result.detail}`)
  }

  const serviceFile = getSystemdServicePath()
  let removed = false
  if (fs.existsSync(serviceFile)) {
    fs.unlinkSync(serviceFile)
    removed = true
  }

  const reload = runQuiet('systemctl --user daemon-reload')
  if (!reload.ok) failures.push(`daemon-reload: ${reload.detail}`)

  reportUninstallResult({ label: `${SERVICE_NAME}.service`, removed, failures })
}

function statusLinuxService() {
  try {
    execSync(`systemctl --user status ${SERVICE_NAME}.service`, { stdio: 'inherit' })
  } catch (err) {
    if (err.status !== 0) {
      console.log(`Service ${SERVICE_NAME} is stopped or not installed.`)
    }
  }
}

function restartLinuxService() {
  execSync(`systemctl --user restart ${SERVICE_NAME}.service`, { stdio: 'inherit' })
  console.log(`\n🔄 Restarted ${SERVICE_NAME} systemd service.\n`)
}

function logsLinuxService() {
  const child = spawn('journalctl', ['--user', '-u', `${SERVICE_NAME}.service`, '-n', '50', '-f'], {
    stdio: 'inherit',
  })
  child.on('close', (code) => process.exit(code || 0))
}

// ─── Launchd (macOS) ─────────────────────────────────────────────────────────

function getLaunchdDir() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents')
}

function getLaunchdPlistPath() {
  return path.join(getLaunchdDir(), `${MACOS_LABEL}.plist`)
}

export function buildLaunchdPlist(nodeBin, scriptPath, repoDir) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${MACOS_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xmlEscape(nodeBin)}</string>
        <string>${xmlEscape(scriptPath)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(repoDir)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/${SERVICE_NAME}.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/${SERVICE_NAME}.stderr.log</string>
</dict>
</plist>
`
}

function installDarwinService({ nodeBin, scriptPath, repoDir }) {
  const dir = getLaunchdDir()
  fs.mkdirSync(dir, { recursive: true })
  const plistPath = getLaunchdPlistPath()
  fs.writeFileSync(plistPath, buildLaunchdPlist(nodeBin, scriptPath, repoDir), 'utf8')

  execFileSync('launchctl', ['load', '-w', plistPath], { stdio: 'inherit' })
  console.log(`\n✅ Successfully installed and started ${MACOS_LABEL} via launchd!`)
  console.log(`   Status: http://localhost:3333`)
  console.log(`   Logs: /tmp/${SERVICE_NAME}.stdout.log\n`)
}

function statusDarwinService() {
  execSync(`launchctl list | grep -F "${MACOS_LABEL}" || echo "${MACOS_LABEL} is not loaded."`, { stdio: 'inherit' })
}

function stopDarwinService() {
  const plistPath = getLaunchdPlistPath()
  const failures = []
  let removed = false

  if (runQuiet(`launchctl list | grep -F "${MACOS_LABEL}"`).ok || fs.existsSync(plistPath)) {
    const unload = runQuiet('launchctl', ['unload', '-w', plistPath])
    if (!unload.ok && !isUnitMissingError(unload)) failures.push(`unload: ${unload.detail}`)
    if (fs.existsSync(plistPath)) {
      fs.unlinkSync(plistPath)
      removed = true
    }
  }

  return { failures, removed }
}

function restartDarwinService(context) {
  stopDarwinService()
  installDarwinService(context)
}

function logsDarwinService() {
  const logFile = `/tmp/${SERVICE_NAME}.stdout.log`
  console.log(`Tailing ${logFile}:`)
  spawn('tail', ['-f', logFile], { stdio: 'inherit' })
}

function uninstallDarwinService() {
  const { failures, removed } = stopDarwinService()
  reportUninstallResult({ label: MACOS_LABEL, removed, failures })
}

// ─── Windows (win32) ────────────────────────────────────────────────────────

function getWindowsStartupDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

export function buildWindowsVbs(nodeBin, scriptPath) {
  return `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run """${nodeBin}"" ""${scriptPath}""", 0, False\n`
}

function installWindowsService({ nodeBin, scriptPath }) {
  const startupDir = getWindowsStartupDir()
  const vbsPath = path.join(startupDir, `${SERVICE_NAME}.vbs`)
  fs.writeFileSync(vbsPath, buildWindowsVbs(nodeBin, scriptPath), 'utf8')
  console.log(`\n✅ Installed Windows Startup shortcut at: ${vbsPath}\n`)
}

function uninstallWindowsService() {
  const startupDir = getWindowsStartupDir()
  const vbsPath = path.join(startupDir, `${SERVICE_NAME}.vbs`)
  if (fs.existsSync(vbsPath)) {
    fs.unlinkSync(vbsPath)
  }
  console.log(`\n🛑 Removed Windows Startup shortcut.\n`)
}

// ─── Platform Strategy Map ──────────────────────────────────────────────────

const PLATFORM_SERVICES = {
  linux: {
    install: installLinuxService,
    uninstall: uninstallLinuxService,
    status: statusLinuxService,
    restart: restartLinuxService,
    logs: logsLinuxService,
  },
  darwin: {
    install: installDarwinService,
    uninstall: uninstallDarwinService,
    status: statusDarwinService,
    restart: restartDarwinService,
    logs: logsDarwinService,
  },
  win32: {
    install: installWindowsService,
    uninstall: uninstallWindowsService,
    status: () => console.log('Service status check is only supported on Linux/macOS.'),
    restart: () => console.log('Restart is only supported on Linux/macOS.'),
    logs: () => console.log('Logs viewing is only supported on Linux/macOS.'),
  },
}

export function handleServiceCommand(argv) {
  const serviceIndex = argv.indexOf('--service')
  if (serviceIndex === -1) return false

  const action = argv[serviceIndex + 1] || 'status'
  const scriptPath = path.resolve(argv[1])
  const repoDir = path.dirname(scriptPath)
  const nodeBin = resolveServiceRuntime()
  const platform = getServicePlatform()

  const platformOps = PLATFORM_SERVICES[platform]
  if (!platformOps) {
    console.error(`Unsupported platform for service command: ${platform}`)
    return true
  }

  const handler = platformOps[action]
  if (!handler) {
    console.log(`Unknown service action: ${action}`)
    console.log('Available actions: install, status, restart, logs, uninstall')
    return true
  }

  try {
    handler({ nodeBin, scriptPath, repoDir })
  } catch (err) {
    // A path that cannot be represented in a unit file is refused rather than
    // written, and supervisor failures (no systemd --user, unwritable directory)
    // should read as an error rather than a stack trace.
    console.error(`\n❌ Service ${action} failed: ${err.message}\n`)
    process.exitCode = 1
  }
  return true
}

// ─── Update Check & Perform ──────────────────────────────────────────────────

let cachedUpdateCheck = null
let lastUpdateCheckTime = 0
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
const GIT_TIMEOUT_MS = 10000
// The interactive `git pull` is not a local query: it may wait on a credential
// prompt and on the network. A short limit would SIGTERM a pull that is still
// making progress, so give it its own ceiling.
const GIT_PULL_TIMEOUT_MS = 5 * 60 * 1000

function git(args, repoDir, env) {
  return execFileSync('git', args, {
    cwd: repoDir,
    env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: GIT_TIMEOUT_MS,
  }).trim()
}

function tryGit(args, repoDir, env) {
  try {
    return git(args, repoDir, env)
  } catch {
    return null
  }
}

// The ref the update commands act on: the current branch's configured upstream,
// or the documented install channel (origin/main) when no upstream is set.
function resolveUpdateTarget(repoDir, env) {
  const upstream = tryGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoDir, env)
  const slash = upstream ? upstream.indexOf('/') : -1
  if (slash > 0) {
    return {
      remote: upstream.slice(0, slash),
      branch: upstream.slice(slash + 1),
      upstream,
      tracks: true,
    }
  }
  if (tryGit(['rev-parse', '--verify', '--quiet', 'origin/main'], repoDir, env)) {
    return { remote: 'origin', branch: 'main', upstream: 'origin/main', tracks: false }
  }
  return null
}

function readManifestVersions(ref, repoDir, env) {
  const read = (file, parse) => {
    const raw = tryGit(['show', `${ref}:${file}`], repoDir, env)
    if (raw === null) return null
    try {
      return parse(raw)
    } catch {
      return null
    }
  }
  return {
    orca: read('orca-plugin.json', (raw) => JSON.parse(raw).version ?? null),
    herdr: read('herdr-plugin.toml', (raw) => raw.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null),
  }
}

// Human-readable release label for the banner, from the same ref the pull uses.
// Returns null when no manifest version actually changed, so callers fall back to SHAs.
export function buildVersionLabel(localVersions, remoteVersions) {
  const parts = []
  for (const key of ['orca', 'herdr']) {
    const before = localVersions?.[key]
    const after = remoteVersions?.[key]
    if (after && before !== after) {
      parts.push(before ? `${key} ${before} → ${after}` : `${key} ${after}`)
    }
  }
  return parts.length ? parts.join(' · ') : null
}

// Uncached probe. Does a `git fetch` of the update target, so it mutates the
// repo's remote-tracking refs and needs network access; callers that render the
// UI should go through checkUpdateStatus instead.
// The update check runs inside the dashboard's HTTP server, where a git
// credential prompt would block the event loop until the timeout expires and
// stall every other request. This env makes git fail fast instead of asking.
// GIT_ASKPASS is cleared too: git consults an askpass program even when
// GIT_TERMINAL_PROMPT=0, and getExtendedPathEnv() inherits it from the parent
// environment, so a configured askpass would bypass the guard above.
export function nonInteractiveGitEnv() {
  return { ...getExtendedPathEnv(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' }
}

export function fetchUpdateStatus(repoDir) {
  const now = Date.now()
  const env = nonInteractiveGitEnv()
  if (!tryGit(['rev-parse', '--is-inside-work-tree'], repoDir, env)) {
    return { isGit: false, hasUpdate: false, checkedAt: now }
  }

  const target = resolveUpdateTarget(repoDir, env)
  if (!target) {
    return { isGit: true, hasUpdate: false, unavailable: 'no upstream branch and no origin/main', checkedAt: now }
  }

  const fetchFailed = tryGit(['fetch', '--quiet', '--no-tags', target.remote, target.branch], repoDir, env) === null

  const localSha = (tryGit(['rev-parse', '--short=7', 'HEAD'], repoDir, env) || '').slice(0, 7)
  const remoteSha = (tryGit(['rev-parse', '--short=7', target.upstream], repoDir, env) || '').slice(0, 7) || null
  if (!remoteSha) {
    return { isGit: true, hasUpdate: false, localSha, unavailable: `cannot resolve ${target.upstream}`, fetchFailed, checkedAt: now }
  }

  const behind = Number(tryGit(['rev-list', '--count', `HEAD..${target.upstream}`], repoDir, env)) || 0
  const ahead = Number(tryGit(['rev-list', '--count', `${target.upstream}..HEAD`], repoDir, env)) || 0

  return {
    isGit: true,
    hasUpdate: behind > 0,
    localSha,
    remoteSha,
    behind,
    ahead,
    upstream: target.upstream,
    tracks: target.tracks,
    fetchFailed,
    versionLabel:
      behind > 0
        ? buildVersionLabel(
            readManifestVersions('HEAD', repoDir, env),
            readManifestVersions(target.upstream, repoDir, env)
          )
        : null,
    checkedAt: now,
  }
}

export function checkUpdateStatus(repoDir) {
  const now = Date.now()
  if (cachedUpdateCheck && now - lastUpdateCheckTime < UPDATE_CHECK_INTERVAL_MS) {
    return cachedUpdateCheck
  }
  cachedUpdateCheck = fetchUpdateStatus(repoDir)
  lastUpdateCheckTime = now
  return cachedUpdateCheck
}

function printCheckUpdateResult(status) {
  if (!status.isGit) {
    console.log(`Not running inside a git repository.`)
    return
  }
  if (status.unavailable) {
    console.log(`\nCannot check for updates: ${status.unavailable}.\n`)
    return
  }
  if (status.fetchFailed) {
    console.log(`Note: could not reach the remote; showing last known state.`)
  }
  if (status.hasUpdate) {
    const label = status.versionLabel ? ` (${status.versionLabel})` : ''
    const extra = status.ahead ? `, ${status.ahead} local commit(s) not on the remote` : ''
    console.log(`\n📦 Update available on ${status.upstream}${label}: ${status.localSha} → ${status.remoteSha}`)
    console.log(`   ${status.behind} commit(s) behind${extra}.`)
    console.log(`   Run: node dashboard.mjs --update\n`)
  } else if (status.ahead) {
    console.log(`\n✨ Up to date with ${status.upstream} (${status.localSha}); ${status.ahead} local commit(s) not on the remote.\n`)
  } else {
    console.log(`\n✨ Already up to date (commit: ${status.localSha}).\n`)
  }
}

function restartServiceIfActive() {
  if (process.platform === 'linux') {
    try {
      const isActive = execSync(`systemctl --user is-active ${SERVICE_NAME}.service`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim()
      if (isActive === 'active') {
        console.log(`Restarting ${SERVICE_NAME} systemd service...`)
        execSync(`systemctl --user restart ${SERVICE_NAME}.service`, { stdio: 'inherit' })
      }
    } catch {}
    return
  }

  if (process.platform === 'darwin') {
    if (!fs.existsSync(getLaunchdPlistPath())) return
    if (!runQuiet(`launchctl list | grep -F "${MACOS_LABEL}"`).ok) return
    console.log(`Restarting ${MACOS_LABEL} launchd service...`)
    execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${MACOS_LABEL}`], { stdio: 'inherit' })
  }
}

function executeGitUpdate(repoDir, env) {
  const target = resolveUpdateTarget(repoDir, env)
  if (!target) {
    console.error(`\n❌ Update failed: no upstream branch and no origin/main to update from.`)
    return
  }
  if (!target.tracks) {
    console.error(`\n❌ Update failed: the current checkout is not on a branch that tracks ${target.upstream}.`)
    console.error(`   Switch to a tracking branch (main) and re-run: node dashboard.mjs --update\n`)
    return
  }

  console.log(`\n🔄 Pulling ${target.upstream}...`)
  try {
    const before = git(['rev-parse', 'HEAD'], repoDir, env)
    const args = ['pull', '--ff-only']
    execFileSync('git', args, { cwd: repoDir, env, stdio: 'inherit', timeout: GIT_PULL_TIMEOUT_MS })
    const after = git(['rev-parse', 'HEAD'], repoDir, env)

    if (after === before) {
      console.log(`\n✨ Already up to date on ${target.upstream}; nothing changed (${before.slice(0, 7)}).\n`)
      return
    }
    console.log(`✅ Updated ${before.slice(0, 7)} → ${after.slice(0, 7)} on ${target.upstream}.`)
    restartServiceIfActive()
    console.log(`\n🚀 Update complete.\n`)
  } catch (err) {
    console.error(`❌ Update failed:`, err.message)
  }
}

export function handleUpdateCommand(argv) {
  const wantsUpdate = argv.includes('--update')
  const wantsCheck = argv.includes('--check-update')
  if (!wantsUpdate && !wantsCheck) return false

  const scriptPath = path.resolve(argv[1])
  const repoDir = path.dirname(scriptPath)

  if (wantsCheck) {
    console.log(`Checking for updates...`)
    printCheckUpdateResult(checkUpdateStatus(repoDir))
    return true
  }

  executeGitUpdate(repoDir, getExtendedPathEnv())
  return true
}
