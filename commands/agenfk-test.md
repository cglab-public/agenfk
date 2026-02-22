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

**Step 4 — Log Test Results**
- Use `add_comment(id, "TESTS PASSED: ... [82% Coverage]")` or `add_comment(id, "TESTS FAILED: ... [65% Coverage]")`.
- If passed, call `update_item(id, {status: "DONE"})`.
- If failed, call `update_item(id, {status: "IN_PROGRESS"})` and log the coverage gaps.
