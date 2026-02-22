---
description: Generate tests and verify coverage requirements
---

You are executing the `/agenfk-test <id>` command as a **Testing Agent**. Follow these steps precisely:

**Step 1 — Identify Test Surface**
- Read the item details using `get_item(id)`.
- Use `git diff` or compare against the parent branch to see the files modified.
- Locate the corresponding test files (e.g., `*.test.ts`, `test_*.py`).

**Step 2 — Generate Missing Tests**
- If new logic was added without tests, generate the necessary test cases using the project's testing framework.
- Ensure edge cases and error paths are covered.

**Step 3 — Execute & Verify Coverage**
- Run the project's test suite with coverage reporting (e.g., `npm run test:coverage`).
- Read the coverage report and identify any files modified in this task that fall below the **80% threshold**.
- If coverage is too low, add more tests until the threshold is met.

**Step 4 — Verify & Yield**
- If tests pass and coverage is met, use `verify_changes(id, "<test-command>")` to transition the task to REVIEW.
- DO NOT transition to DONE.
- STOP and YIELD immediately after verification. The supervisor will assign a closing agent to finalize the task.
- If failed, use `add_comment(id, "TESTS FAILED: ... [65% Coverage]")`, call `update_item(id, {status: "IN_PROGRESS"})`, and log the coverage gaps.
