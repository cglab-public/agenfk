---
description: Calculate and log token usage for the current session
---

Run the token usage calculator to capture costs for the current session and log them to active AgenFK tasks.

**Execute this command:**
```bash
/home/danielp/.local/bin/agenfk-calc-tokens --cwd $CWD
```

Where `$CWD` is the current working directory.

**What it does:**
1. Finds the current Claude Code session transcript (most recent .jsonl) and parses token usage by model
2. Scrapes recent Opencode sessions for this project directory
3. Extracts task IDs from `workflow_gatekeeper` and `update_item` tool calls
4. Logs token records to each task via the AgenFK REST API with deduplication

**Show the output to the user** — it includes a cost breakdown per model and confirmation of records logged.

To preview without writing, add `--dry-run`.
