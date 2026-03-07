---
description: Resume work on a paused task with full context restoration
---

You are executing the `/agenfk-resume [id]` command. Follow these steps precisely:

**Step 1 — Identify the item to resume**
- If an `<id>` argument was provided, use it directly.
- Otherwise, call `list_items(projectId, status="PAUSED")` to find paused items.
- If multiple paused items exist, present the list and ask the user which one to resume.
- If no paused items exist, inform the user: "No paused items found in this project."

**Step 2 — Restore context**
- Call `resume_work(itemId)` MCP tool. This will:
  - Retrieve the full pause snapshot (summary, files modified, resume instructions, git diff, branch)
  - Restore the item to its pre-pause status
  - Add a resume comment to the item
- The tool returns all the context you need to continue working.

**Step 3 — Set up the workspace**
- If the snapshot includes a `branchName`, check out that branch:
  - Run `git branch --show-current` to see if you're already on it.
  - If not, run `git checkout <branchName>`.
- Review the list of previously modified files.
- Read the resume instructions carefully — they contain the next agent's action plan.

**Step 4 — Continue the workflow**
- Call `workflow_gatekeeper(intent="Resuming paused work", itemId=<id>)` to authorize code changes.
- Follow the resume instructions to pick up where the previous agent left off.
- Continue through the standard AgenFK workflow phases (Code → Review → Test → Done).

**Step 5 — Log progress**
- Call `add_comment(itemId, "Resumed work from pause snapshot. Starting with: <first action>")` to record the handoff.


ARGUMENTS: $ARGUMENTS
