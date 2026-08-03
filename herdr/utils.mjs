// ─── Herdr event/context parsing helpers ─────────────────────────────────────

function safeJsonParse(name, value) {
  try {
    return value ? JSON.parse(value) : {}
  } catch (err) {
    console.error(`Invalid ${name}:`, err.message)
    return {}
  }
}

function normalizeEvent(event) {
  return event && event.data ? event.data : {}
}

function normalizeContext(context) {
  return context || {}
}

function contextStatus(context) {
  return context.focused_pane_status || context.agent_status || context.status
}

function contextAgent(context) {
  return context.focused_pane_agent || context.agent
}

function contextWorkspace(context) {
  return context.focused_pane_workspace || context.workspace
}

function contextTab(context) {
  return context.focused_pane_tab || context.tab
}

// Parse environment-set JSON event and context.
export function parseEventEnv() {
  return safeJsonParse('HERDR_PLUGIN_EVENT_JSON', process.env.HERDR_PLUGIN_EVENT_JSON)
}

export function parseContextEnv() {
  return safeJsonParse('HERDR_PLUGIN_CONTEXT_JSON', process.env.HERDR_PLUGIN_CONTEXT_JSON)
}

// Extract agent status from the combined event + context payload.
export function extractStatus(event, context) {
  return extractStatusFromData(normalizeEvent(event), normalizeContext(context))
}

function extractStatusFromData(data, context) {
  return (data.agent_status || contextStatus(context) || '').toLowerCase()
}

// Extract agent identity from event + context.
export function extractAgent(event, context) {
  return extractAgentFromData(normalizeEvent(event), normalizeContext(context))
}

function extractAgentFromData(data, context) {
  return data.display_agent || data.agent || contextAgent(context) || 'Agent'
}

function extractWorkspaceFromData(data, context) {
  const candidates = [
    data.workspace,
    contextWorkspace(context),
    data.agent_session_path,
    context.agent_session_path,
    data.cwd,
    context.cwd,
  ]
  for (const value of candidates) {
    if (value) return value
  }
  return ''
}

function extractTabFromData(data, context) {
  return data.tab || contextTab(context) || ''
}

function extractPaneIdFromData(data, context) {
  return data.pane_id || context.focused_pane_id || ''
}

// Extract workspace location details.
export function extractWorkspaceContext(event, context) {
  const data = normalizeEvent(event)
  const ctx = normalizeContext(context)
  return {
    workspace: extractWorkspaceFromData(data, ctx),
    tab: extractTabFromData(data, ctx),
    paneId: extractPaneIdFromData(data, ctx),
  }
}

function extractCustomStatusFromData(data, context) {
  return data.custom_status || context.custom_status || ''
}

function extractErrorFromData(data) {
  const labels = data.state_labels || {}
  return labels.error || ''
}

function extractTitleFromData(data, context) {
  return data.title || context.title || ''
}

// Extract supplementary status fields.
export function extractSupplementaryStatus(event, context) {
  const data = normalizeEvent(event)
  const ctx = normalizeContext(context)
  return {
    customStatus: extractCustomStatusFromData(data, ctx),
    error: extractErrorFromData(data),
    title: extractTitleFromData(data, ctx),
  }
}
