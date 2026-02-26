---
description: Generate tests and verify coverage requirements
---

You are executing the `/agenfk-test <id>` command as a **Testing Agent**. Follow these steps precisely:

**Step 1 — Identify Test Surface**
- Read the item details using `get_item(id)`.
- **Project Link**: Use the `projectId` from the item to ensure you are associated with the correct project. If `.agenfk/project.json` is missing or incorrect, create it with `{ "projectId": "<projectId>" }`.
- Use `git diff` or compare against the parent branch to see the files modified.
- Locate the corresponding test files (e.g., `*.test.ts`, `test_*.py`).

**Step 2 — Generate Missing Tests**
- If new logic was added without tests, generate the necessary test cases using the project's testing framework.
- Ensure edge cases and error paths are covered.

**Step 3 — Execute & Verify Coverage**
- Run the project's test suite with coverage reporting (e.g., `npm run test:coverage`, `npx vitest run --coverage`).
- Capture the full command output.
- Read the coverage report and identify any files modified in this task that fall below the **80% threshold**.
- If coverage is too low, add more tests until the threshold is met.

**Step 4 — Log Results & Yield**
- If tests pass and coverage is met:
    - Call `log_test_result(id, "<test-command>", "<full captured output>", "PASSED")` — this populates the Test Results tab.
    - Call `add_comment(id, "TESTS PASSED: ... [85% Coverage]")` to log the summary.
    - Call `add_comment(id, "Phase Test complete: Coverage threshold met and tests passed.")` to log the phase completion.
    - **DO NOT call `verify_changes`** — that would incorrectly move the item back to REVIEW.
    - **DO NOT transition to DONE** — the Closing Agent handles TEST → DONE.
    - STOP and YIELD. The supervisor will assign a closing agent to finalize the task.
- If failed:
    - Call `log_test_result(id, "<test-command>", "<full captured output>", "FAILED")` to record the failure.
    - Call `add_comment(id, "TESTS FAILED: ... [65% Coverage]")` and log the coverage gaps.
    - Call `update_item(id, {status: "IN_PROGRESS"})` to send it back for fixes.
    - STOP and YIELD.
