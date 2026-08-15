---
description: Generate tests and verify coverage requirements
---

> Use the `agenfk` CLI for all workflow operations (CLI-only is the default; read with `--json` for machine-readable output). If `mcp__agenfk__*` tools are present (installed with `--with-mcp`), the equivalent MCP tool is interchangeable.

You are executing the `/agenfk-test <id>` command as a **Testing Agent**. Follow these steps precisely:

**Step 1 — Identify Test Surface**
- Read the item details using `agenfk get <id> --json`.
- **Project Link**: Use the `projectId` from the item to ensure you are associated with the correct project. Compare it against `agenfk current-project`; if that errors (no `.agenfk/project.json` found), create the file with `{ "projectId": "<projectId>" }`.
- Use `git diff` or compare against the parent branch to see the files modified.
- Locate the corresponding test files (e.g., `*.test.ts`, `test_*.py`).

**Step 2 — Generate Missing Tests**
- If new logic was added without tests, generate the necessary test cases using the project's testing framework.
- Ensure edge cases and error paths are covered.
- **Never touch an existing test to go green.** Adding new tests is free; rewriting, relaxing, skipping or deleting a test that already exists is the developer's call. If an existing test fails or looks outdated, STOP and ask them to choose: (1) accept the change to the test, or (2) keep the test as-is and fix the code. On Claude Code the `agenfk-test-guard` hook raises that prompt for you.

**Step 3 — Execute & Verify Coverage**
- Run the project's test suite with coverage reporting (e.g., `npm run test:coverage`, `npx vitest run --coverage`).
- Capture the full command output.
- Read the coverage report and identify any files modified in this task that fall below the **80% threshold**.
- If coverage is too low, add more tests until the threshold is met.
- **End-to-end verification**: For features, confirm the tests cover the full path from UI interaction to backend response — not just isolated units. Flag any untested integration gaps.
- **Bug fix verification**: For bug fixes, ensure tests reproduce the original symptom and verify the root cause fix — not just the workaround.

**Step 4 — Log Results & Yield**
- If tests pass and coverage is met:
    - Run `agenfk log-test <id> --command "<test-command>" --output "<full captured output>" --status PASSED` — this populates the Test Results tab.
    - Run `agenfk comment <id> "TESTS PASSED: ... [85% Coverage]"` to log the summary.
    - Run `agenfk comment <id> "Phase Test complete: Coverage threshold met and tests passed."` to log the phase completion.
    - **DO NOT run `agenfk verify`** — the Closing Agent handles the final advance to DONE.
    - **DO NOT transition to DONE** — the Closing Agent handles TEST → DONE.
    - STOP and YIELD. The supervisor will assign a closing agent to finalize the task.
- If failed:
    - Run `agenfk log-test <id> --command "<test-command>" --output "<full captured output>" --status FAILED` to record the failure.
    - Run `agenfk comment <id> "TESTS FAILED: ... [65% Coverage]"` and log the coverage gaps.
    - Run `agenfk update <id> --status <coding-step>` to send it back for fixes (backward rollback — valid use of `agenfk update`).
    - STOP and YIELD.
