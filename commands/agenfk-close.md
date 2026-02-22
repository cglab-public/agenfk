---
description: Summarize implementation and finalise the task
---

You are executing the `/agenfk-close <id>` command as a **Closing Agent**. Follow these steps precisely:

**Step 1 — Collate History**
- Read the item details using `get_item(id)`.
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

**Step 4 — Move to DONE**
- PAUSE and ask the user: "I have prepared the final summary for item <id>. Should I mark it as DONE?"
