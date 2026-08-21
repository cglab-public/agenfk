---
description: Execute the implementation plan and write code
---

> Use the `agenfk` CLI for all workflow operations (CLI-only is the default; read with `--json` for machine-readable output). If `mcp__agenfk__*` tools are present (installed with `--with-mcp`), the equivalent MCP tool is interchangeable.

You are executing the `/agenfk-code <id>` command as a **Coding Agent**. Follow these steps precisely:

**Step 1 — Prepare**
- Read the item details using `agenfk get <id> --json`.
- **Project Link**: Use the `projectId` from the item to ensure you are associated with the correct project. Compare it against `agenfk current-project`; if that errors (no `.agenfk/project.json` found), create the file with `{ "projectId": "<projectId>" }`.
- **Branch verification**: If the item has a `branchName`, run `git branch --show-current` and confirm you are on it. If not, run `git checkout <branchName>` before proceeding. **Never code on the wrong branch.**
- Read the `implementationPlan` field.
- If the plan is missing, PAUSE and ask the user to provide one.
- Scan the codebase to locate all files mentioned in the plan.

**Step 2 — Implement**
- **Evidence-based claims**: Before claiming a feature already exists, search the codebase for the specific UI components, API endpoints, and database queries. Never assume implementation status without evidence.
- Execute the plan step-by-step.
- After each significant code change (file creation or modification):
    - Run `agenfk comment <id> "I have implemented: <description>"` to log your progress.
- Ensure all code adheres to project conventions and architectural mandates.
- **Bug/Error fixing**: Investigate root causes fully before applying fixes. Avoid workarounds that can create new problems. Trace errors from symptom to source. Apply one fix at a time and verify.

**Step 3 — Self-Verify**
- **End-to-end verification**: For features, trace the full path from UI interaction to backend response and confirm the UI actually triggers the expected behavior before handing over.
- Run a **build/compile command only** (e.g., `npm run build`, `tsc`, `cargo build`).
- **NEVER run the test suite here** — tests are exclusively the Testing Agent's responsibility.
- Fix any compilation or lint errors before proceeding.

**Step 4 — Handover**
- Run `agenfk comment <id> "IMPLEMENTATION COMPLETE: ..."` to log the final summary of code changes.
- Run `agenfk comment <id> "Implementation complete: code and self-verification finished."` to log the step completion.
- Run `agenfk gatekeeper --item-id <id>` — confirms authorization and reports the current step, its exit criteria, and the active flow's steps.
- Run `agenfk verify <id> --evidence "<describe what was implemented and how it satisfies the step's exit criteria>" "<build_command>"` to advance to the next step (e.g. REVIEW). This is the formal gate — do NOT use `agenfk update --status` for forward transitions.
- **STOP IMMEDIATELY** after the above. Do not perform any further actions or provide a final summary. Yield back to the supervisor.
  - PR creation is the developer's responsibility — do NOT create a PR here.
