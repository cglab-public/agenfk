---
description: Upgrade AgenFK to the latest version
---

You are executing the `/agenfk-upgrade` command. This command is **exempt from AgenFK workflow requirements** — do not create, check for, or require an IN_PROGRESS task. Follow these steps precisely:

**Step 1 — Check installation**

Run `agenfk --version` and show the current version to the user.

If the command fails or `~/.agenfk-system` does not exist, inform the user that AgenFK does not appear to be installed and stop.

**Step 2 — Pull latest changes**

Run:
```bash
git -C ~/.agenfk-system pull origin main
```

Show the output. If the pull fails (e.g. merge conflict, detached HEAD), show the error and ask the user whether to continue anyway.

If the output says `Already up to date.`, inform the user and ask if they still want to re-run the install script to refresh hooks and commands. If they say no, stop.

**Step 3 — Re-run install script**

Run:
```bash
node ~/.agenfk-system/scripts/install.mjs
```

Show the full output. The install script will rebuild the project and update hooks, CLI binaries, MCP config, and slash commands.

**Step 4 — Verify**

Run `agenfk --version` again and show the new version. Confirm that the upgrade completed successfully.

Remind the user to restart their AI editor (Opencode, Cursor, Claude Code) so the updated MCP server and slash commands take effect.
