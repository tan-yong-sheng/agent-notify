#!/usr/bin/env node

// Zero-dependency Chrome DevTools Protocol driver for the verification skill.
// One long-lived headless Chrome, driven by short-lived commands, so a run can
// keep a page alive between steps without holding a process open.
//
// Usage: node .agents/skills/verify/scripts/browser.mjs <command> [options]
//   launch [--port N] [--chrome PATH] [--url URL]
//   open <url>
//   eval <expression>            print the JSON value of the expression
//   text                         print document.body.innerText
//   aria [--path FILE]           print the accessibility tree as 'role "name"' lines
//   wait --selector CSS [--timeout MS]
//   click --selector CSS
//   type --selector CSS --value TEXT
//   screenshot --path FILE
//   close
//
// Every command accepts --state FILE (default: artifacts/browser.json).

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ARTIFACTS = path.resolve(SCRIPT_DIR, '..', 'artifacts')

const CHROME_CANDIDATES = [
  process.env.VERIFY_CHROME,
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
].filter(Boolean)

function playwrightChrome() {
  const roots = [path.join(os.homedir(), '.cache', 'ms-playwright'), '/root/.cache/ms-playwright']
  const found = []
  for (const root of roots) {
    let entries = []
    try {
      entries = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries.sort().reverse()) {
      if (!entry.startsWith('chromium')) continue
      for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const candidate = path.join(root, entry, rel)
        if (fs.existsSync(candidate)) found.push(candidate)
      }
    }
  }
  return found
}

function resolveChrome(explicit) {
  const candidates = [...(explicit ? [explicit] : []), ...CHROME_CANDIDATES, ...playwrightChrome()]
  for (const candidate of candidates) {
    if (candidate.includes('/') && fs.existsSync(candidate)) return candidate
    if (!candidate.includes('/')) {
      const hit = (process.env.PATH || '')
        .split(':')
        .map((dir) => path.join(dir, candidate))
        .find((full) => fs.existsSync(full))
      if (hit) return hit
    }
  }
  throw new Error('no Chrome/Chromium found; set VERIFY_CHROME or pass --chrome')
}

// ─── Options ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true
      } else {
        flags[key] = next
        i++
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

const { positional, flags } = parseArgs(process.argv.slice(2))
const command = positional[0]
const statePath = flags.state ? path.resolve(String(flags.state)) : path.join(ARTIFACTS, 'browser.json')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readState() {
  if (!fs.existsSync(statePath)) throw new Error(`no browser session at ${statePath}; run "browser.mjs launch" first`)
  return JSON.parse(fs.readFileSync(statePath, 'utf8'))
}

function writeState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
}

// Chrome is started with a private --user-data-dir, and that path is the only
// durable fact about the process we started. A recorded pid is not an identity:
// once Chrome exits the number can be reused by an unrelated process, and this
// driver must never signal one.
const PROC_AVAILABLE = fs.existsSync('/proc/self/cmdline')
function pidIsOurChrome(pid, userDataDir) {
  if (!PROC_AVAILABLE) return true
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(userDataDir)
  } catch {
    return false
  }
}

// A Chrome that cannot start because its own sandbox is unavailable is the one
// case worth retrying with the sandbox off. Any other startup failure is a real
// failure and must not silently produce an unsandboxed browser.
const SANDBOX_REFUSAL = /sandbox|namespace|Operation not permitted|clone\(CLONE_NEWUSER\)/i
const tailOf = (log) =>
  log
    .trim()
    .split('\n')
    .slice(-4)
    .join('\n')

async function evalOrThrow(cdp, expression, sessionId, extra = {}) {
  const res = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true, ...extra },
    sessionId
  )
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text)
  }
  return res.result.value
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

// ─── CDP plumbing ───────────────────────────────────────────────────────────

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.error) entry.reject(new Error(msg.error.message))
      else entry.resolve(msg.result)
    })
  }

  static async connect(wsUrl) {
    // Node < 22 has no global WebSocket; fail with the floor instead of "WebSocket is not defined".
    if (typeof WebSocket !== 'function') {
      throw new Error(`the CDP client needs a global WebSocket (Node >= 22); this runtime reports ${process.version}`)
    }
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true })
    })
    return new Cdp(ws)
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    this.ws.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => {
      // The timer must be cleared when the reply lands: a live timer holds the
      // event loop open, so an unanswered one would both delay the exit and
      // reject a later request that reuses nothing but the same clock.
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`))
      }, 30000)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  close() {
    this.ws.close()
  }
}

async function pageSession() {
  const state = readState()
  const cdp = await Cdp.connect(state.ws)
  const { targetInfos } = await cdp.send('Target.getTargets')
  // Only the page this session opened. Falling back to any page target would
  // silently drive Chrome's own about:blank tab and report its results as ours.
  const page = targetInfos.find((t) => t.targetId === state.targetId)
  if (!page) {
    throw new Error(
      state.targetId
        ? 'the page this session opened is gone; run "browser.mjs open <url>"'
        : 'this session has not opened a page; run "browser.mjs open <url>"'
    )
  }
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  return { cdp, sessionId, state }
}

// ─── Commands ───────────────────────────────────────────────────────────────

const BASE_ARGS = [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-dev-shm-usage',
  '--window-size=1280,900',
]

// Chrome's own sandbox cannot start under an outer OS sandbox (nono, seccomp, a
// locked-down container), where it exits before opening the debug port. Try the
// sandboxed launch first so a normal machine keeps it, and fall back only when
// the browser never comes up.
async function startChrome({ chrome, port, userDataDir, url, extraArgs }) {
  const child = spawn(chrome, [...BASE_ARGS, ...extraArgs, `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, url], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  let exited = null
  child.on('exit', (code) => (exited = code))
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (exited !== null) return { child, log, info: null, exited }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return { child, log, info: await res.json(), exited: null }
    } catch {}
    await sleep(150)
  }
  return { child, log, info: null, exited }
}

async function launch() {
  if (fs.existsSync(statePath)) {
    try {
      const existing = readState()
      process.kill(existing.pid, 0)
      console.log(`already running: pid ${existing.pid} on port ${existing.port}`)
      return
    } catch {
      fs.rmSync(statePath, { force: true })
    }
  }
  const chrome = resolveChrome(flags.chrome === true ? undefined : flags.chrome)
  const port = flags.port && flags.port !== true ? Number(flags.port) : await freePort()
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-chrome-'))
  const url = flags.url && flags.url !== true ? String(flags.url) : 'about:blank'

  let attempt = await startChrome({ chrome, port, userDataDir, url, extraArgs: [] })
  let sandbox = 'on'
  if (!attempt.info) {
    const log = attempt.log
    attempt.child.kill('SIGKILL')
    if (!SANDBOX_REFUSAL.test(log)) {
      throw new Error(
        `Chrome did not expose a debugger on port ${port}, and the failure is not a sandbox refusal, so it is not retried with the sandbox off\n${tailOf(log)}`
      )
    }
    attempt = await startChrome({ chrome, port, userDataDir, url, extraArgs: ['--no-sandbox', '--disable-setuid-sandbox'] })
    sandbox = 'off'
  }
  if (!attempt.info) {
    attempt.child.kill('SIGKILL')
    throw new Error(`Chrome did not expose a debugger on port ${port}\n${tailOf(attempt.log)}`)
  }
  writeState({ pid: attempt.child.pid, port, ws: attempt.info.webSocketDebuggerUrl, userDataDir, chrome, sandbox, targetId: null })
  // The browser outlives this command; drop the pipes and the child handle so
  // the driver process can exit instead of waiting on Chrome's stdio.
  attempt.child.stdout?.destroy()
  attempt.child.stderr?.destroy()
  attempt.child.unref()
  await open(url)
  console.log(`launched ${path.basename(chrome)} pid ${attempt.child.pid} on port ${port} (browser sandbox ${sandbox})`)
}

async function open(url) {
  const state = readState()
  const cdp = await Cdp.connect(state.ws)
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url })
    writeState({ ...state, targetId })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.enable', {}, sessionId)
    await waitFor(sessionId, 'document.readyState === "complete"', 15000, cdp).catch(() => {})
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId)
    console.log(result.value)
  } finally {
    cdp.close()
  }
}

async function waitFor(sessionId, expression, timeout, cdp) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const { result } = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
    if (result.value) return true
    await sleep(100)
  }
  throw new Error(`condition not met within ${timeout}ms: ${expression}`)
}

async function evaluate(expression) {
  const { cdp, sessionId } = await pageSession()
  try {
    console.log(JSON.stringify(await evalOrThrow(cdp, expression, sessionId)))
  } finally {
    cdp.close()
  }
}

async function aria() {
  const { cdp, sessionId } = await pageSession()
  try {
    await cdp.send('Accessibility.enable', {}, sessionId)
    const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sessionId)
    const lines = []
    for (const node of nodes) {
      if (node.ignored) continue
      const role = node.role?.value || ''
      const name = node.name?.value || ''
      if (!role || role === 'none' || role === 'generic' || role === 'InlineTextBox') continue
      lines.push(name ? `${role} "${name}"` : role)
    }
    const out = lines.join('\n') + '\n'
    if (flags.path && flags.path !== true) {
      fs.mkdirSync(path.dirname(path.resolve(String(flags.path))), { recursive: true })
      fs.writeFileSync(path.resolve(String(flags.path)), out)
      console.log(`wrote ${lines.length} nodes to ${flags.path}`)
    } else {
      process.stdout.write(out)
    }
  } finally {
    cdp.close()
  }
}

async function click() {
  const selector = String(flags.selector)
  const { cdp, sessionId } = await pageSession()
  try {
    const { result } = await cdp.send(
      'Runtime.evaluate',
      {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
          el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
        returnByValue: true,
      },
      sessionId
    )
    if (!result.value) throw new Error(`click target not found: ${selector}`)
    const { x, y } = result.value
    const base = { x, y, button: 'left', clickCount: 1 }
    await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sessionId)
    await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sessionId)
    await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sessionId)
    console.log(`clicked ${selector} at ${Math.round(x)},${Math.round(y)}`)
  } finally {
    cdp.close()
  }
}

async function type() {
  const selector = String(flags.selector)
  const value = String(flags.value ?? '')
  const { cdp, sessionId } = await pageSession()
  try {
    await evalOrThrow(
      cdp,
      // The selector reaches the page as data in both places; interpolating it
      // into the throw message would let a quote in a selector run code.
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error(${JSON.stringify(`no element matches ${selector}`)});
        el.focus(); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
      sessionId
    )
    await cdp.send('Input.insertText', { text: value }, sessionId)
    const typed = await evalOrThrow(cdp, `document.querySelector(${JSON.stringify(selector)}).value`, sessionId)
    if (typed !== value) throw new Error(`the field holds ${JSON.stringify(typed)} after typing ${JSON.stringify(value)}`)
    console.log(JSON.stringify(typed))
  } finally {
    cdp.close()
  }
}

async function screenshot() {
  const { cdp, sessionId } = await pageSession()
  try {
    await cdp.send('Page.enable', {}, sessionId)
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
    const target = path.resolve(String(flags.path))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, Buffer.from(data, 'base64'))
    console.log(`wrote ${target}`)
  } finally {
    cdp.close()
  }
}

async function close() {
  const state = readState()
  const cdp = await Cdp.connect(state.ws).catch(() => null)
  if (cdp) {
    if (state.targetId) await cdp.send('Target.closeTarget', { targetId: state.targetId }).catch(() => {})
    cdp.close()
  }
  const ours = pidIsOurChrome(state.pid, state.userDataDir)
  if (!ours) console.log(`pid ${state.pid} is no longer this session's Chrome (it exited and the pid was reused); not signalling it`)
  if (ours) {
    try {
      process.kill(state.pid, 'SIGTERM')
    } catch {}
    // Wait for the process to go before touching its profile: Chrome keeps writing
    // into the user-data dir while it shuts down.
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      try {
        process.kill(state.pid, 0)
        await sleep(100)
      } catch {
        break
      }
    }
    try {
      process.kill(state.pid, 'SIGKILL')
    } catch {}
  }
  fs.rmSync(statePath, { force: true })
  try {
    fs.rmSync(state.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    console.log(`closed pid ${state.pid}`)
  } catch (err) {
    console.log(`closed pid ${state.pid}; profile dir left at ${state.userDataDir} (${err.code})`)
  }
}

const COMMANDS = {
  launch,
  open: () => open(String(positional[1])),
  eval: () => evaluate(String(positional[1])),
  text: () => evaluate('document.body.innerText'),
  aria,
  wait: async () => {
    const { cdp, sessionId } = await pageSession()
    try {
      const timeout = flags.timeout && flags.timeout !== true ? Number(flags.timeout) : 10000
      await waitFor(sessionId, `!!document.querySelector(${JSON.stringify(String(flags.selector))})`, timeout, cdp)
      console.log(`found ${flags.selector}`)
    } finally {
      cdp.close()
    }
  },
  click,
  type,
  screenshot,
  close,
}

if (!command || !COMMANDS[command]) {
  console.error(`usage: browser.mjs <${Object.keys(COMMANDS).join('|')}> [options]`)
  process.exit(2)
}

try {
  await COMMANDS[command]()
} catch (err) {
  console.error(`browser ${command}: ${err.message}`)
  process.exit(1)
}
