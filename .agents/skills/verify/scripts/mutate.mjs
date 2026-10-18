#!/usr/bin/env node

// Proves the suite still bites: each mutation reverts one shipped fix and the
// named test must fail. A mutation that survives means the test is decorative.
//
// Usage:
//   node .agents/skills/verify/scripts/mutate.mjs --preflight     check anchors, write nothing
//   node .agents/skills/verify/scripts/mutate.mjs [--only <id>] [--runtime node|bun]
//
// The run refuses to start on a dirty worktree: it edits tracked files in place
// and restores them from memory, so a clean tree is the recovery path.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs, flagValue, makeReport, REPO_ROOT, ARTIFACTS, gitHead, isDirty } from './lib.mjs'
import { MUTATIONS } from './mutations.mjs'

const flags = parseArgs(process.argv.slice(2))
const preflight = flags.preflight === true
const only = flagValue(flags, 'only', '')
const runtime = flagValue(flags, 'runtime', 'node')
const testFile = path.join(REPO_ROOT, 'test_cases.test.js')
const testSource = fs.readFileSync(testFile, 'utf8')

function countOccurrences(haystack, needle) {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

function inspect(mutation) {
  const target = path.join(REPO_ROOT, mutation.file)
  if (!fs.existsSync(target)) return { usable: false, reason: `missing file ${mutation.file}` }
  const source = fs.readFileSync(target, 'utf8')
  const anchors = countOccurrences(source, mutation.find)
  if (anchors === 0) return { usable: false, reason: 'anchor not found' }
  if (anchors > 1) return { usable: false, reason: `anchor appears ${anchors} times` }
  if (!testSource.includes(mutation.expectTest)) {
    return { usable: false, reason: `no test labelled "${mutation.expectTest}"` }
  }
  return { usable: true, target, source }
}

const selected = MUTATIONS.filter((m) => !only || m.id === only)
if (!selected.length) {
  console.error(only ? `no mutation with id "${only}"` : 'no mutations defined')
  process.exit(2)
}

if (preflight) {
  let bad = 0
  for (const mutation of selected) {
    const state = inspect(mutation)
    if (state.usable) console.log(`ok    ${mutation.id}`)
    else {
      bad++
      console.log(`SKIP  ${mutation.id} — ${state.reason}`)
    }
  }
  console.log(`\n${selected.length - bad}/${selected.length} mutations are runnable`)
  process.exit(bad ? 1 : 0)
}

if (isDirty(REPO_ROOT, { trackedOnly: true })) {
  console.error('refusing to run: tracked files have uncommitted changes, so a broken mutation could not be told apart from your work')
  process.exit(2)
}

function classify(mutation, output) {
  if (output.includes(`✗ ${mutation.expectTest}`)) return { ok: true, detail: `caught by "${mutation.expectTest}"` }
  if (!/Results:/.test(output)) {
    // An uncaught error kills the suite before it prints its summary. That still
    // fails the build, but it only counts when the trace names the mutated file:
    // otherwise the replacement did not parse and proves nothing about the test.
    if (/SyntaxError/.test(output)) return { ok: false, detail: 'the replacement does not parse' }
    if (output.includes(mutation.file)) return { ok: true, detail: `aborted the suite inside ${mutation.file} before it could print a summary` }
    return { ok: false, detail: 'the suite aborted without naming the mutated file' }
  }
  return { ok: false, detail: `SURVIVED: "${mutation.expectTest}" still passed` }
}

function writeMutationLog(id, output) {
  const dir = path.join(ARTIFACTS, 'mutations')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.log`)
  fs.writeFileSync(file, output)
  return file
}

const report = makeReport('mutate')
const touched = new Map()

function restoreAll() {
  for (const [file, source] of touched) {
    fs.writeFileSync(file, source)
    if (fs.readFileSync(file, 'utf8') !== source) report.check(`restored ${path.relative(REPO_ROOT, file)}`, false, 'file differs from the original after restore')
  }
}

try {
  for (const mutation of selected) {
    const state = inspect(mutation)
    if (!state.usable) {
      report.check(mutation.id, false, `cannot run: ${state.reason}`)
      continue
    }
    if (!touched.has(state.target)) touched.set(state.target, state.source)
    const started = Date.now()
    let output = ''
    try {
      fs.writeFileSync(state.target, state.source.replace(mutation.find, mutation.replace))
      output = execFileSync(runtime, ['test_cases.test.js'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 900000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      output = `${err.stdout || ''}${err.stderr || ''}`
    } finally {
      fs.writeFileSync(state.target, state.source)
    }
    const reported = /Results:/.test(output)
    const verdict = classify(mutation, output)
    const seconds = ((Date.now() - started) / 1000).toFixed(0)
    const detail = `${mutation.description} — ${verdict.detail}${reported ? '' : ` (see ${path.relative(REPO_ROOT, writeMutationLog(mutation.id, output))})`} in ${seconds}s`
    report.check(mutation.id, verdict.ok, detail)
  }
} finally {
  restoreAll()
}

if (isDirty(REPO_ROOT, { trackedOnly: true })) {
  report.check('the worktree is clean after the run', false, 'mutation driver left changes behind')
} else {
  report.check('the worktree is clean after the run', true)
}
report.check('the run matches the checked-out revision', true, gitHead())
report.writeEvidence('mutations.json')
report.finish()
