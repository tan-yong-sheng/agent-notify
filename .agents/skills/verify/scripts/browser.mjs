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
//   viewport --width N [--height N] [--mobile]
//   key <Tab|Enter|Space|Escape|ArrowDown|...> [--shift]
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
// true: provably this session's Chrome. false: provably something else, or gone.
// 'unknown': this platform cannot show the command line, so the caller must not
// signal the pid — refusing to guess is the only safe answer to a recycled pid.
function pidIsOurChrome(pid, userDataDir) {
  if (!pid) return false
  if (!PROC_AVAILABLE) return 'unknown'
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(userDataDir)
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ESRCH') return false
    return 'unknown'
  }
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

const portOf = (state) => {
  if (Number.isInteger(state.port)) return state.port
  const match = /:(\d+)\//.exec(String(state.ws || ''))
  return match ? Number(match[1]) : null
}

// The devtools endpoint is the browser's own identity: the socket path carries a
// random token, so an answer from it proves this session's browser is still up
// without trusting a pid at all.
async function endpointGone(port, deadline) {
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`)
    } catch {
      return true
    }
    await sleep(100)
  }
  return false
}

// With its sandbox off, Chrome runs a page with this user's own permissions. A
// sandbox refusal must not turn into an unsandboxed browser pointed at someone
// else's site, so that combination is limited to this machine's fixture servers.
const LOCAL_URL = /^(about:blank$|data:text\/html[,;]|https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?([/?#]|$))/
const isLocalUrl = (url) => LOCAL_URL.test(String(url))

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
  // A device-metrics override belongs to the session that set it, and every
  // command here attaches a fresh one, so the recorded viewport is re-applied
  // rather than lost between commands.
  if (state.viewport) await applyViewport(cdp, sessionId, state.viewport)
  return { cdp, sessionId, state }
}

function applyViewport(cdp, sessionId, viewport) {
  return cdp.send(
    'Emulation.setDeviceMetricsOverride',
    {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor ?? 2,
      mobile: Boolean(viewport.mobile),
    },
    sessionId
  )
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
  // Chrome is always started on about:blank and navigated afterwards, so the
  // caller's URL cannot reach a browser before the sandbox check below runs: an
  // argument would load the page first and ask about the sandbox second.

  let attempt = await startChrome({ chrome, port, userDataDir, url: 'about:blank', extraArgs: [] })
  // A browser that started but cannot be used must not be left behind: its
  // process and its profile dir would outlive the driver, and drive-ui.mjs only
  // calls close after a launch that succeeded.
  const abort = async (message) => {
    try {
      attempt?.child.kill('SIGKILL')
    } catch {}
    fs.rmSync(statePath, { force: true })
    // Wait for the browser's helpers to go before deleting the profile they were
    // writing into: removing it mid-write can fail on files that reappear, and the
    // failure used to be dropped silently.
    if (attempt?.info) await endpointGone(port, Date.now() + 3000)
    else await sleep(150)
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      console.log(`note: could not remove the disposable profile ${userDataDir}; deleting it by hand is safe`)
    }
    throw new Error(message)
  }
  let sandbox = 'on'
  if (!attempt.info) {
    const log = attempt.log
    if (!SANDBOX_REFUSAL.test(log)) {
      await abort(
        `Chrome did not expose a debugger on port ${port}, and the failure is not a sandbox refusal, so it is not retried with the sandbox off\n${tailOf(log)}`
      )
    }
    attempt.child.kill('SIGKILL')
    attempt = await startChrome({ chrome, port, userDataDir, url: 'about:blank', extraArgs: ['--no-sandbox', '--disable-setuid-sandbox'] })
    sandbox = 'off'
  }
  if (!attempt.info) await abort(`Chrome did not expose a debugger on port ${port}\n${tailOf(attempt.log)}`)
  if (sandbox === 'off' && !isLocalUrl(url)) {
    await abort(
      `Chrome only started without its sandbox, and this driver will not point an unsandboxed browser at ${url}: only about:blank, data: and http(s) on 127.0.0.1, localhost or [::1] are allowed. Pass a local URL, or fix the sandbox refusal (see SKILL.md).`
    )
  }
  writeState({ pid: attempt.child.pid, port, ws: attempt.info.webSocketDebuggerUrl, userDataDir, chrome, sandbox, targetId: null })
  // The browser outlives this command; drop the pipes and the child handle so
  // the driver process can exit instead of waiting on Chrome's stdio.
  attempt.child.stdout?.destroy()
  attempt.child.stderr?.destroy()
  attempt.child.unref()
  try {
    await open(url)
  } catch (err) {
    await abort(`Chrome started on port ${port} but the first navigation to ${url} failed: ${err.message}`)
  }
  console.log(`launched ${path.basename(chrome)} pid ${attempt.child.pid} on port ${port} (browser sandbox ${sandbox})`)
}

async function open(url) {
  const state = readState()
  if (state.sandbox === 'off' && !isLocalUrl(url)) {
    throw new Error(
      `this browser session runs without its sandbox, so it is limited to local URLs; refusing to open ${url}. Finish with "close" and relaunch once the sandbox works.`
    )
  }
  const cdp = await Cdp.connect(state.ws)
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url })
    writeState({ ...state, targetId })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.enable', {}, sessionId)
    // A viewport set before the navigation is how a run drives a phone-size
    // layout: the width has to hold while the page lays out, not after.
    if (state.viewport) await applyViewport(cdp, sessionId, state.viewport)
    await waitFor(sessionId, 'document.readyState === "complete"', 15000, cdp).catch(() => {})
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId)
    console.log(result.value)
  } finally {
    cdp.close()
  }
}

async function viewport() {
  const width = Number(flags.width)
  if (!Number.isInteger(width) || width < 1) throw new Error('viewport needs --width N')
  const height = flags.height && flags.height !== true ? Number(flags.height) : 800
  const viewport = { width, height, mobile: Boolean(flags.mobile), deviceScaleFactor: 2 }
  const state = readState()
  // Recorded before the override is attempted so a session that has not opened
  // a page yet still gets the width when it does.
  writeState({ ...state, viewport })
  if (!state.targetId) {
    console.log(`viewport ${width}x${height} recorded; it applies when the page opens`)
    return
  }
  const { cdp, sessionId } = await pageSession()
  try {
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'innerWidth + "x" + innerHeight', returnByValue: true }, sessionId)
    console.log(`viewport ${width}x${height}; page now reports ${result.value}`)
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

// A real key event, so a journey can be proved from the keyboard rather than by
// calling the page's handlers directly. Tab is the interesting one: it is what
// makes the browser move focus and what makes :focus-visible match.
const KEYS = {
  tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: undefined },
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27, text: undefined },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, text: undefined },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, text: undefined },
}

async function key() {
  const name = String(flags.key || positional[1] || '').toLowerCase()
  const spec = KEYS[name]
  if (!spec) throw new Error(`unknown key: ${name}; known: ${Object.keys(KEYS).join(', ')}`)
  const { cdp, sessionId } = await pageSession()
  try {
    const modifiers = flags.shift ? 8 : 0
    const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, modifiers }
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: spec.text ? 'keyDown' : 'rawKeyDown', text: spec.text }, sessionId)
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, sessionId)
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const el = document.activeElement; return el ? (el.id || el.className || el.tagName) : 'none'; })()`,
      returnByValue: true,
    }, sessionId)
    console.log(`pressed ${name}; focus is now ${result.value}`)
  } finally {
    cdp.close()
  }
}

async function click() {  const selector = String(flags.selector)
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
  const port = portOf(state)
  const cdp = await Cdp.connect(state.ws).catch(() => null)
  if (cdp) {
    if (state.targetId) await cdp.send('Target.closeTarget', { targetId: state.targetId }).catch(() => {})
    // Ask the browser to exit over its own debugger connection. This needs no pid,
    // so a recycled pid cannot make the driver signal an unrelated process.
    await cdp.send('Browser.close').catch(() => {})
    cdp.close()
  }
  let stopped = port ? await endpointGone(port, Date.now() + 5000) : false
  if (!stopped) {
    const ours = pidIsOurChrome(state.pid, state.userDataDir)
    if (ours === true) {
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        try {
          process.kill(state.pid, signal)
        } catch {}
        if (port ? await endpointGone(port, Date.now() + 4000) : !pidAlive(state.pid)) {
          stopped = true
          break
        }
      }
    } else if (ours === 'unknown') {
      console.log(
        `pid ${state.pid}: this platform does not expose the command line, so the driver cannot prove the pid is still its browser and will not signal it. Stop it yourself, then remove ${state.userDataDir}.`
      )
    } else {
      console.log(`pid ${state.pid} is no longer this session's Chrome (it exited and the pid was reused); not signalling it`)
    }
  }
  fs.rmSync(statePath, { force: true })
  if (!stopped) {
    // The profile is only safe to delete once its Chrome is gone: Chrome keeps
    // writing into it while it shuts down. Keeping it is the recoverable choice.
    console.log(`closed the session; the browser on port ${port} did not stop, so its profile dir is kept at ${state.userDataDir}`)
    return
  }
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
  viewport,
  key,
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
