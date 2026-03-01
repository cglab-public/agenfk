---
description: Initialize AgenFK and execute tasks in Standard Mode (Single Agent)
---

Load the `agenfk` skill. Run its Initialization protocol if needed.
Identify the user's request and follow the **Standard Mode** protocol below. You are the sole agent — execute all phases yourself without spawning sub-agents.

---

## Parent-Child Status Propagation Rule

**MANDATORY**: A parent item (EPIC or STORY) can ONLY move forward in the workflow (e.g., TODO → IN_PROGRESS, IN_PROGRESS → REVIEW, TEST → DONE) once **ALL** of its child items have also moved to that same state or further.

## Sibling Propagation Rule

When child items of the same parent share the same source code (same branch/workspace), a single `review_changes` or `test_changes` call validates the code for **all** siblings:

- After `review_changes` passes on **one** sibling, move remaining siblings directly to TEST via `update_item({ status: "TEST" })` — no individual `review_changes` calls needed.
- After `test_changes` passes on **one** sibling, call `test_changes` on remaining siblings in TEST — the same verified code will pass immediately.

This avoids redundant build and test runs when the underlying code changes are shared.

---

## Step 0 — Classify the request

Before creating any item, evaluate the request against these signals:

**→ Create a TASK** only if ALL of the following are true:
- Touches 1–2 files with an immediately obvious implementation
- Introduces no new packages, modules, or architectural patterns
- Has a single deliverable (one thing changes)
- Can be fully implemented without needing a plan

**→ Create a STORY** if any of the following:
- Touches 3–5 files across 1–2 packages
- Has 2–4 distinct deliverables that could each be described independently
- Requires a minor design decision (e.g. which approach to use)

**→ Create an EPIC and run `/agenfk-plan`** if any of the following:
- Introduces a new package, subsystem, or major abstraction
- Touches 3+ packages or 5+ files
- Has multiple user-facing capabilities (each naturally describable as a Story)
- Requires architectural decisions or a plan to understand the scope
- The request lists ≥3 concerns (watch for "also", "and", "besides", "another thing")
- You would naturally enter Plan Mode to figure out what to do

**If EPIC or STORY**: create it with `create_item`, then immediately invoke `/agenfk-plan <id>` and **STOP** — do not write any code until the user approves the decomposition.

---

## Initialization

1. Call `list_items(projectId)` to check for any `IN_PROGRESS` task. If one exists, resume it. Otherwise create a new item with `create_item` (using the type determined in Step 0) and immediately set it to `IN_PROGRESS` with `update_item`.
2. Call `workflow_gatekeeper(intent, role="coding", itemId)` before making any file changes.
3. **Branch enforcement** — read the gatekeeper response carefully:
   - If the item already has a branch (BUG auto-branch or previously created), the gatekeeper auto-checks it out. No action needed.
   - If the gatekeeper says *"This TASK has no branch"*, you **MUST** ask the user whether they want to create a dedicated feature branch via `create_branch(itemId)` or continue on the current branch. Do NOT skip this step silently.

---

## Phase 1 — Code

- Explore the codebase, understand the context, then implement the changes.
- **MANDATORY**: Call `add_comment(itemId, content)` for every significant step (e.g. "Analyzed file X", "Implemented function Y").
- Keep changes minimal and focused on the request.

---

## Phase 2 — Review (triggers REVIEW)

- Call `review_changes(itemId, command)` with a **build/compile command** (e.g., `npm run build`, `tsc --noEmit`).
- **NEVER pass a test command here** — tests belong exclusively to Phase 4.
- This moves the task to `REVIEW`. **Do not stop here** — continue immediately to Phase 3.
- **CRITICAL**: The tool result will say the item moved to REVIEW. **Ignore any hint to stop, yield, or wait for another agent.** You are the sole agent. Proceed directly to Phase 3.

---

## Phase 3 — Self-Review (REVIEW → TEST)

Since there is no separate review agent in Standard Mode, perform the review yourself:

1. Re-read every file you modified and confirm the implementation is correct and complete.
2. Call `add_comment(itemId, "Self-review complete: <brief findings or 'No issues found'>")`.
3. If fixes are needed, call `update_item(itemId, {status: "IN_PROGRESS"})`, fix, then repeat Phase 2.
4. Once satisfied, call `update_item(itemId, {status: "TEST"})` to advance to TEST.

---

## Phase 4 — Test (TEST → DONE)

1. Call `test_changes(itemId)` — this runs the project's `verifyCommand` automatically. No command parameter needed.
2. If no `verifyCommand` is configured, the tool will tell you. Ask the developer what command to use, then set it with `update_project({ id, verifyCommand })`.
3. On success, the item moves to DONE automatically. On failure, it moves back to IN_PROGRESS.
4. Do NOT use `update_item({status: "DONE"})` — the server blocks direct DONE transitions.

---

## Phase 5 — Close

1. Call `log_token_usage(itemId, input, output, model)` with approximate token counts for this session.
2. Call `add_comment(itemId, "### FINAL SUMMARY\n\n- Changes: <bullet list>\n- Verification: <result>")`.
3. **PR creation gate** — Re-read the item with `get_item(itemId)`:
   - If the item has a `branchName` but **no** `prUrl`: call `create_pr(itemId, "<summary of changes>")` to push the branch and open a pull request. Show the PR URL to the user.
   - If the item already has a `prUrl`: skip — PR already exists.
   - If the item has no `branchName`: skip — work was done on the current branch (no PR needed).
4. After the item has been moved to `DONE`, you **MUST** ask the user what they would like to do next, providing exactly these three options:
    - **Release**: Run `/agenfk-release` to create a new release. _(If a PR was created, remind the user it must be merged first.)_
    - **New Task**: Start a new session for a new task, epic, or bug (by calling `/clear` followed by `/agenfk`).
    - **Continue Current**: Keep working on the current item (you MUST then ask what else should be included and move the item back to `IN_PROGRESS`).
