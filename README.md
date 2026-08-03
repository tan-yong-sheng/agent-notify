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

After installing the plugin, copy `.env.example` into the plugin install directory next to `main.mjs`.
On most systems that is:

```bash
CONFIG_DIR="$HOME/.config/orca/plugins/agent-notify.agent-notify/dev"
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
   - Orca: the plugin install directory next to `main.mjs`
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

## Test

```bash
node test_cases.test.js
```

## How It Works

Orca reports `done`, `blocked`, `working`, and `waiting`. The Orca plugin fires only on `done` and `blocked`.

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
