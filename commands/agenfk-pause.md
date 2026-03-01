---
description: Pause work on the current task, saving full context for later resumption
---

You are executing the `/agenfk-pause [id]` command. Follow these steps precisely:

**Step 1 — Identify the item to pause**
- If an `<id>` argument was provided, use it directly.
- Otherwise, call `list_items(projectId, status="IN_PROGRESS")` to find the active task.
- If multiple items are IN_PROGRESS, ask the user which one to pause.
- If no items are IN_PROGRESS, check for items in REVIEW or TEST status.
- Confirm the item ID and title before proceeding.

**Step 2 — Gather context**
- Read the item details with `get_item(id)` to get the current status, comments, and implementation plan.
- Run `git diff --name-only` (via Bash) to get the list of modified files.
- Run `git branch --show-current` (via Bash) to capture the current branch.
- Run `git diff --stat` (via Bash) to get a condensed summary of changes.
- Review the item's comments to understand what has been accomplished so far.

**Step 3 — Write the pause context**
- Write a concise **summary** (3-5 sentences) covering:
  - What work has been completed
  - What work remains
  - Any blockers or decisions that need to be made
- Write **resume instructions** — a step-by-step guide for the next agent:
  1. Which files to read first
  2. What the next implementation step is
  3. Any important context about the approach taken
  4. Any dependencies or sequencing requirements

**Step 4 — Pause the item**
- Call `pause_work(itemId, summary, filesModified, resumeInstructions, gitDiff)` MCP tool with all the gathered context.
- The tool will:
  - Save a snapshot of the context
  - Set the item status to PAUSED
  - Add a comment to the item

**Step 5 — Confirm**
- Tell the user: "Work on [item title] has been paused. Use `/agenfk-resume <id>` in a new session to pick up where you left off."
- Show the item ID for easy reference.


ARGUMENTS: $ARGUMENTS
