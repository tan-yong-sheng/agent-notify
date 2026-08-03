// ─── ntfy tag / emoji assignment from status, agent, and message text ────────

const BLOCKED_QUESTION_MARKERS = ['?', 'prompt', 'choose', 'ask']
const BLOCKED_ERROR_MARKERS = ['error', 'fail', 'exception']
const AGENT_EMOJI_MAP = [
  { marker: 'codex', tag: 'scroll' },
  { marker: 'hermes', tag: 'speech_balloon' },
  { marker: 'omp', tag: 'tools' },
  { marker: 'pi', tag: 'tools' },
  { marker: 'task', tag: 'tools' },
]

function isQuestionText(text) {
  return BLOCKED_QUESTION_MARKERS.some(m =>
    m === '?' ? text.includes(m) : text.toLowerCase().includes(m)
  )
}

function isErrorText(text) {
  return BLOCKED_ERROR_MARKERS.some(m => text.toLowerCase().includes(m))
}

function addBlockedTag(tags, text) {
  if (isQuestionText(text)) tags.add('question')
  else if (isErrorText(text)) tags.add('x')
  else tags.add('warning')
}

function addStatusTag(tags, status, text) {
  if (status === 'done') {
    tags.add('white_check_mark')
    return
  }
  if (status !== 'blocked') return
  addBlockedTag(tags, text)
}

function addAgentTag(tags, agent) {
  const lower = (agent || '').toLowerCase()
  for (const { marker, tag } of AGENT_EMOJI_MAP) {
    if (lower.includes(marker)) {
      tags.add(tag)
      return
    }
  }
}

// Build sensible tags from the status and message content.
export function buildTags(status, agent, text) {
  const tags = new Set()
  addStatusTag(tags, status, text)
  addAgentTag(tags, agent)
  if (text.toLowerCase().includes('test')) tags.add('test_tube')
  return [...tags].join(',')
}
