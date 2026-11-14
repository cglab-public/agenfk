---
description: Upgrade AgenFK to the latest version
---

You are executing the `/agenfk-upgrade` command. This command is **exempt from AgenFK workflow requirements** — do not create, check for, or require an IN_PROGRESS task. Follow these steps precisely:

**Step 1 — Check installation**

Run `agenfk --version` and show the current version to the user.

If the command fails or `~/.agenfk-system` does not exist, inform the user that AgenFK does not appear to be installed and stop.

**Step 2 — Run upgrade**

Pick the channel from the version Step 1 printed. A version with a prerelease
part (`2.0.0-beta.23`) is on the beta line; anything else is on stable.

```bash
agenfk upgrade          # stable
agenfk upgrade --beta   # when the current version has a prerelease part
```

Do not add `--force`: it reinstalls the same version and nothing more. If the
CLI answers that the installed version is newer than the latest release and it
is not downgrading, that is the result — show it and stop; never pass
`--version` to go backwards unless the user asked for that version.

The CLI handles everything automatically:
- Downloads pre-built binaries from the latest GitHub release
- Stops the running server before installing
- Runs the install script to refresh hooks, MCP config, and slash commands
- Starts the server again with the new version

Show the full output. If the upgrade fails (e.g. network error, binary not available), report the error and stop.

**Step 3 — Verify**

Run `agenfk --version` again and show the new version. Confirm the upgrade completed successfully.

Remind the user to restart their AI editor (Opencode, Cursor, Claude Code) so the updated MCP server and slash commands take effect.
