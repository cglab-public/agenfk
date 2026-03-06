---
description: Summarize implementation and finalise the task
---

You are executing the `/agenfk-close <id>` command as a **Closing Agent**. Follow these steps precisely:

**Step 1 — Collate History**
- Read the item details using `get_item(id)`.
- **Cross-project guard**: Read `.agenfk/project.json` in the current working directory. If it exists and its `projectId` does NOT match `item.projectId`, **STOP immediately** — do not commit, do not proceed. Warn the user:
  > "⚠️ Item [`<id>`] belongs to project `<item.projectId>`, but the current directory is linked to project `<local.projectId>`. Running `/agenfk-close` here would pollute this repo's git history with a foreign task. Please `cd` to the correct project directory and re-run."
- **Project Link**: Use the `projectId` from the item to ensure you are associated with the correct project. If `.agenfk/project.json` is missing, create it with `{ "projectId": "<projectId>" }`.
- Extract all progress comments from `item.comments`.
- Extract the final test coverage metrics from the `item.reviews`.

**Step 2 — Summarize**
- Create a concise bulleted summary of:
    - Major code changes performed.
    - Architectural components touched.
    - Verification outcome (test results/coverage).
    - Total token usage (calculated from `item.tokenUsage`).

**Step 3 — Log Final Comment**
- Use `add_comment(id, "### FINAL SUMMARY\n\n" + summary)` to log the closing statement.

**Step 4 — Close Children First (Bottom-Up)**
- If the item has children (EPIC with STORYs, STORY with TASKs), use `list_items(parentId=id)` to check their status.
- Any child still in an intermediate flow step must be progressed to DONE first: use `validate_progress(childId)` — if no command is provided, the project's verifyCommand runs automatically. The server blocks direct DONE transitions via `update_item`.
- **Sibling propagation**: If one child's `validate_progress` already reached DONE, remaining siblings will pass immediately (same verified code). Call `validate_progress` on each — the server skips execution via sibling propagation.
- Any child still in the coding step (IN_PROGRESS or equivalent) should be flagged to the user before proceeding.
- Only proceed to Step 5 once ALL children are DONE.

**Step 5 — Move to DONE**
- Call `add_comment(id, "Phase Close complete: Final summary prepared.")` to log the phase completion.
- For EPIC/STORY parents: when all children reach DONE, the parent propagates to DONE automatically — no manual transition needed.
- For leaf items (TASK/BUG) in an intermediate step: call `validate_progress(id)` to advance to DONE.

**Step 6 — Next Steps**
- After the item has been moved to `DONE`, you **MUST** ask the user what they would like to do next, providing exactly these three options:
    1. **Release**: Run `/agenfk-release` to create a new release.
    2. **New Task**: Start a new session for a new task, epic, or bug (by calling `/clear` followed by `/agenfk`).
    3. **Continue Current**: Keep working on the current item (you MUST then ask what else should be included and move the item back to `IN_PROGRESS`).
