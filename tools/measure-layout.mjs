// Measures the dashboard's layout at phone, tablet and desktop widths by
// emulating the viewport over CDP, which is what a real phone does. The repo's
// browser driver fixes its window at 1280x900, so this talks to the same DevTools
// endpoint directly rather than changing the driver for a one-off measurement.
//
//   node tools/measure-layout.mjs <url> [portFile]

import fs from 'node:fs'
import http from 'node:http'

const url = process.argv[2] || 'http://127.0.0.1:3977/'
const statePath = process.argv[3] || '.agents/skills/verify/artifacts/browser.json'

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
const port = state.port

function httpJson(pathName) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: pathName }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve(JSON.parse(body)))
      })
      .on('error', reject)
  })
}

const targets = await httpJson('/json/list')
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('no page target; launch the browser driver first')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  const resolver = pending.get(msg.id)
  if (resolver) {
    pending.delete(msg.id)
    resolver(msg)
  }
})
await new Promise((resolve) => ws.addEventListener('open', resolve))

function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, resolve))
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text)
  return res.result?.result?.value
}

const MEASURE = `(() => {
  const container = document.querySelector('.table-container')
  const table = document.querySelector('table')
  const row = document.querySelector('#agent-table-body tr')
  const thead = document.querySelector('thead')
  const chip = document.querySelector('.path-chip')
  const r = (el) => el ? Math.round(el.getBoundingClientRect().width) : null
  return {
    viewport: window.innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    container: r(container),
    containerOverflowX: container ? Math.round(container.scrollWidth - container.clientWidth) : null,
    table: r(table),
    rowDisplay: row ? getComputedStyle(row).display : null,
    theadDisplay: thead ? getComputedStyle(thead).display : null,
    chipWidth: r(chip),
    columnsPerRow: row ? getComputedStyle(row).display === 'table-row' ? 'table-row' : 'stacked-card' : null,
  }
})()`

const results = []
for (const [label, width, height] of [
  ['phone', 390, 844],
  ['tablet', 768, 1024],
  ['desktop', 1280, 900],
]) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: label === 'phone',
  })
  await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
  const measured = await evaluate(MEASURE)
  results.push({ label, ...measured })
}

await send('Emulation.clearDeviceMetricsOverride')
console.log(JSON.stringify(results, null, 2))
ws.close()
