---
name: verify
description: Drive the agent-notify Agent Monitor dashboard and the notification plugins the way a user does — start the real dashboard, exercise the JSON endpoints and the live table in a real browser, prove a fix with a mutation, and capture evidence. Use when asked to verify, test, prove, reproduce, or check any change to the dashboard UI, its HTTP surface, the update check, the service manager, or the Orca/Herdr notification adapters.
---

# Verify agent-notify

Two user-facing surfaces live in this repo:

- **Agent Monitor dashboard** — the primary surface. `dashboard.mjs` serves a local web page plus `/api/agents` and `/api/update`, and manages itself as an OS service.
- **Notification plugins** — `main.mjs` (Orca) and `herdr/herdr-adapter.mjs` (Herdr) turn agent status events into desktop or ntfy notifications.

This skill drives the dashboard end to end and covers the plugins where the host accepts them. The feature map in `features/` is the maintained list; read `features/README.md` before driving, then use the matching feature file as the recipe.

Every command in this skill is run from the repo root.

## Launch

```bash
# A dashboard this run owns, on a port nothing else can claim.
PORT=$(node -e 'const n=require("node:net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
node dashboard.mjs --port "$PORT" &
```

Prefer `scripts/drive-api.mjs` and `scripts/drive-ui.mjs`: each picks a free port, starts its own instance, waits for readiness, and tears it down in a `finally` block. Reach for the raw command only when you are probing something the drivers do not cover.

**Ready means the API answers with the shape the page consumes**, not that a socket is open:

```bash
curl -fsS "http://127.0.0.1:$PORT/api/agents" | head -c 200
```

A usable instance returns `{"agents":[...],"sources":{...}}` with HTTP 200. Startup prints the bound port on its own line.

Both runtimes are supported: `node dashboard.mjs` and `bun dashboard.mjs`. Run the suite and at least one driver under each when a change touches shared code.

Teardown: kill the PID this run started, `kill <pid>`. The drivers do this themselves.

## Doctor

```bash
node .agents/skills/verify/scripts/doctor.mjs --port 3333
node .agents/skills/verify/scripts/doctor.mjs --port 3333 --expect-sha 325376a
```

Read-only, changes nothing, exits non-zero when the instance is not worth driving. It checks the API shape, the page title, the update endpoint, that a foreign `Host` header is refused with 403, and prints the checked-out revision (marking a dirty worktree). Run it first whenever output looks wrong: a port held by an unrelated server answers HTTP 200 and would otherwise look healthy.

## Drive

Three drivers, each self-contained and each ending with a pass/fail count and a JSON evidence file:

```bash
node .agents/skills/verify/scripts/drive-api.mjs     # HTTP surface: startup, endpoints, listen failure, symlinked entry point
node .agents/skills/verify/scripts/drive-ui.mjs      # real browser: the table, search, filter tabs, detail panel, update banner, polling
node .agents/skills/verify/scripts/mutate.mjs        # prove the suite still bites: revert each shipped fix, the named test must fail
node .agents/skills/verify/scripts/mutate.mjs --preflight   # check every mutation anchor, write nothing
node .agents/skills/verify/scripts/mutate.mjs --only unit-port-dropped --runtime bun
```

`drive-ui.mjs` serves the **real page** (`renderDashboardHtml()` from `dashboard.mjs`) from `scripts/serve-stub.mjs` with deterministic fixtures instead of live Orca/Herdr probes, so the table's contents are fixed and a failure is a UI failure. The stub exposes `/control/fixture?name=mixed|swapped|empty` and `/control/polls`; `/api/update` returns a deliberately stale status.

The browser driver is `scripts/browser.mjs`, a CDP client with no dependencies:

```bash
node .agents/skills/verify/scripts/browser.mjs launch
node .agents/skills/verify/scripts/browser.mjs open http://127.0.0.1:4742/
node .agents/skills/verify/scripts/browser.mjs eval 'document.title'
node .agents/skills/verify/scripts/browser.mjs aria --path artifacts/ui/page.aria.txt
node .agents/skills/verify/scripts/browser.mjs screenshot --path artifacts/ui/page.png
node .agents/skills/verify/scripts/browser.mjs click --selector '.filter-tab[data-filter="blocked"]'
node .agents/skills/verify/scripts/browser.mjs type --selector '#search-box' --value bravo
node .agents/skills/verify/scripts/browser.mjs close
```

Commands: `launch open eval text aria wait click type screenshot close`. It resolves Chrome itself (`google-chrome`, `chromium`, `chromium-browser`, or the Playwright cache) and clicks through `Input.dispatchMouseEvent`, so a click goes through the page's real event handlers.

Prefer the page's own stable handles over position: `#agent-table-body tr`, `.action-text[data-agent-id="<id>"]`, `.filter-tab[data-filter="all|working|blocked|settled"]`, `#search-box`, `#count-working`, `#tab-count-all`, `#update-banner`, `#update-commit`, `#sources-status`, `#last-updated`. Read the ARIA snapshot when a handle is not obvious.

## Evidence

Written under `.agents/skills/verify/artifacts/` (gitignored — never commit a run):

- `drive-api.json`, `drive-ui.json`, `mutations.json` — every check with its name, pass/fail, detail, timestamp, and the revision it ran against.
- `ui/*.aria.txt`, `ui/*.png` — the accessibility tree and a screenshot of the state a journey reached.
- `mutations/<id>.log` — the suite's output for a mutation that was not caught by a labelled assertion, so the abort can be read.

Proof standards for this repo:

- Exercise the real user path. For the dashboard that means the page served by `dashboard.mjs` (or by the stub, which serves the same function) and a real browser — not a call to an internal function.
- Capture the action and the resulting state, not just the final screen. A screenshot after a click is not proof that the click landed; assert the state change the user would see (a row count, a heading, a banner label).
- Verify side effects, not only the view: for the service manager read the written unit file or plist; for exporters check the bytes on disk.
- The dashboard polls every 3 s. Wait for the state you expect rather than sleeping a fixed time, and know that a row you read may update under you.
- A mutation is proof only when the failing test is the one named in `scripts/mutations.mjs`. Add an entry there with any fix whose test would otherwise be decorative.

## Cleanup

```bash
node .agents/skills/verify/scripts/browser.mjs close
```

The drivers clean up after themselves, including on failure: each stops the instances it started and closes the browser in a `finally` block. Rules for anything hand-started:

- Kill the PID you started. Never kill by process name — the user's own dashboard, plugins, and browser are usually running on this machine.
- Never drive or stop an instance this run did not start. If 3333 is already listening, that is the user's dashboard: start yours on a free port.
- Leave `.agents/skills/verify/artifacts/` in place. Cleanup removes instances and scratch state, never evidence.
- Scratch state lives under `os.tmpdir()`; the browser profile directory is removed by `browser.mjs close`.

## Helpers

| Helper | Purpose |
|---|---|
| `scripts/lib.mjs` | Shared helpers: `freePort`, `waitForDashboard`, `startDashboard`, `httpGet`, `rawGet`, `makeReport`, `runBrowser`, `gitHead`, `isDirty`. |
| `scripts/browser.mjs` | Dependency-free CDP driver for the real page. |
| `scripts/serve-stub.mjs` | Fixture server serving the real dashboard HTML with fixed agent state. |
| `scripts/doctor.mjs` | Read-only "is this instance drivable?" check. |
| `scripts/drive-api.mjs` | The HTTP surface. |
| `scripts/drive-ui.mjs` | The browser journeys. |
| `scripts/mutations.mjs` | The catalogue of proven mutations. |
| `scripts/mutate.mjs` | Runs the catalogue and reports which tests bite. |

Driver traps worth knowing before you edit them:

- `fetch()` silently drops a custom `Host` header, so the DNS-rebinding check must go through `node:http` (`rawGet` in `lib.mjs`).
- Chrome's own sandbox cannot start in a nested container: `browser.mjs` launches plain first and retries with `--no-sandbox --disable-setuid-sandbox`.
- A spawned Chrome keeps the parent alive through inherited stdio; `browser.mjs` destroys and unrefs those pipes so `launch` exits.
- `innerText` applies CSS `text-transform`. The status badges are uppercased by stylesheet (`WORKING`, `BLOCKED`, `DONE / IDLE`) while the host tags stay as authored (`Orca`, `Herdr`). Assert the rendered case.

## Not verifiable here

These paths are part of the product but cannot be proven in this environment; report them as gaps rather than claiming coverage:

- **macOS `launchd`** install/status/uninstall and the plist it writes. Only the pure builders (`buildLaunchdPlist`) are covered, by unit test.
- **A real `systemd --user` install.** There is no user systemd in this sandbox; the install path is tested with a stubbed `execSync` and by reading the generated unit.
- **The Windows Startup-folder path** and the generated `.vbs` launcher, which need Windows.
- **Live notification delivery.** Desktop popups and ntfy publishes need a real Orca or Herdr host and a reachable ntfy server; the dispatcher is covered by unit tests with the publisher stubbed.
- **Plugin loading by the real hosts.** `main.mjs` and `herdr-adapter.mjs` cannot be loaded without Orca or Herdr present; their event handling is covered by the suite.
