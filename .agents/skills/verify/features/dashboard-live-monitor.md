# Live agent monitor

The dashboard table shows every coding agent running under Orca and Herdr in one list: what it is doing now, which host it belongs to, which workspace and branch it runs in, and the tool or prompt it last acted on. The page refreshes itself every three seconds without reloading.

## Sub-features

- `monitor-open` serves the page and its agent payload from one local port.
- `monitor-status` shows each agent as working, blocked, or settled, with per-status counts.
- `monitor-host` labels each row with the host it came from and reports per-host source health.
- `monitor-context` shows the workspace directory, git branch, and last tool or prompt per row.
- `monitor-search` narrows the table to a typed query, with an explicit empty state.
- `monitor-filter` restricts the table to all, working, blocked, or settled agents.
- `monitor-inspect` opens a row's full prompt and tool in a detail panel.
- `monitor-timing` shows how long a row has been running, and when a settled row's settle time is known, in one wording for both runtimes. Orca reports a start time; Herdr's is recorded by the plugin adapter on each status change, so both are measured timestamps, not estimates.
- `monitor-poll` refreshes rows in place without a page load.

## How to get to it (user POV)

- Run `node dashboard.mjs` (or `bun dashboard.mjs`) and open the printed URL.
- Run `node dashboard.mjs --port 8080` for a different port, or set `DASHBOARD_PORT`.
- Type in the search box above the table.
- Choose one of the `All`, `Working`, `Blocked`, `Settled` tabs.
- Click a row's activity cell to inspect the full prompt.

## Driving it with drive-ui.mjs and browser.mjs

Preconditions:

- A dashboard this run started is healthy at the port under test (`doctor.mjs` reports a drivable instance).
- For the table journeys, the page is served by `scripts/serve-stub.mjs` with the `mixed` fixture, which the stub sets by default.
- The fixture is restored with `GET /control/fixture?name=mixed` before a journey that changed it.
- Run the automated journey first: `node .agents/skills/verify/scripts/drive-ui.mjs` runs the stub, the browser, every check below, and tears everything down. It defaults to a free port; add `--port 4742` to pin one. Because it tears the stub down on exit, the manual journeys below need their own:

```bash
node .agents/skills/verify/scripts/serve-stub.mjs --port 4742 &   # record the PID
node .agents/skills/verify/scripts/browser.mjs launch
node .agents/skills/verify/scripts/browser.mjs open http://127.0.0.1:4742/
# ... journey ...
node .agents/skills/verify/scripts/browser.mjs close && kill <stub pid>
```

- **Open the page.** Open `http://127.0.0.1:4742/` in the browser session, or run the whole automated journey (`drive-ui.mjs`). The title check reads `Agent Monitor` while the header names the product.
- **Read the status counts.** Look at the counters above the table. Run `node .agents/skills/verify/scripts/browser.mjs eval 'document.getElementById("count-working").innerText'`. Against the `mixed` fixture the counts are working `1`, blocked `1`, settled `1`, total `3`.
- **Read the rows.** Scan the table body. Run `node .agents/skills/verify/scripts/browser.mjs eval 'Array.from(document.querySelectorAll("#agent-table-body tr")).map((tr) => tr.innerText)'`. Three rows appear, carrying `WORKING`, `BLOCKED`, `DONE / IDLE`, the host tags `Orca` and `Herdr`, and the branch `feat/alpha`.
- **See a missing value.** Look at the Herdr row `herdr:charlie`. Run the row eval above. Its branch cell renders `—` because the fixture row has no branch.
- **Read how long a row has been running.** Look at the activity badge of `orca:bravo`, the blocked row. Run `node .agents/skills/verify/scripts/browser.mjs eval 'Array.from(document.querySelectorAll("#agent-table-body tr"))[1].innerText'`. The badge reads `BLOCKED · 1m`, because Orca reports when the run began. The `m` stays lowercase: the duration sits outside the badge's uppercase transform, which would otherwise print `1M` — a month.
- **Read a recorded Herdr duration.** Serve `/control/fixture?name=herdr-recorded`, one running Herdr row with a recorded start, and read the badge. It reads `WORKING · 4h`, the same measured form an Orca row uses.
- **See that an unrecorded Herdr row has no duration.** Serve `/control/fixture?name=herdr-running`, whose `stateSince` is only observed. The badge reads `WORKING` with no duration. Switch back with `/control/fixture?name=mixed`.
- **Read when a settled row settled.** Look at the last column of `herdr:charlie`. Run `node .agents/skills/verify/scripts/browser.mjs eval 'document.querySelectorAll("#agent-table-body tr")[2].innerText'`. It reads `Settled 10m ago`, the same wording an Orca settled row uses; a running row reads `Active now`.
- **Search.** Type in the search box. Run `node .agents/skills/verify/scripts/browser.mjs type --selector '#search-box' --value bravo`. One row remains, `orca:bravo`.
- **Search with no match.** Type a query that matches nothing. Run `node .agents/skills/verify/scripts/browser.mjs type --selector '#search-box' --value zzz-nothing`. The table shows the single empty-state row `No agents match the current filter.`
- **Filter.** Choose the `Blocked` tab. Run `node .agents/skills/verify/scripts/browser.mjs click --selector '.filter-tab[data-filter="blocked"]'`. Only `orca:bravo` remains; the `Working` tab then leaves only `orca:alpha`, and `all` restores three rows.
- **Inspect a prompt.** Click a row's activity cell. Run `node .agents/skills/verify/scripts/browser.mjs click --selector '.action-text[data-agent-id="orca:alpha"]'`. `getComputedStyle(document.getElementById("modal-backdrop")).display` is `flex` and the panel contains `TOOL: Bash` and `PROMPT:`. Choosing `.modal-close` returns the display to `none`.
- **Watch it refresh.** Read the poll count from the stub, wait longer than one interval, read it again. With the stub from the preconditions running: run `curl -fsS "http://127.0.0.1:4742/control/polls"`, wait 7 s, and run it again. The count grows by at least two and `performance.getEntriesByType("navigation").length` is still `1` — the page updated without reloading.
- **Proof.** Capture the populated table. Run `node .agents/skills/verify/scripts/browser.mjs aria --path .agents/skills/verify/artifacts/ui/mixed.aria.txt` and `.../browser.mjs screenshot --path .agents/skills/verify/artifacts/ui/mixed.png`. Both artifacts identify Agent Monitor and the three fixture rows.

## Gotchas

- The status badges are uppercased by the stylesheet, so `innerText` returns `WORKING` and `BLOCKED`, not `Working` and `Blocked`. The host tags stay as authored (`Orca`, `Herdr`). Assert the rendered case. The duration beside the state is the exception: `.badge-duration` cancels the transform so `12m` does not render as `12M`.
- Herdr reports no timestamps at all, so a duration from its own payload would count from when this page started looking: an agent four hours into a run was labelled `32m+` on a dashboard started 32 minutes earlier. The plugin adapter therefore records when it observes each status change, in the state file `shared/timings.mjs` owns, and `shared/catalog.mjs` reads that time onto the row.
- `showsDuration()` in `dashboard.mjs` allows a duration only for an exact start. For an Orca row that means the runtime reported it. For a Herdr row it means the adapter recorded a transition for this pane whose recorded status still matches the row; a Herdr row with no usable record shows no duration, and never an estimate.
- A pane already running when the adapter is first installed has no recorded time until its next status change. Expect `WORKING` with no duration for it; do not treat that as a defect.
- `driving` against the stub exercises rendering only: the stub supplies `stateSince`/`stateSinceExact` in its fixture, so the observation logic itself is covered by the `timing column tests` group in `test_cases.test.js`, not by this browser run.
- A green `drive-ui.mjs` run proves the page and its rendering, not the live probe path: the stub replaces the Orca and Herdr probes. The probes are covered by `drive-api.mjs`, which starts the real `dashboard.mjs`.
- Row order follows the order the payload arrives in, so rows move when the upstream order changes. `drive-ui.mjs` reports this as a failing check on purpose; it is a known defect, not a harness bug. Do not silence it — that check is the acceptance test for the fix and goes green only when rows keep their position across a payload reorder.
- The page polls every 3 s. Wait for the expected state instead of sleeping a fixed time, and treat a row you read mid-poll as possibly stale.
- Clicking a workspace path copies it to the clipboard and shows a toast. This run does not assert clipboard contents.
- The detail panel and the search box keep state across polls. Reset the query or filter between journeys.
