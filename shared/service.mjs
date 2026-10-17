// ─── Cross-Platform Service & Update Manager ────────────────────────────────
// Manages OS user-space background daemons:
// - Linux: systemd --user (~/.config/systemd/user/agent-monitor.service)
// - macOS: launchd agent (~/Library/LaunchAgents/dev.agent-notify.dashboard.plist)
// - Windows: Startup folder launcher
//
// Also provides git-based update checks and one-command upgrades.

import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getExtendedPathEnv } from './env.mjs'

const SERVICE_NAME = 'agent-monitor'
const MACOS_LABEL = 'dev.agent-notify.dashboard'

export function getServicePlatform() {
  return process.platform
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
WorkingDirectory=${repoDir}
ExecStart=${nodeBin} ${scriptPath}
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
  try {
    execSync(`systemctl --user stop ${SERVICE_NAME}.service`, { stdio: 'ignore' })
  } catch {}
  try {
    execSync(`systemctl --user disable ${SERVICE_NAME}.service`, { stdio: 'ignore' })
  } catch {}

  const serviceFile = getSystemdServicePath()
  if (fs.existsSync(serviceFile)) {
    fs.unlinkSync(serviceFile)
  }
  execSync('systemctl --user daemon-reload', { stdio: 'ignore' })
  console.log(`\n🛑 Successfully stopped and uninstalled ${SERVICE_NAME} systemd service.\n`)
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
        <string>${nodeBin}</string>
        <string>${scriptPath}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${repoDir}</string>
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

  execSync(`launchctl load -w "${plistPath}"`, { stdio: 'inherit' })
  console.log(`\n✅ Successfully installed and started ${MACOS_LABEL} via launchd!`)
  console.log(`   Status: http://localhost:3333`)
  console.log(`   Logs: /tmp/${SERVICE_NAME}.stdout.log\n`)
}

function statusDarwinService() {
  execSync(`launchctl list | grep ${SERVICE_NAME} || echo "Service not running"`, { stdio: 'inherit' })
}

function restartDarwinService(context) {
  uninstallDarwinService()
  installDarwinService(context)
}

function logsDarwinService() {
  const logFile = `/tmp/${SERVICE_NAME}.stdout.log`
  console.log(`Tailing ${logFile}:`)
  spawn('tail', ['-f', logFile], { stdio: 'inherit' })
}

function uninstallDarwinService() {
  const plistPath = getLaunchdPlistPath()
  if (fs.existsSync(plistPath)) {
    try {
      execSync(`launchctl unload -w "${plistPath}"`, { stdio: 'ignore' })
    } catch {}
    fs.unlinkSync(plistPath)
  }
  console.log(`\n🛑 Successfully stopped and uninstalled ${MACOS_LABEL} launchd service.\n`)
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
  const nodeBin = process.execPath
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

  handler({ nodeBin, scriptPath, repoDir })
  return true
}

// ─── Update Check & Perform ──────────────────────────────────────────────────

let cachedUpdateCheck = null
let lastUpdateCheckTime = 0
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

function queryRemoteMainSha(repoDir, env) {
  try {
    const remoteRef = execSync('git -c credential.helper= ls-remote origin -h refs/heads/main', {
      cwd: repoDir,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim()
    return remoteRef ? remoteRef.split(/\s+/)[0].slice(0, 7) : null
  } catch {
    return null
  }
}

function fetchGitUpdateStatus(repoDir, now) {
  const env = getExtendedPathEnv()
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: repoDir, env, stdio: 'ignore' })
    const localSha = execSync('git rev-parse --short HEAD', { cwd: repoDir, env, encoding: 'utf8' }).trim()
    const remoteSha = queryRemoteMainSha(repoDir, env)
    return {
      isGit: true,
      hasUpdate: Boolean(remoteSha && remoteSha !== localSha),
      localSha,
      remoteSha,
      checkedAt: now,
    }
  } catch {
    return { isGit: false, hasUpdate: false, checkedAt: now }
  }
}

export function checkUpdateStatus(repoDir) {
  const now = Date.now()
  if (cachedUpdateCheck && now - lastUpdateCheckTime < UPDATE_CHECK_INTERVAL_MS) {
    return cachedUpdateCheck
  }
  cachedUpdateCheck = fetchGitUpdateStatus(repoDir, now)
  lastUpdateCheckTime = now
  return cachedUpdateCheck
}

function printCheckUpdateResult(status) {
  if (status.hasUpdate) {
    console.log(`\n📦 Update available! Local: ${status.localSha} -> Remote: ${status.remoteSha}`)
    console.log(`   Run: node dashboard.mjs --update\n`)
  } else if (status.isGit) {
    console.log(`\n✨ Already up to date (commit: ${status.localSha}).\n`)
  } else {
    console.log(`Not running inside a git repository.`)
  }
}

function restartLinuxIfActive() {
  if (process.platform !== 'linux') return
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
}

function executeGitUpdate(repoDir, env) {
  console.log(`\n🔄 Pulling latest changes from origin main...`)
  try {
    execSync('git pull --ff-only origin main', { cwd: repoDir, env, stdio: 'inherit' })
    console.log(`✅ Code updated successfully!`)
    restartLinuxIfActive()
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
