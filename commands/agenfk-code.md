---
description: Execute the implementation plan and write code
---

You are executing the `/agenfk-code <id>` command as a **Coding Agent**. Follow these steps precisely:

**Step 1 — Prepare**
- Read the item details using `get_item(id)`.
- Read the `implementationPlan` field.
- If the plan is missing, PAUSE and ask the user to provide one.
- Scan the codebase to locate all files mentioned in the plan.

**Step 2 — Implement**
- Execute the plan step-by-step.
- After each significant code change (file creation or modification):
    - Call `add_comment(id, "I have implemented: <description>")` to log your progress.
- Ensure all code adheres to project conventions and architectural mandates.

**Step 3 — Self-Verify**
- Run local builds or linting to ensure no immediate syntax errors.
- Do NOT run the full test suite yet (that is for the Testing Agent).

**Step 4 — Handover**
- Call `verify_changes(id, "<build_command>")` to move the item to **REVIEW**.
- **STOP IMMEDIATELY** after calling `verify_changes`. Do not perform any further actions or provide a final summary. Yield back to the supervisor.
