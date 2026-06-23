---
description: Calculate and log token usage for the current session
---

> Use the `agenfk` CLI for all workflow operations (CLI-only is the default; read with `--json` for machine-readable output). If `mcp__agenfk__*` tools are present (installed with `--with-mcp`), the equivalent MCP tool is interchangeable.

Inspect the token usage recorded for the current session. Token usage is captured automatically by the server-side ingestion worker — agents do not need to (and cannot) self-report tokens. This command only **reads** the events the worker has already ingested.

**Read recorded token events (compact output):**
```bash
agenfk tokens --project <projectId> --json
```

Or scope to a single item:
```bash
agenfk tokens --item <itemId> --json
```

(MCP equivalent: `query_token_events`.)

**What it does:**
1. The server-side ingestion worker finds each client's session transcript (Claude Code / Opencode .jsonl) and parses token usage by model.
2. It attributes events to the active item using the task IDs surfaced through `agenfk gatekeeper` and `agenfk update` activity, deduplicating records automatically.
3. `agenfk tokens --json` reads back those ingested events so you can show the user a per-model cost breakdown.

**Show the output to the user** — it includes a cost breakdown per model. Use `--json` for machine-readable output.
