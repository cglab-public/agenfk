---
description: Upgrade AgenFK to the latest version
---

You are executing the `/agenfk-upgrade` command. This command is **exempt from AgenFK workflow requirements** — do not create, check for, or require an IN_PROGRESS task. Follow these steps precisely:

**Step 1 — Check installation**

Run `agenfk --version` and show the current version to the user.

If the command fails or `~/.agenfk-system` does not exist, inform the user that AgenFK does not appear to be installed and stop.

**Step 2 — Run upgrade**

Run:
```bash
agenfk upgrade --force
```

The CLI handles everything automatically:
- Downloads pre-built binaries from the latest GitHub release
- Stops the running server before installing
- Runs the install script to refresh hooks, MCP config, and slash commands
- Starts the server again with the new version

Show the full output. If the upgrade fails (e.g. network error, binary not available), report the error and stop.

**Step 3 — Verify**

Run `agenfk --version` again and show the new version. Confirm the upgrade completed successfully.

Remind the user to restart their AI editor (Opencode, Cursor, Claude Code) so the updated MCP server and slash commands take effect.
