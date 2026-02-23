---
description: Initialize AgenFK and execute tasks in Standard Mode (Single Agent)
---

Load the `agenfk` skill. Run its Initialization protocol if needed.
Identify the user's request and follow the **Standard Mode** protocol below. You are the sole agent — execute all phases yourself without spawning sub-agents.

---

## Initialization

1. Call `list_items(projectId)` to check for any `IN_PROGRESS` task. If one exists, resume it. Otherwise create a new item with `create_item` and immediately set it to `IN_PROGRESS` with `update_item`.
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
