---
name: verify
description: Drive the agent-notify Agent Monitor dashboard and the notification plugins the way a user does — start the real dashboard, exercise the JSON endpoints and the live table in a real browser, prove a fix with a mutation, and capture evidence. Use when asked to verify, test, prove, reproduce, or check any change to the dashboard UI, its HTTP surface, the update check, the service manager, or the Orca/Herdr notification adapters.
---

# Verify agent-notify

Two user-facing surfaces live in this repo:

- **Agent Monitor dashboard** — the primary surface. `dashboard.mjs` serves a local web page plus `/api/agents` and `/api/update`, and manages itself as an OS service.
- **Notification plugins** — `main.mjs` (Orca) and `herdr/herdr-adapter.mjs` (Herdr) turn agent status events into desktop or ntfy notifications.

This skill drives the dashboard end to end and covers the plugins where the host accepts them. The feature map in `features/` is the maintained list; read `features/README.md` before driving, then use the matching feature file as the recipe.

Every command in this skill is run from the repo root. The skill itself lives in `.agents/skills/verify/` rather than the `.claude/skills/` a generated skill usually targets: `.claude/` is gitignored in this repo (`.gitignore:7`), so a skill committed there would need `git add -f` and would be invisible to everyone else. Pi discovers `.agents/skills/` from the working directory up to the repo root (see `docs/skills.md` in the Pi install), so this is the skill's committed home; do not move the directory back under `.claude/`.

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

A usable instance returns `{"agents":[...],"sources":{...}}` with HTTP 200. Startup prints the URL it bound: `⚡ Agent Monitor Dashboard running at: http://localhost:<port>` (the port is inside the URL, not on a line of its own).

Both runtimes are supported: `node dashboard.mjs` and `bun dashboard.mjs`. Run the suite and at least one driver under each when a change touches shared code. The drivers run under whichever runtime you invoke them with; `scripts/mutate.mjs` also takes `--runtime node|bun` and defaults to `node`.

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
node .agents/skills/verify/scripts/mutate.mjs --preflight   # run this first: every mutation anchor must still match the shipped code
node .agents/skills/verify/scripts/mutate.mjs --restore      # undo the leftover of a killed run, then stop
node .agents/skills/verify/scripts/mutate.mjs        # prove the suite still bites: revert each shipped fix, the named test must fail
node .agents/skills/verify/scripts/mutate.mjs --only unit-port-dropped --runtime bun
```

`mutate.mjs` refuses to run on a worktree with uncommitted tracked changes, because it edits the tracked files it reverts. Commit first, or run it in a copy. The one exception is a tree that is dirty only because a killed run left its own mutation applied: that is detected and repaired before the tree is judged, so the run is not blocked by the mess it made itself. It also refuses while another mutation driver is working in the same checkout (a lock file next to the artifacts): two runs would restore each other's mutation and overwrite the same evidence. A lock left by a dead run is taken over, and so is one whose recorded pid now runs something other than this driver (checked against `/proc` on Linux). When that cannot be checked — no `/proc`, or no permission to read it — the lock is left alone rather than risk two drivers in one checkout. Takeover renames the lock instead of deleting it and then checks that what moved is the lock it judged stale, so two drivers starting at once cannot delete a live lock: the loser puts the file back and refuses, and every mutation boundary re-checks that the lock is still this driver's. Only the holder releases the lock, so a driver that lost it to a takeover does not delete the new owner's. A `--only` run writes its evidence to `artifacts/mutations-partial.json` instead of `mutations.json`, so a focused run cannot be mistaken for the full catalogue. It restores every file it touched on `SIGINT`/`SIGTERM`/`SIGHUP` and on exit. A `kill -9` is the one case it cannot cover, so the next run looks for the leftover it left: a file whose bytes are exactly what one catalogue mutation produces from the committed file. That leftover is restored to the committed content before the tree is judged, and `--restore` does the same and stops there. A file that differs in any other way is never written to, so the recovery only ever undoes the driver's own edit. The one case it cannot tell apart is a file the operator edited to exactly the bytes a mutation would produce: that looks like a leftover and is reverted like one. Any other dirty file still stops the run, and the refusal says so, so a tree that is dirty without a leftover does not read like the old deadlock. The recovery compares the committed blob with the working file byte for byte, so a checkout that rewrites line endings (`core.autocrlf`) never matches and the recovery stays silent; the catalogue's own anchors are LF-only, so the driver does not work on such a checkout either. `--restore` exits 0 when the worktree is clean afterwards, 1 when it still has uncommitted changes, and 2 when the driver refused (another driver holds the lock, git cannot be read, or the restore itself failed). The mutation catalogue must not target the driver's own recovery path — every file under `.agents/skills/verify/scripts/` is refused by `--preflight` — because a killed run that left those files changed would leave the recovery unable to recognise a leftover, and an inverted comparison there would overwrite the operator's own work. An interrupt during a mutation stops the sweep at that mutation instead of continuing through the rest: the synchronous test child dies first, so the driver sees a killed child rather than a signal handler call, and it then restores, releases the lock and exits 130 without rewriting the evidence. A replacement that kills the suite before its summary is reported as an **abort inside the mutated file**, never as "caught by <test>": the trace goes to `artifacts/mutations/<id>.log`, and every fix that has such an entry also has a variant whose named test fails, so no fix rests on an abort alone.

`drive-ui.mjs` serves the **real page** (`renderDashboardHtml()` from `dashboard.mjs`) from `scripts/serve-stub.mjs` with deterministic fixtures instead of live Orca/Herdr probes, so the table's contents are fixed and a failure is a UI failure. The stub exposes `/control/fixture?name=mixed|swapped|empty` and `/control/polls`; `/api/update` returns a deliberately stale status.

Both drivers default to a free port, start their own instance, and tear it down when they exit — so a `browser.mjs` or `curl` step after the driver has finished has nothing to talk to. For a manual journey, start the stub yourself and keep it running:

```bash
node .agents/skills/verify/scripts/serve-stub.mjs --port 4742 &
# ... browser.mjs / curl against http://127.0.0.1:4742 ...
kill <pid>
```

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

Commands: `launch open eval text aria wait click type screenshot close`. Run `launch` then `open` first: every other command attaches to the session `launch` recorded in `artifacts/browser.json`. It resolves Chrome itself (`google-chrome`, `chromium`, `chromium-browser`, or the Playwright cache) and clicks through `Input.dispatchMouseEvent`, so a click goes through the page's real event handlers.

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
| `scripts/lib.mjs` | Shared helpers: `freePort`, `waitForDashboard`, `startDashboard`, `httpGet`, `rawGet`, `makeReport`, `runBrowser`, `gitHead`, `isDirty`, `countOccurrences`. |
| `scripts/browser.mjs` | Dependency-free CDP driver for the real page. |
| `scripts/serve-stub.mjs` | Fixture server serving the real dashboard HTML with fixed agent state. |
| `scripts/doctor.mjs` | Read-only "is this instance drivable?" check. |
| `scripts/drive-api.mjs` | The HTTP surface. |
| `scripts/drive-ui.mjs` | The browser journeys. |
| `scripts/mutations.mjs` | The catalogue of proven mutations. |
| `scripts/mutate.mjs` | Runs the catalogue and reports which tests bite. |
| `scripts/restore.mjs` | Finds and undoes the mutation a killed run left applied. |

Driver traps worth knowing before you edit them:

- Runtime floor: Node >= 22, or Bun. `browser.mjs` needs the global `WebSocket` and fails with an explicit message on an older Node instead of `WebSocket is not defined`.
- `drive-ui.mjs` passes its own `--state` file (`$TMPDIR/verify-browser-<pid>.json`), so it never adopts or closes a browser session you started by hand.
- `close` asks the browser to exit over its own debugger connection (`Browser.close`), which needs no pid at all. Only if that fails does it fall back to signalling the recorded pid, and only when `/proc` proves that pid still carries this run's `--user-data-dir`. On a platform without `/proc` the driver cannot prove it, so it says so, leaves the profile dir in place and never signals: a spent pid may now belong to something else.
- `launch` kills the browser and removes its profile dir if the first navigation fails, so a failed launch cannot leave a Chrome running that nothing will ever close. `drive-ui.mjs` only calls `close` after a launch that returned 0.
- `browser.mjs` retries with `--no-sandbox` only when the first launch failed with a sandbox refusal; any other startup failure is reported as itself.
- `fetch()` silently drops a custom `Host` header, so the DNS-rebinding check must go through `node:http` (`rawGet` in `lib.mjs`).
- Chrome's own sandbox cannot start in a nested container: when the first launch fails with a sandbox refusal, `browser.mjs` retries once with `--no-sandbox --disable-setuid-sandbox`.
- A browser that came up without its sandbox runs a page with this user's own permissions, so that session only opens `about:blank`, `data:text/html` and `http(s)` on `127.0.0.1`, `localhost` or `[::1]`; `launch` and `open` both refuse anything else. The refused `--no-sandbox` retry can therefore never point an unsandboxed browser at a third-party site.
- A spawned Chrome keeps the parent alive through inherited stdio; `browser.mjs` destroys and unrefs those pipes so `launch` exits.
- `innerText` applies CSS `text-transform`. The status badges are uppercased by stylesheet (`WORKING`, `BLOCKED`, `DONE / IDLE`) while the host tags stay as authored (`Orca`, `Herdr`). Assert the rendered case.

## Not verifiable here

These paths are part of the product but cannot be proven in this environment; report them as gaps rather than claiming coverage:

- **macOS `launchd`** install/status/uninstall and the plist it writes. Only the pure builders (`buildLaunchdPlist`) are covered, by unit test.
- **A real `systemd --user` install.** Installing writes into the operator's own unit directory (`~/.config/systemd/user/`) and starts a job in their login session, so it needs explicit approval and never belongs in a routine run. `--service status` is read-only and also fine to run: this host does have a user systemd manager (`systemctl --user is-system-running` answers `degraded`), so it returns a real answer here. The install path is otherwise proven by putting a fake `systemctl` first on `PATH` and running the real `--service install` subprocess (`test_cases.test.js`), and by reading the unit the builders generate.
- **The Windows Startup-folder path** and the generated `.vbs` launcher, which need Windows.
- **Live notification delivery.** Desktop popups and ntfy publishes need a real Orca or Herdr host and a reachable ntfy server; the dispatcher is covered by unit tests with the publisher stubbed.
- **Plugin loading by the real hosts.** `main.mjs` and `herdr-adapter.mjs` cannot be loaded without Orca or Herdr present; their event handling is covered by the suite.
