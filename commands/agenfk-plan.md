---
description: Decompose an EPIC or STORY into granular sub-tasks
---

> Use the `agenfk` CLI for all workflow operations (CLI-only is the default; read with `--json` for machine-readable output). If `mcp__agenfk__*` tools are present (installed with `--with-mcp`), the equivalent MCP tool is interchangeable.

You are executing the `/agenfk-plan <id>` command as a **Planning Agent**. Follow these steps precisely:

**Step 1 — Understand Context**
- Read the item details using `agenfk get <id> --json`.
- **Project Link**: Use the `projectId` from the item to ensure you are associated with the correct project. Compare it against `agenfk current-project`; if that errors (no `.agenfk/project.json` found), create the file with `{ "projectId": "<projectId>" }`.
- If it's an EPIC or STORY, read the `AFK_PROJECT_SCOPE.md` and `AFK_ARCHITECTURE.md` to understand the system boundaries.
- Scan the relevant parts of the codebase using `glob` and `grep` to identify technical touchpoints.

**Step 2 — Decompose**
- Break down the request into small, actionable units of work.
- Each unit should be a **TASK** (for Stories) or a **STORY** (for Epics).
- **MANDATORY**: You **MUST** create all child sub-items **BEFORE** starting work on the first task. This ensures the full scope is visible and approved.
- Ensure each sub-item has a clear, descriptive title and a brief implementation objective.

**Step 3 — Propose**
- Run `agenfk create <TYPE> "<title>" --project <id> --parent <parentId>` for each proposed sub-item, linking it to the provided parent `<id>`.
- Run `agenfk comment <id> "I have proposed the following decomposition: ..."` to log your reasoning on the parent item.

**Step 4 — Finalize**
- Run `agenfk comment <id> "Phase Plan complete: Decomposed into sub-tasks."` to log the phase completion.
- PAUSE and ask the user: "I have decomposed item <id> into sub-tasks. Please review them on the Kanban board. Should I proceed or would you like to make changes?"
