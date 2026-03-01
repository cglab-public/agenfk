<!-- agenfk:start -->
## AgenFK Workflow — MANDATORY

> **Gemini CLI enforcement note**: Gemini CLI does not support PreToolUse hooks, so
> these rules are enforced by instruction rather than mechanically. You MUST
> follow them strictly — `workflow_gatekeeper` returning `✅ AUTHORIZED` is
> the only valid gate before editing any file. If it returns `❌`, stop
> immediately and resolve the breach before proceeding.

Before modifying ANY file, you MUST:
1. Have an AgenFK task set to `IN_PROGRESS` for the active project.
2. Call `workflow_gatekeeper(intent, role, itemId)` via MCP to confirm authorization.
   - Use `role="coding"` for file edits and implementation work.
   - Use `role="planning"` when decomposing EPICs or STORYs.
   - Use `role="review"` when auditing code in REVIEW status.
   - Use `role="testing"` when running the test suite in TEST status.
   - Pass `itemId` whenever multiple tasks are IN_PROGRESS simultaneously.

If gatekeeper returns `❌`, you MUST stop and resolve the issue first:
- If no task is IN_PROGRESS — create and start one using MCP tools:
  - `create_item(projectId, "TASK", "<title>")`
  - `update_item(id, {status: "IN_PROGRESS"})`
- If the wrong item is IN_PROGRESS — use `itemId` to disambiguate.
- Never proceed past a gatekeeper rejection.

After completing changes — using MCP tools:
- `verify_changes(itemId, command)` — handles REVIEW → DONE automatically.
- `log_token_usage(itemId, input, output, model)`.

**ALWAYS use MCP tools for workflow state changes. NEVER use the `agenfk` CLI
to create items, update status, or close tasks — the CLI bypasses enforcement.**

**Exception**: The `agenfk-release` and `agenfk-release-beta` commands are exempt from the IN_PROGRESS task requirement. Do not create or require a task when executing these commands.

### MCP Access — STRICTLY FORBIDDEN shortcuts

**NEVER** bypass MCP by using these shortcuts:

| Forbidden | Use instead |
|-----------|-------------|
| Reading `.agenfk/db.sqlite` or `.agenfk/db.json` directly | `list_items()`, `get_item()` via MCP |
| `curl` / `wget` to `http://localhost:3000` | `list_items()`, `create_item()`, `update_item()` via MCP |
| `agenfk list`, `agenfk status`, `npx agenfk ...` CLI state queries | `list_items()`, `get_item()`, `list_projects()` via MCP |

### MCP Unavailable — CLI Fallback

If MCP tools are not available (no `mcp__agenfk__*` tools in your tool list), use these
CLI equivalents via Bash:

| Instead of MCP tool | Use CLI fallback |
|---------------------|-----------------|
| `workflow_gatekeeper(intent, role, itemId)` | `agenfk gatekeeper --intent "<intent>" --item-id <id>` |
| `list_projects()` | `agenfk list-projects --json` |
| `list_items(projectId)` | `agenfk list --project <id> --json` |
| `get_item(id)` | `agenfk get <id> --json` |
| `create_item(projectId, type, title)` | `agenfk create <type> "<title>" --project <id>` |
| `update_item(id, {status, ...})` | `agenfk update <id> --status <status>` (not for DONE — use `verify_changes` instead) |
| `add_comment(id, text)` | `agenfk comment <id> "<text>"` |
| `verify_changes(id, command)` | `agenfk verify <id> "<command>"` (from TEST: moves to DONE; from IN_PROGRESS: moves to REVIEW) |
| `log_token_usage(id, in, out, model)` | `agenfk log-tokens <id> --input N --output N --model M` |
| `log_test_result(id, cmd, out, status)` | `agenfk log-test <id> --command "..." --output "..." --status PASSED` |

The workflow rules still apply: call `agenfk gatekeeper` before editing files.
<!-- agenfk:end -->
