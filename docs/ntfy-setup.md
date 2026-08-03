# Setting up the ntfy backend

`agent-notify` can publish to any ntfy server. You can use the public ntfy.sh service or run your own.

## Quick config reference

```env
NTFY_URL=https://ntfy.sh
NTFY_TOPIC=agent-alerts
NTFY_API_KEY=tk_xxxxxxxxxxxxxxxx
```

| Variable | Purpose | Default |
|---|---|---|
| `NTFY_URL` | ntfy server URL | `http://localhost:10081` |
| `NTFY_TOPIC` | Topic name to publish to | `agent-alerts` |
| `NTFY_API_KEY` | Optional bearer token or `user:pass` | empty |

## Option A: ntfy.sh (managed)

1. Install the ntfy app on your phone or open the web UI.
2. Subscribe to the topic you configure in `.env`, for example `agent-alerts`.
3. If you want access control, sign up and generate an access token:
   - Open `https://ntfy.sh/account`.
   - Copy the token. It looks like `tk_xxxxxxxxxxxxxxxx`.
   - Set `NTFY_API_KEY=tk_xxxxxxxxxxxxxxxx`.

You can also leave `NTFY_API_KEY` empty and use a public topic. Anyone who knows the topic name can subscribe.

## Option B: Self-hosted ntfy

Run your own server with Docker:

```bash
docker run -it -d \
  --name ntfy \
  -p 10081:80 \
  -v "$(pwd)/ntfy-cache:/var/cache/ntfy" \
  binwiederhier/ntfy serve
```

Then set:

```env
NTFY_URL=http://localhost:10081
NTFY_TOPIC=agent-alerts
```

### Authentication on self-hosted ntfy

If you enable authentication, create a user and a token:

```bash
docker exec -it ntfy ntfy user add myuser
docker exec -it ntfy ntfy access myuser agent-alerts write
docker exec -it ntfy ntfy token add myuser
```

Copy the printed token into `.env`:

```env
NTFY_API_KEY=tk_xxxxxxxxxxxxxxxx
```

## Authentication formats

`agent-notify` accepts two formats for `NTFY_API_KEY`:

- **Bearer token** - paste the token directly:

  ```env
  NTFY_API_KEY=tk_xxxxxxxxxxxxxxxx
  ```

- **Basic auth** - use `user:pass` when you do not have a token:

  ```env
  NTFY_API_KEY=myuser:mypassword
  ```

## Verify it works

From the plugin directory, run the test command:

```bash
node herdr/herdr-adapter.mjs --test
```

Or trigger the Herdr test action:

```bash
herdr plugin action invoke test --plugin agent-notify
```

If `PLATFORM_NTFY=true`, you should see the notification on your subscribed device.
