# Agent Notify

> Stop babysitting your AI agents.
> Let them text you when they need help or finish the job - whether they're
> running in **Herdr**, **Orca**, or any other agent terminal.

A lightweight, zero-dependency notification plugin that alerts you when agents
finish or need help. It can send to [ntfy.sh](https://ntfy.sh) or to your
OS/desktop notification center.

---

## Architecture

```
agent-notify/
├── shared/
│   ├── ntfy.mjs          # Barrel export for the shared core
│   ├── env.mjs           # .env parser
│   ├── config.mjs        # Config resolution
│   ├── auth.mjs          # ntfy auth headers
│   ├── tags.mjs          # Tag / emoji mapping
│   ├── publish.mjs       # URL probe + publish (curl / fetch)
│   ├── format.mjs        # Notification body formatters
│   ├── desktop.mjs       # Desktop/terminal popout notifications
│   ├── notify.mjs        # Notification dispatcher
│   └── git.mjs           # Best-effort git branch detection
├── herdr/
│   ├── herdr-adapter.mjs # Herdr plugin entry point
│   └── utils.mjs         # Event / context parsing helpers
├── main.mjs              # Orca plugin entry point
├── orca-plugin.json      # Orca plugin manifest
├── herdr-plugin.toml     # Herdr plugin manifest
├── .env.example          # Shared configuration template
├── test_cases.test.js    # Unit + integration tests
└── README.md
```

## Quick Start

### 1. Configure

```bash
cp .env.example .env
```

Edit `.env` to choose your notification channels and set the required values.

**Default — desktop/terminal popups (no setup needed):**

```env
PLATFORM_DESKTOP=true
PLATFORM_NTFY=false
```

**For ntfy.sh:**

```env
PLATFORM_DESKTOP=false
PLATFORM_NTFY=true
NTFY_URL=https://ntfy.sh
NTFY_TOPIC=agent-alerts
NTFY_API_KEY=tk_xxxxxxxxxxxxxxxx
```

`NTFY_API_KEY` is optional. Use a bearer token, or `user:pass` for Basic auth.

**For both desktop and ntfy at the same time:**

```env
PLATFORM_DESKTOP=true
PLATFORM_NTFY=true
NTFY_URL=https://ntfy.sh
NTFY_TOPIC=agent-alerts
NTFY_API_KEY=tk_xxxxxxxxxxxxxxxx
```

| Variable | Purpose | Default |
|---|---|---|
| `PLATFORM_DESKTOP` | Enable desktop/terminal notifications | `true` |
| `PLATFORM_NTFY` | Enable ntfy notifications | `false` |
| `NTFY_URL` | ntfy server URL | `http://localhost:10081` |
| `NTFY_TOPIC` | Topic name to publish to | `agent-alerts` |
| `NTFY_API_KEY` | Optional bearer token or `user:pass` | empty |

### Setting up the ntfy backend

See [docs/ntfy-setup.md](docs/ntfy-setup.md) for a complete guide to ntfy.sh and self-hosted ntfy, including how to generate `NTFY_API_KEY`.

### Where to put the `.env` file

**Orca**

After installing the plugin, put `.env` in Orca's durable plugin config directory (`dev/`).
Do not put it only next to the hashed package copy of `main.mjs` - that directory is replaced on every install/update.
If a reinstall leaves `dev/.env` empty, re-copy your config there.
On most systems:

```bash
CONFIG_DIR="$HOME/.config/orca/plugins/agent-notify.agent-notify/dev"
mkdir -p "$CONFIG_DIR"
cp .env.example "$CONFIG_DIR/.env"
```

**Herdr**

Use Herdr's plugin config-dir command to get the managed config path, then copy the `.env` there:

```bash
CONFIG_DIR="$(herdr plugin config-dir agent-notify)"
cp .env.example "$CONFIG_DIR/.env"
```

You can also hard-link the same `.env` to both locations if you want identical settings.

### Configuration resolution order

Config is read from (highest priority first):

1. Actual environment variables
2. Platform-specific `.env`:
   - Orca: first existing file among package root, `../dev/.env`, then plugin home
   - Herdr: `HERDR_PLUGIN_CONFIG_DIR/.env`
3. Built-in defaults

So you can keep shared defaults in `.env` and override per platform with env vars.

### 2. Install for Orca

1. Open Orca.
2. Go to **Settings → Plugins**.
3. Click **Install plugin**.
4. Input the GitHub URL: `https://github.com/tan-yong-sheng/agent-notify#main`.
5. Review the permissions and enable the plugin.

The plugin subscribes to `agent.status.changed` events for all agents.

To update after changing the plugin, remove it in Settings → Plugins and reinstall from the same URL.

### 3. Install for Herdr

#### From GitHub

```bash
herdr plugin install tan-yong-sheng/agent-notify
```

#### Local development

1. Link the local plugin folder:

```bash
herdr plugin link /path/to/agent-notify
```

2. Copy the config to Herdr's managed config directory:

```bash
CONFIG_DIR="$(herdr plugin config-dir agent-notify)"
cp /path/to/agent-notify/.env "$CONFIG_DIR/.env"
```

3. Send a test notification:

```bash
herdr plugin action invoke test --plugin agent-notify
```

## Agent Monitor Dashboard

A lightweight, zero-dependency local web dashboard to monitor which coding agents (Pi, Claude, Codex, etc.) are currently running, waiting for input, or finished across both **Orca** worktrees and **Herdr** sessions in one place.

### Launch the Dashboard

```bash
node dashboard.mjs
# Or start with bun for lower memory usage:
bun dashboard.mjs
# Or specify a custom port:
node dashboard.mjs --port 8080
```

Then visit [http://localhost:3333](http://localhost:3333).

- **Real-time status**: Polls live agent state across Orca and Herdr every 3 seconds without UI flicker.
- **Low Memory / Multi-Runtime**: Runs on standard Node.js or opportunistically under Bun (~35 MB RSS vs ~57 MB RSS).
- **Compact dense table**: Clean layout showing status badges (🟢 Working, 🔴 Blocked, ⚪ Done / Idle), host environment (`Orca` / `Herdr`), agent type (`pi`), workspace directory, git branch, and active tool / prompt.
- **Search & Filter**: Real-time filter box and quick tabs (`All`, `Working`, `Blocked`, `Settled`).
- **Click-to-copy & Inspect**: Click any directory path to copy it to your clipboard, or click a prompt to expand its full text.
- **Configurable**: Set `DASHBOARD_PORT=3333` in `.env` or pass `--port <number>`.

### Background Service Management

You can install the dashboard as a persistent background daemon that starts on login:
- **Linux**: Managed via `systemd --user` (`~/.config/systemd/user/agent-monitor.service`)
- **macOS**: Managed via `launchd` (`~/Library/LaunchAgents/dev.agent-notify.dashboard.plist`)
- **Windows**: Managed via user Startup folder shortcut
- **Opportunistic Bun**: Automatically selects `bun` if installed on your system to minimize daemon background RAM usage (~35 MB), falling back to `node`.

```bash
# Install and start service on login
node dashboard.mjs --service install

# Check service status
node dashboard.mjs --service status

# Restart service
node dashboard.mjs --service restart

# View logs (Linux journalctl or macOS stdout log)
node dashboard.mjs --service logs

# Stop and uninstall service
node dashboard.mjs --service uninstall
```

### Updates

The dashboard checks the branch your checkout actually tracks (falling back to `origin/main` for read-only checks) and shows a banner only when you are genuinely *behind*, with the manifest version delta when it changed (e.g. `orca 1.1.0 → 1.2.0`). You can also check and update from the terminal:

```bash
# Check if updates are available
node dashboard.mjs --check-update

# Fast-forward the tracked upstream; restarts the service only if HEAD moved
node dashboard.mjs --update
```

`--update` requires the current checkout to be on a branch that tracks the update target. It refuses to act on a detached HEAD or a differently-branched checkout instead of reporting a success that never happened, and prints `nothing changed` rather than claiming an update when the pull is a no-op.

## Test

```bash
node test_cases.test.js
```

## How It Works

Orca reports `done`, `blocked`, `working`, and `waiting`. The Orca plugin
notifies on the **main agent's own state** (`mainAgent` in the event payload,
falling back to the combined `state` when the host omits it) - never on a
headless subagent process (`claude -p`, `pi -p`, `codex exec`, ...) on its
own: subagent activity is folded into the pane's combined status and a
per-pane settle de-dupe prevents a subagent finishing from re-announcing an
already-notified main-agent settle. So you get one notification when the main
agent settles (`done`) or needs input (`blocked`), regardless of subagents
still running underneath.

The Herdr adapter translates platform-specific statuses into a common vocabulary. Herdr's Pi integration emits `idle` when the agent settles; the adapter maps that to `done` before deciding whether to notify. So both platforms notify on completion (`done`/`idle`) and when input is needed (`blocked`).

- **Herdr**: `herdr-plugin.toml` registers `on = "pane.agent_status_changed"` →
  calls `herdr/herdr-adapter.mjs`. Desktop mode uses terminal escape
  sequences (OSC 99 / OSC 777) and falls back to OS-native notifications.
- **Orca**: `orca-plugin.json` declares `events: [{ "on": "agent.status.changed" }]` →
  `main.mjs` subscribes via `orca.events.on(...)`. Desktop mode uses
  `orca.host.call('notifications.show', ...)`.

## Troubleshooting

### Test works but real agent events don't

1. Check the plugin log in the Herdr config directory:

```bash
cat "$(herdr plugin config-dir agent-notify)/agent-notify.log"
```

Look for `dispatched` or `skipped` lines. If the status is something other than `done`, `blocked`, or `idle` (Herdr), the adapter may need a new translation.

2. Make sure Herdr is using the current plugin id. If you previously linked it as `local.agent-ntfy-notify`, relink:

```bash
herdr plugin unlink local.agent-ntfy-notify
herdr plugin link /path/to/agent-notify
```

Then use `agent-notify` in commands:

```bash
herdr plugin action invoke test --plugin agent-notify
```

3. Verify the config file is in the right place:

```bash
herdr plugin config-dir agent-notify
# should contain .env with PLATFORM_DESKTOP=true
```

## License

MIT License. See [LICENSE](LICENSE) for details.
