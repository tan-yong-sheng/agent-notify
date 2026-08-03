import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { failResult, okResult, isSuccessStatus } from './publish-result.mjs'

const execFileAsync = promisify(execFile)
const CURL_CANDIDATES = ['/usr/bin/curl', '/bin/curl', 'curl']
const PUBLISH_TIMEOUT_MS = 10_000

function resolveCurlBinary() {
  return CURL_CANDIDATES.find((candidate) => !candidate.includes('/') || existsSync(candidate)) || null
}

function buildCurlArgs(url, headers, body) {
  const args = ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', '--max-time', '10']
  for (const [key, value] of Object.entries(headers)) {
    args.push('-H', `${key}: ${value}`)
  }
  args.push('--data-binary', body, url)
  return args
}

function parseCurlStatus(stdout) {
  const code = Number.parseInt(String(stdout).trim(), 10)
  return Number.isFinite(code) ? code : null
}

function resultFromCurlCode(code, stdout) {
  if (code == null) return failResult('curl', `unexpected curl output: ${stdout}`)
  if (isSuccessStatus(code)) return okResult('curl', code)
  return failResult('curl', `HTTP ${code}`, code)
}

async function runCurl(curlBin, url, headers, body) {
  const { stdout } = await execFileAsync(curlBin, buildCurlArgs(url, headers, body), {
    encoding: 'utf8',
    timeout: PUBLISH_TIMEOUT_MS + 1000,
    maxBuffer: 1024,
  })
  return resultFromCurlCode(parseCurlStatus(stdout), stdout)
}

export async function publishWithCurl(url, headers, body) {
  const curlBin = resolveCurlBinary()
  if (!curlBin) return failResult('curl', 'curl not found')
  return runCurl(curlBin, url, headers, body).catch((err) =>
    failResult('curl', err.message || String(err))
  )
}
