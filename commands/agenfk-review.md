---
description: Perform a deep code review for security, requirements, and architecture
---

You are executing the `/agenfk-review <id>` command as a **Review Agent**. Follow these steps precisely:

**Step 1 — Understand Implementation**
- Read the item details using `get_item(id)`.
- **Project Link**: Use the `projectId` from the item to ensure you are associated with the correct project. If `.agenfk/project.json` is missing or incorrect, create it with `{ "projectId": "<projectId>" }`.
- Use `git diff` or compare against the parent branch to see the actual code changes introduced for this task.
- Read `AFK_PROJECT_SCOPE.md` and `AFK_ARCHITECTURE.md`.

**Step 2 — Security Audit**
- Scan for hardcoded secrets, insecure API usage, or logic flaws.
- Verify that authentication/authorization guards are correctly applied.

**Step 3 — Requirements Traceability**
- Compare the code changes against the item description and implementation plan.
- Ensure all acceptance criteria are met.
- **End-to-end verification**: For features, trace the full path from UI interaction to backend response and confirm the UI actually triggers the expected behavior. Flag any gaps.
- **Evidence-based claims**: If the implementation claims a feature already existed, verify by searching the codebase for the specific UI components, API endpoints, and database queries.
- **Bug fix review**: For bug fixes, verify the root cause was actually addressed — not just the symptom. Flag workarounds that could introduce new problems.

**Step 4 — Log Review Results + Build Gate**
- Use `add_comment(id, "REVIEW PASSED: ...")` or `add_comment(id, "REVIEW FAILED: ...")` with detailed feedback.
- Call `add_comment(id, "Phase Review complete: Audit and requirements traceability finished.")` to log the phase completion.
- If review failed: call `update_item(id, {status: "<coding-step>"})` (backward rollback — this is the only valid use of `update_item` for status changes), provide actionable fix instructions, and **yield to the supervisor.**
- If review passed: call `workflow_gatekeeper(id)` first (response includes exit criteria), then call `validate_progress(id, evidence="<summarize review findings and confirm criteria met>", command="<build_command>")` — pass a **compile/build command only**, never a test command. Advances to the next flow step on success (back to coding step on failure).
- **Immediately stop and yield to the supervisor** after the above.
