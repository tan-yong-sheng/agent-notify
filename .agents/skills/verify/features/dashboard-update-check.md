# Update check

The dashboard tells you when your checkout is behind the branch it tracks: a banner on the page, and the same answer from the terminal with `--check-update`, `--update-status-json`, and `--update`. It shows a banner only when you are genuinely behind, and when a check cannot run it says so instead of pretending you are current.

## Sub-features

- `update-banner` shows a banner on the page when a newer revision exists.
- `update-stale` labels a status that could not be refreshed as last known.
- `update-check` prints the human-readable result in the terminal.
- `update-json` prints the same result as JSON, optionally for another checkout.
- `update-apply` fast-forwards the tracked upstream and restarts an active service only when HEAD moved.
- `update-refuse` refuses to act on a detached HEAD or a branch that does not track the update target.
- `update-endpoint` serves the status the banner renders at `/api/update`.

## How to get to it (user POV)

- Open the dashboard page and look at the banner above the table.
- Run `node dashboard.mjs --check-update`.
- Run `node dashboard.mjs --update-status-json` (optionally `--update-status-json /path/to/checkout`).
- Run `node dashboard.mjs --update`.
- `GET /api/update` on the running dashboard.

## Driving it with browser.mjs and the dashboard CLI

Preconditions:

- The page journeys use `scripts/serve-stub.mjs`, whose `/api/update` returns a deliberately stale status (`stale: true`, `hasUpdate: true`, `aaaaaaa → bbbbbbb`). Start it yourself for a manual read — `drive-ui.mjs` starts and stops its own:

```bash
node .agents/skills/verify/scripts/serve-stub.mjs --port 4742 &
node .agents/skills/verify/scripts/browser.mjs launch
node .agents/skills/verify/scripts/browser.mjs open http://127.0.0.1:4742/
```

- The terminal journeys run against a checkout this run owns. Never run `--update` in the user's working checkout, and never in the worktree you are editing.

- **See the banner.** Open the page (`drive-ui.mjs` already asserts this as *a stale update status is labelled as last known*) and read `document.getElementById("update-banner").style.display`. It is not `none`, and `#update-commit` ends with `(last known, the update check could not run)` because the stub's status is stale.
- **Check from the terminal.** Run `node dashboard.mjs --check-update`. Exit code `0`. With a clean checkout it prints `✨ Already up to date (commit: <sha>).`; with local commits it prints `✨ Up to date with origin/main (<sha>); N local commit(s) not on the remote.`; when behind it prints `📦 Update available on <upstream>: <local> → <remote>` plus the commit count and the command to run.
- **Read the structured form.** Run `node dashboard.mjs --update-status-json`. It prints one JSON object with `isGit`, `hasUpdate`, `localSha`, `remoteSha`, `behind`, `ahead`, `upstream`, `tracks`, `fetchFailed`, `versionLabel`, `checkedAt`, and exits `0`. `"fetchFailed":false` distinguishes "checked and current" from "could not check".
- **Report on another checkout.** Run `node dashboard.mjs --update-status-json /path/to/other/checkout`. The JSON describes that directory instead of the script's own.
- **The endpoint agrees.** Run `curl -fsS "http://127.0.0.1:$PORT/api/update"`. It returns an object with a boolean `hasUpdate`.
- **Refuse a detached HEAD.** In a throwaway clone, detach and ask for an update. Set `PROBE="$(mktemp -d)/upd-probe"` and run `git clone -q "$PWD" "$PROBE" && git -C "$PROBE" checkout -q --detach && node "$PROBE/dashboard.mjs" --update`. It prints `❌ Update failed: the current checkout is not on a branch that tracks origin/main.` and a hint to switch to a tracking branch. `git -C "$PROBE" rev-parse HEAD` is unchanged and `git -C "$PROBE" status --porcelain` is empty — nothing was pulled. The temporary directory is disposable.
- **Proof.** Capture the banner state. Run `node .agents/skills/verify/scripts/browser.mjs aria --path .agents/skills/verify/artifacts/ui/update.aria.txt` and `.../browser.mjs screenshot --path .agents/skills/verify/artifacts/ui/update.png`. The artifacts show the banner text and the table behind it.

## Gotchas

- Export `PLATFORM_NTFY`-style state is not involved here, but the update probe spawns a child process with a 30 s timeout, so a cold `--check-update` can take seconds before it prints anything.
- **A refused or failed `--update` exits `0`** while printing `❌ Update failed`. Do not use the exit code to detect update failure; read the output. The port-clash path does exit `1`. This inconsistency is recorded as a known issue rather than silently avoided.
- `--update` takes the target from the checkout's tracked branch, falling back to `origin/main`. Use `--update-status-json <dir>` for a read-only look at another checkout; do not use `--update` for that.
- `--update` fast-forwards the real checkout and restarts the installed service when HEAD moved. Run it only in a checkout this run owns, and expect a service restart as a side effect.
- A failed probe must not erase the last known status. The banner keeps the older result and marks it stale — that is the whole point of the stale path; assert the marker rather than the absence of a banner.
- `versionLabel` is `null` when the manifest version did not change. Assert the field, not a formatted delta.
