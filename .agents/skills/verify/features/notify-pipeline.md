# Notifications

When an agent settles or needs input, the plugin sends you a notification — a desktop popup or a message to ntfy — so you can stop babysitting the terminal. Orca reports `done`, `blocked`, `working`, and `waiting`; Herdr reports its own vocabulary and the adapter translates it. You are notified once per settle, on the main agent's own state, with context about where the agent is working.

## Sub-features

- `notify-done` notifies when an agent settles.
- `notify-blocked` notifies when an agent needs input.
- `notify-skip` stays quiet for `working`, `waiting`, and unrelated statuses.
- `notify-main-agent` notifies on the main agent's state, not on a headless subagent settling underneath.
- `notify-dedupe` does not re-announce a pane that was already announced for this settle.
- `notify-desktop` delivers through the desktop/terminal channel.
- `notify-ntfy` publishes to the configured ntfy server.
- `notify-test` sends a test notification through the plugin action.

## How to get to it (user POV)

- Let an agent finish or ask a question in Orca or Herdr and wait for the notification.
- Run `herdr plugin action invoke test --plugin agent-notify`.
- Configure the channels in `.env` (`PLATFORM_DESKTOP`, `PLATFORM_NTFY`, `NTFY_URL`, `NTFY_TOPIC`, `NTFY_API_KEY`).

## Driving it with test_cases.test.js and the Herdr CLI

Preconditions:

- A real Orca or Herdr host is not available in this environment, and a live ntfy publish needs a reachable server. Those paths are unit-driven here and reported as gaps.
- Config resolution differs per host: Orca reads `../dev/.env` under its plugin directory, Herdr reads `HERDR_PLUGIN_CONFIG_DIR/.env`, and real environment variables win over both.

- **Dispatch by channel.** Run `node test_cases.test.js` and read the `dispatchNotification ...` results. They assert which channel is called for each configuration, that a failing ntfy publish does not suppress the desktop one, and that the body and title reach the channel unchanged.
- **Status vocabulary.** Run the same suite and read `normalizeAgentStatus ...` and the `Herdr: ...` integration cases. They drive the real adapter with recorded event payloads: `Herdr: Agent Done (Standard)` and `Herdr: Agent Blocked (Question / Prompt)` must notify, and `Herdr: Agent working (should skip)` must not.
- **Subagent settles stay quiet.** Run the suite and read the settle-de-dupe results. A subagent finishing while the main agent is still working must not produce a second notification, and the same pane must not be announced twice for one settle.
- **Test action (needs a host).** Run `herdr plugin action invoke test --plugin agent-notify`. A notification arrives on every enabled channel. This sends a real notification: it can pop a desktop toast and publish to your topic.
- **Confirm what was sent.** Read the plugin log. Run `cat "$(herdr plugin config-dir agent-notify)/agent-notify.log"` and look for `dispatched` or `skipped` lines, one per event, naming the status that decided it.

## Gotchas

- A test invocation is a real send. It can publish to your ntfy topic, so run it deliberately and expect the message.
- Herdr's Pi integration emits `idle` when the agent settles; the adapter maps it to `done`. Asserting on the raw Herdr status gives the wrong expectation.
- Subagent activity is folded into the pane's combined status. Observing a notification for a `claude -p` / `pi -p` / `codex exec` child is not expected behavior — report it if you see it, because the de-dupe fix exists exactly for that.
- An `.env` next to the installed package copy is replaced on every plugin install. If a change appears to have no effect, check the durable plugin config directory first.
- The desktop channel's result and the ntfy result are independent. A green desktop toast says nothing about the ntfy publish.
