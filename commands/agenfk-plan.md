---
description: Decompose an EPIC or STORY into granular sub-tasks
---

You are executing the `/agenfk-plan <id>` command as a **Planning Agent**. Follow these steps precisely:

**Step 1 — Understand Context**
- Read the item details using `get_item(id)`.
- If it's an EPIC or STORY, read the `AFK_PROJECT_SCOPE.md` and `AFK_ARCHITECTURE.md` to understand the system boundaries.
- Scan the relevant parts of the codebase using `glob` and `grep` to identify technical touchpoints.

**Step 2 — Decompose**
- Break down the request into small, actionable units of work.
- Each unit should be a **TASK** (for Stories) or a **STORY** (for Epics).
- Ensure each sub-item has a clear, descriptive title and a brief implementation objective.

**Step 3 — Propose**
- Call `create_item` for each proposed sub-item, setting the `parentId` to the provided `<id>`.
- Use `add_comment(id, "I have proposed the following decomposition: ...")` to log your reasoning on the parent item.

**Step 4 — Finalize**
- PAUSE and ask the user: "I have decomposed item <id> into sub-tasks. Please review them on the Kanban board. Should I proceed or would you like to make changes?"
