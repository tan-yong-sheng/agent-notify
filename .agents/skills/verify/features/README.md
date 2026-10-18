# agent-notify verification map

This directory is the maintained source for verifying the user-facing behavior of agent-notify. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Start a dashboard this run owns, on a port nothing else can claim. `scripts/drive-api.mjs` and `scripts/drive-ui.mjs` do this for you.
- Never drive an instance this run did not start. Port 3333 is usually the user's own dashboard; if it answers, leave it alone.
- `scripts/drive-ui.mjs` serves the real page from `scripts/serve-stub.mjs` with the `mixed` fixture: `orca:alpha` (working), `orca:bravo` (blocked), `herdr:charlie` (settled, no branch).
- Run `node .agents/skills/verify/scripts/doctor.mjs --port <port>` and require a drivable instance before interpreting any UI result.
- Both runtimes ship: repeat a run under `bun` when the change touches shared code.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Reset state through the stub's own control routes: `/control/fixture?name=mixed|swapped|empty`, `/control/polls`.
- Prefer the page's stable handles and ARIA tree over position: `#agent-table-body tr`, `.action-text[data-agent-id="<id>"]`, `.filter-tab[data-filter="..."]`, `#search-box`, `#update-commit`, `#sources-status`.
- Treat every command as literal. Keep quoted selectors and values unchanged.
- Drive the browser only through `scripts/browser.mjs`; drive HTTP through `curl` or `scripts/lib.mjs`.
- A journey that finds a precondition missing reports a failure and names the missing precondition. Never weaken a journey to make it pass.
- Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes the ARIA snapshot and a screenshot under `artifacts/ui/`, with the app identity visible.
- Terminal proof includes the command, stdout, stderr, and exit code.
- Every run writes `artifacts/<driver>.json` with each check's name, result, detail, and the revision it ran against.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.
- A fix is proven by a mutation that the named test catches, not by a passing test alone. Add it to `scripts/mutations.mjs`.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with <harness>` names the harness the run invokes — the script, suite, or CLI that drives the entry points — and starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Live agent monitor](./dashboard-live-monitor.md) covers the table, status counts, search, filter tabs, and detail panel.
- [Update check](./dashboard-update-check.md) covers the update banner and the terminal check/update commands.
- [Service management](./service-manager.md) covers installing the dashboard as a login service on Linux, macOS, and Windows.
- [Notifications](./notify-pipeline.md) covers the delivery of a settle/blocked notification from Orca and Herdr.
- [Agent state adapters](./adapter-context.md) covers how host state and context become dashboard rows and notifications.
