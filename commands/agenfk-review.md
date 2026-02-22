---
description: Perform a deep code review for security, requirements, and architecture
---

You are executing the `/agenfk-review <id>` command as a **Review Agent**. Follow these steps precisely:

**Step 1 — Understand Implementation**
- Read the item details using `get_item(id)`.
- Use `git diff` or compare against the parent branch to see the actual code changes introduced for this task.
- Read `AFK_PROJECT_SCOPE.md` and `AFK_ARCHITECTURE.md`.

**Step 2 — Security Audit**
- Scan for hardcoded secrets, insecure API usage, or logic flaws.
- Verify that authentication/authorization guards are correctly applied.

**Step 3 — Requirements Traceability**
- Compare the code changes against the item description and implementation plan.
- Ensure all acceptance criteria are met.

**Step 4 — Log Review Results**
- Use `add_comment(id, "REVIEW PASSED: ...")` or `add_comment(id, "REVIEW FAILED: ...")` with detailed feedback.
- If passed, call `update_item(id, {status: "TEST"})`.
- If failed, call `update_item(id, {status: "IN_PROGRESS"})` and provide actionable fix instructions.
