---
description: Initialize AgenFK and execute tasks in Standard Mode (Single Agent)
---

Load the `agenfk` skill. Run its Initialization protocol if needed.
Identify the user's request and follow the **Standard Mode** protocol below. You are the sole agent — execute all phases yourself without spawning sub-agents.

---

## Parent-Child Status Propagation Rule

**MANDATORY**: A parent item (EPIC or STORY) can ONLY move forward in the workflow (e.g., TODO → IN_PROGRESS, IN_PROGRESS → REVIEW, TEST → DONE) once **ALL** of its child items have also moved to that same state or further.

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

**If EPIC**: create it with `create_item`, then immediately invoke `/agenfk-plan <id>` and **STOP** — do not write any code until the user approves the decomposition.

---

## Initialization

1. Call `list_items(projectId)` to check for any `IN_PROGRESS` task. If one exists, resume it. Otherwise create a new item with `create_item` (using the type determined in Step 0) and immediately set it to `IN_PROGRESS` with `update_item`.
2. Call `workflow_gatekeeper(intent, role="coding", itemId)` before making any file changes.

---

## Phase 1 — Code

- Explore the codebase, understand the context, then implement the changes.
- **MANDATORY**: Call `add_comment(itemId, content)` for every significant step (e.g. "Analyzed file X", "Implemented function Y").
- Keep changes minimal and focused on the request.

---

## Phase 2 — Verify (triggers REVIEW)

- Call `verify_changes(itemId, command)` with a suitable check command (build, typecheck, lint, etc.).
- This always moves the task to `REVIEW`. **Do not stop here** — continue immediately to Phase 3.

---

## Phase 3 — Self-Review (REVIEW → TEST)

Since there is no separate review agent in Standard Mode, perform the review yourself:

1. Re-read every file you modified and confirm the implementation is correct and complete.
2. Call `add_comment(itemId, "Self-review complete: <brief findings or 'No issues found'>")`.
3. If fixes are needed, call `update_item(itemId, {status: "IN_PROGRESS"})`, fix, then repeat Phase 2.
4. Once satisfied, call `update_item(itemId, {status: "TEST"})` to advance to TEST.

---

## Phase 4 — Test (TEST → DONE)

1. Identify the appropriate test command for the project stack (check `CLAUDE.md`, `package.json`, `pyproject.toml`, `Makefile`, etc.).
2. Run the test suite. Call `add_comment(itemId, "Tests passed: <summary>")`.
3. Call `update_item(itemId, {status: "DONE"})` — this is only permitted from TEST status.

---

## Phase 5 — Close

1. Call `log_token_usage(itemId, input, output, model)` with approximate token counts for this session.
2. Call `add_comment(itemId, "### FINAL SUMMARY\n\n- Changes: <bullet list>\n- Verification: <result>")`.
3. Confirm with the user that the task is complete.
