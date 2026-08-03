---
name: agent-notify
description: >-
  Set up the agent-notify plugin for both Herdr and Orca.
  Use when configuring notifications for agent status changes
  ('done' and 'blocked'). Supports ntfy.sh, native desktop notifications,
  or both.
---

# Agent Notify Setup

Use this skill when setting up or debugging the `agent-notify` notification
plugin that alerts you when agents reach `done` or `blocked` status.

## Architecture

The plugin has a shared core used by both platforms:

```
agent-notify/
├── shared/
│   ├── ntfy.mjs          # Barrel re-export
│   ├── env.mjs           # .env parser
│   ├── config.mjs        # Config resolution
│   ├── auth.mjs          # ntfy auth headers
│   ├── tags.mjs          # Tag / emoji mapping
│   ├── publish.mjs       # URL probe + publish
│   ├── format.mjs        # Notification body formatters
│   ├── desktop.mjs       # Desktop/terminal popout notifications
│   ├── notify.mjs        # Notification dispatcher
│   └── git.mjs           # Best-effort git branch detection
├── main.mjs              # Orca plugin entry point
├── orca-plugin.json      # Orca plugin manifest
├── herdr/
│   ├── herdr-adapter.mjs # Herdr adapter
│   ├── utils.mjs         # Event / context parsing helpers
│   └── snapshot.mjs      # Herdr snapshot cwd lookup fallback
├── herdr-plugin.toml     # Herdr plugin manifest
├── .env.example          # Shared config
└── test_cases.test.js    # Unit + integration tests
```

## Setup

### 1. Configure the environment

Create a `.env` file:

```bash
cp .env.example .env
```

Edit `.env` to choose your notification channels:

```env
# Enable or disable each channel independently
PLATFORM_DESKTOP=true
PLATFORM_NTFY=true

# ntfy settings (only used when PLATFORM_NTFY=true)
NTFY_URL=https://ntfy.sh
NTFY_TOPIC=agent-alerts
NTFY_API_KEY=tk_xxxxxxxxxxxxxxxx
```

See `README.md` and `docs/ntfy-setup.md` for detailed ntfy backend setup instructions.

### 2. Install for Orca

1. In Orca, go to **Settings → Plugins**.
2. Click **Install plugin**.
3. Input the GitHub URL: `https://github.com/tan-yong-sheng/agent-notify`.
4. Enable the plugin in the plugin list.

### 3. Install for Herdr

#### From GitHub

```bash
herdr plugin install tan-yong-sheng/agent-notify
CONFIG_DIR="$(herdr plugin config-dir agent-notify)"
cp .env "$CONFIG_DIR/.env"
```

#### Local development

```bash
herdr plugin link /path/to/agent-notify
CONFIG_DIR="$(herdr plugin config-dir agent-notify)"
cp /path/to/agent-notify/.env "$CONFIG_DIR/.env"
```

## How It Works

Both platforms report agent lifecycle states. The plugin only fires on `done`
and `blocked` - not on `working` or `waiting`.

- **Herdr**: `herdr-plugin.toml` registers `on = "pane.agent_status_changed"`
  → calls `herdr/herdr-adapter.mjs`. Herdr's `idle` status is mapped to `done`.
- **Orca**: `orca-plugin.json` declares `events: [{ "on":
  "agent.status.changed" }]` → `main.mjs` subscribes via
  `orca.events.on(...)` → dispatches notifications.

The shared core is the only code that knows how to talk to ntfy or the desktop.
Both adapters (`herdr/herdr-adapter.mjs` and `main.mjs`) just read their event
source, extract status/identity/context, and call the shared dispatcher.

## Testing

```bash
node test_cases.test.js
```
