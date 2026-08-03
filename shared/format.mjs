// ─── Shared notification body formatters ─────────────────────────────────────

// Build a minimal desktop notification body: state, location, and branch.
export function buildSimpleBody(state, location, branch) {
  const parts = [state]
  if (location) parts.push(location)
  if (branch) parts.push(`(${branch})`)
  return parts.join(' · ')
}
