# Agent state adapters

The adapters turn what each host actually reports into the one list the dashboard shows and the one vocabulary the notifier speaks. They are why a Herdr session and an Orca worktree appear side by side with the same status words, why every row has a stable identity, and why a row can show which git branch an agent is on even though neither host reports branches directly.

## Sub-features

- `adapter-status` maps each host's status vocabulary onto the dashboard's `working` / `blocked` / `idle` buckets and the notification path's `done`.
- `adapter-orca` reads Orca worktree and agent payloads into rows.
- `adapter-herdr` reads Herdr pane payloads into rows, including a null element.
- `adapter-identity` gives every row a unique id, with a positional fallback when the host omits one.
- `adapter-context` resolves the workspace directory for a pane, including Herdr's `focused_pane_cwd`, `pane_id`, and `tab_label` variants.
- `adapter-branch` reports the git branch for a row's directory.
- `adapter-health` reports per-host availability so the page can say a source is down.

## How to get to it (user POV)

- Open the dashboard and read the host tag, workspace, and branch columns.
- Read the source health line at the top of the page when a host is unavailable.
- Receive a notification whose body names the workspace and branch.

## Driving it with test_cases.test.js and browser.mjs

Preconditions:

- The adapters run against recorded payloads in the suite; a live Orca or Herdr host is not available here.
- `scripts/drive-ui.mjs` exercises the rendering of adapter output, not the adapters: the stub provides agent rows directly.
- The two journeys that read the page need a running stub and browser session of their own (`serve-stub.mjs --port 4742 &`, then `browser.mjs launch` and `browser.mjs open http://127.0.0.1:4742/`); `drive-ui.mjs` starts and stops its own.

- **Status mapping.** Run `node test_cases.test.js` and read `normalizeAgentStatus ...` and `translateStatus ...`. The two paths differ. The dashboard's `normalizeAgentStatus` (`shared/catalog.mjs`) yields `working`, `blocked`, or `idle`, and an unknown status falls back to `idle` rather than passing through as a notify state. The notification path's `translateStatus` (`herdr/herdr-adapter.mjs`) is what turns Herdr's settled `idle` into `done`, which is why a settled pane can still notify. Do not "fix" `normalizeAgentStatus` to return `done` for `idle`: that would move every settled agent out of the page's settled bucket.
- **Row extraction.** Run the same suite and read `parseHerdrAgent ...`, `parseOrcaAgent ...`, and `collectLiveState ...`. They cover a null element in the Herdr array, a coerced bad status, an id that collides with a generated fallback (`pane-<index>`), and Orca rows without a `paneKey`.
- **Pane context.** Run the same suite and read `extractWorkspaceContext ...` and `findPaneCwd ...`. A `focused_pane_cwd` only applies when the event's own `pane_id` matches the focused pane; otherwise the snapshot lookup supplies the directory. `foreground_cwd` is the fallback.
- **Branch resolution.** Run the same suite and read `resolveBranch ...` and `detectGitBranch ...`. A probe that rejects or throws synchronously is reported as an empty branch and not cached; a probe that recovers reports the branch again on the next call.
- **Bounded probing.** Run the same suite and read `mapWithConcurrency caps probes in flight`. Branch probes are capped, so a large fleet does not spawn one git process per row at once.
- **Host health reaches the page.** With the preconditions' stub running, read `#sources-status` in the browser session. It names both `Orca` and `Herdr`. Point the stub at the `empty` fixture (`curl -fsS "http://127.0.0.1:4742/control/fixture?name=empty"`) and both report unavailable — `Orca ✕ Herdr ✕`, dimmed rather than hidden — with the table showing its empty state.
- **Proof.** Capture the row context. Run `node .agents/skills/verify/scripts/browser.mjs aria --path .agents/skills/verify/artifacts/ui/adapters.aria.txt`. The tree shows the host tag and branch for each row, and `—` where the fixture row has no branch.

## Gotchas

- Herdr reports `idle` for a settled agent. Comparing against `done` before the adapter maps it reads as a missing notification.
- The Herdr payload is a sparse array: a `null` element must still produce a row with a stable id, so a row count based on array length can disagree with the rendered row count.
- Row ids must be unique across both hosts. Two rows with the same id make the table's keyed update and the click-to-inspect handle ambiguous.
- A branch probe runs `git` per unique directory. It is capped and cached by directory, so a slow first paint that improves on the next poll is expected behavior, not a bug.
- A directory that is not a git checkout reports an empty branch, which the page renders as `—`. That is not a probe failure.
- The adapter accepts the callback events it is given. Requiring the current host's exact payload shape means a payload a newer host version adds fails here first — that is the intended tripwire, so keep the recorded payloads realistic.
