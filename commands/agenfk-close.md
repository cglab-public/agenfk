---
description: Summarize implementation and finalise the task
---

> Use the `agenfk` CLI for all workflow operations (CLI-only is the default; read with `--json` for machine-readable output). If `mcp__agenfk__*` tools are present (installed with `--with-mcp`), the equivalent MCP tool is interchangeable.

You are executing the `/agenfk-close <id>` command as a **Closing Agent**. Follow these steps precisely:

**Step 1 — Collate History**
- Read the item details using `agenfk get <id> --json`.
- **Cross-project guard**: Run `agenfk current-project` to get the working directory's project id (it resolves the nearest `.agenfk/project.json`). If it prints an id that does NOT match `item.projectId`, **STOP immediately** — do not commit, do not proceed. Warn the user:
  > "⚠️ Item [`<id>`] belongs to project `<item.projectId>`, but the current directory is linked to project `<local.projectId>`. Running `/agenfk-close` here would pollute this repo's git history with a foreign task. Please `cd` to the correct project directory and re-run."
- **Project Link**: Use the `projectId` from the item to ensure you are associated with the correct project. If `agenfk current-project` errors (no `.agenfk/project.json` found), create the file with `{ "projectId": "<projectId>" }`.
- Extract all progress comments from `item.comments`.
- Extract the final test coverage metrics from the `item.reviews`.

**Step 2 — Summarize**
- Create a concise bulleted summary of:
    - Major code changes performed.
    - Architectural components touched.
    - Verification outcome (test results/coverage).
    - Token usage is captured automatically by the server-side ingestion worker — agents do not need to (and cannot) self-report tokens.

**Step 3 — Log Final Comment**
- Run `agenfk comment <id> "### FINAL SUMMARY\n\n<summary>"` to log the closing statement.

**Step 4 — Close Children First (Bottom-Up)**
- If the item has children (EPIC with STORYs, STORY with TASKs), run `agenfk list --project <id> --json` (filter by parent) to check their status.
- Any child still in an intermediate flow step must be progressed to DONE first: run `agenfk verify <childId> --evidence "<how this step's criteria were met>"` — if no command is provided, the project's verifyCommand runs automatically. The server blocks direct DONE transitions via `agenfk update --status`.
- **Sibling propagation**: If one child's `agenfk verify` already reached DONE, remaining siblings will pass immediately (same verified code). Run `agenfk verify <id> --evidence "<evidence>"` on each — the server skips execution via sibling propagation.
- Any child still in the coding step (IN_PROGRESS or equivalent) should be flagged to the user before proceeding.
- Only proceed to Step 5 once ALL children are DONE.

**Step 5 — Move to DONE**
- Run `agenfk comment <id> "Phase Close complete: Final summary prepared."` to log the phase completion.
- For EPIC/STORY parents: when all children reach DONE, the parent propagates to DONE automatically — no manual transition needed.
- For leaf items (TASK/BUG) in an intermediate step: run `agenfk verify <id> --evidence "<how exit criteria were met>"` to advance to DONE.
- **Push your branch**: After the item reaches DONE, push the branch to remote:
  ```
  git push -u origin <branchName>
  ```
  Use the item's `branchName` if set, otherwise `git push -u origin HEAD`.

**Step 6 — Next Steps**
- After the item has been moved to `DONE`, you **MUST** ask the user what they would like to do next, providing exactly these three options:
    1. **Release**: Run `/agenfk-release` to create a new release.
    2. **New Task**: Start a new session for a new task, epic, or bug (by calling `/clear` followed by `/agenfk`).
    3. **Continue Current**: Keep working on the current item (you MUST then ask what else should be included and move the item back to `IN_PROGRESS`).
