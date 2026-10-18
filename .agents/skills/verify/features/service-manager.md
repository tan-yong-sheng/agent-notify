# Service management

The dashboard can install itself as a background service that starts on login, so the monitor is running before you open a browser. Each platform gets the native mechanism: `systemd --user` on Linux, `launchd` on macOS, and a Startup-folder launcher on Windows. The installer picks `bun` when it is available and falls back to `node`.

## Sub-features

- `service-install` writes the platform's unit / plist / launcher and starts it.
- `service-reinstall` replaces a running job with the rewritten definition.
- `service-status` reports whether the service is installed and running.
- `service-restart` restarts the running service.
- `service-logs` opens the platform's log view.
- `service-uninstall` stops and removes the definition.
- `service-port` installs the port the install reported, not a hardcoded default.
- `service-runtime` prefers `bun` and falls back to `node` for the daemon process.

## How to get to it (user POV)

- Run `node dashboard.mjs --service install`.
- Run `node dashboard.mjs --service status`.
- Run `node dashboard.mjs --service restart`.
- Run `node dashboard.mjs --service logs`.
- Run `node dashboard.mjs --service uninstall`.

## Driving it with the verify drivers

Preconditions:

- `--service status` is read-only and safe to run at any time. Everything else in this feature changes the user's machine and their login session: **get explicit approval before running install, restart, or uninstall, and uninstall afterwards.**
- There is no user `systemd` and no `launchd` in a sandboxed Linux container, so the real install paths cannot be driven here. What this environment can prove is the definition the installer writes and the status read-out.

- **Read the status.** Run `node dashboard.mjs --service status`. With nothing installed it prints `Unit agent-monitor.service could not be found.` followed by `Service agent-monitor is stopped or not installed.` and exits `0`. With the service installed it reports it as running.
- **Inspect the generated definition.** Run the builder tests. Run `node test_cases.test.js` and read the `buildSystemdUnit ...` and `buildLaunchdPlist ...` results. They assert the argv, the resolved port in `ExecStart` / `ProgramArguments`, the working directory, `$`-expansion and `%`-specifier escaping, and that a newline is refused instead of injecting a directive.
- **Install (needs approval).** Run `node dashboard.mjs --service install` on a machine you own. It writes `~/.config/systemd/user/agent-monitor.service` on Linux or `~/Library/LaunchAgents/dev.agent-notify.dashboard.plist` on macOS, starts the unit, and prints the URL with the port it actually bound: `Status: http://localhost:<port>`.
- **Prove the port travels.** Read the installed definition back. Run `cat ~/.config/systemd/user/agent-monitor.service` (Linux) or `cat ~/Library/LaunchAgents/dev.agent-notify.dashboard.plist` (macOS) and check that `--port <port>` matches the port `--service status` and the install report show.
- **Reinstall over a running job.** With the service running, change the port and install again. Run `node dashboard.mjs --service install --port 8081`. The old definition is unloaded before the new one loads, and `--service status` reports the new port; on macOS this is what the `launchd reinstall unloads the running job before loading the rewritten plist` test covers.
- **Uninstall.** Run `node dashboard.mjs --service uninstall`. The unit/plist is gone and `--service status` reports it as not installed.

## Gotchas

- Install, restart, and uninstall change the user's login session. Ask before running them; never run them as a side effect of another check.
- The install report must carry the resolved port. A hardcoded `3333` in the report while the unit bound another port is a defect, and there is a mutation for it.
- `--service logs` on Linux shells out to `journalctl --user`, which needs a live user systemd. On macOS it writes to `~/Library/Logs/agent-monitor`. A failure here is an environment gap, not a product failure.
- The Windows path writes a `.vbs` launcher into the user's Startup folder. A quote or newline in the path must be refused rather than silently breaking the launcher; only the builder is testable off Windows.
- Reinstalling without unloading the previous job leaves two definitions and can bind two ports. Assert the unload step, not only the written file.
