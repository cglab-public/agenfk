---
description: Resume work on a paused task with full context restoration
---

You are executing the `/agenfk-resume [id]` command. Follow these steps precisely.

> All workflow operations use the `agenfk` CLI (CLI-only is the default). If
> `mcp__agenfk__*` tools are present (installed with `--with-mcp`), the equivalent
> MCP tool shown in parentheses is interchangeable.

**Step 1 — Identify the item to resume**
- If an `<id>` argument was provided, use it directly.
- Otherwise, run `agenfk list --status PAUSED --json` to find paused items (MCP: `list_items`).
- If multiple paused items exist, present the list and ask the user which one to resume.
- If no paused items exist, inform the user: "No paused items found in this project."

**Step 2 — Restore context**
- Run `agenfk resume-work <id>` (MCP: `resume_work`). This will:
  - Retrieve the full pause snapshot (summary, files modified, resume instructions, git diff, branch)
  - Restore the item to its pre-pause status
  - Add a resume comment to the item
- The command returns all the context you need to continue working. (Use `agenfk get <id> --json` if you need to re-read the item afterwards.)

**Step 3 — Set up the workspace**
- If the snapshot includes a `branchName`, check out that branch:
  - Run `git branch --show-current` to see if you're already on it.
  - If not, run `git checkout <branchName>`.
- Review the list of previously modified files.
- Read the resume instructions carefully — they contain the next agent's action plan.

**Step 4 — Continue the workflow**
- Run `agenfk gatekeeper --intent "Resuming paused work" --item-id <id>` to authorize code changes (MCP: `workflow_gatekeeper`).
- Follow the resume instructions to pick up where the previous agent left off.
- Continue through the project's own flow, one step at a time: read the current step and its exit criteria with `agenfk gatekeeper --item-id <id>`, satisfy them, then advance with `agenfk verify <id> --evidence "<text>"`. Do not assume a fixed Code → Review → Test sequence — the flow defines the steps.

**Step 5 — Log progress**
- Run `agenfk comment <id> "Resumed work from pause snapshot. Starting with: <first action>"` to record the handoff (MCP: `add_comment`).


ARGUMENTS: $ARGUMENTS
