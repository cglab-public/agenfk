<!-- agenfk:start -->
## AgenFK Workflow — MANDATORY

> **STRICT ENFORCEMENT MANDATE**: You are prohibited from modifying ANY file in the codebase without an active AgenFK task set to `IN_PROGRESS`. Bypassing this workflow is a critical operational failure.

> **Codex enforcement note**: Codex does not support PreToolUse hooks, so
> these rules are enforced by instruction rather than mechanically. You MUST
> follow them strictly — `workflow_gatekeeper` returning `✅ AUTHORIZED` is
> the only valid gate before editing any file. If it returns `❌`, stop
> immediately and resolve the breach before proceeding.

### Hard Block Rules
1. **NO TASK = NO CODE**: If no task is `IN_PROGRESS`, you must STOP and create one.
2. **NO GATE = NO CODE**: You must call `workflow_gatekeeper` before the first edit of every session.
3. **NO BYPASS**: Never use `git commit`, `npm test`, or direct file writes to circumvent the `validate_progress` tool.

Before modifying ANY file, you MUST:
1. Have an AgenFK task set to `IN_PROGRESS` for the active project.
2. Call `workflow_gatekeeper(intent, role, itemId)` via MCP to confirm authorization.
   - Use `role="coding"` for file edits and implementation work.
   - Use `role="planning"` when decomposing EPICs or STORYs.
   - Use `role="validating"` when calling validate_progress (any intermediate flow step past the coding step).
   - Pass `itemId` whenever multiple tasks are IN_PROGRESS simultaneously.

If gatekeeper returns `❌`, you MUST stop and resolve the issue first:
- If no task is IN_PROGRESS — create and start one using MCP tools:
  - `create_item(projectId, "TASK", "<title>")`
  - `update_item(id, {status: "IN_PROGRESS"})`
- If the wrong item is IN_PROGRESS — use `itemId` to disambiguate.
- Never proceed past a gatekeeper rejection.

3. **Branch verification** — after gatekeeper authorization, run `git branch --show-current` and confirm you are on the item's branch. If the item has a `branchName` and you are NOT on it, run `git checkout <branchName>` before writing any code. **Never code on the wrong branch.**

### Flow-Aware Status Check — MANDATORY at session start

At the beginning of every session, check the active workflow flow for the project:

**Via MCP:** The `workflow_gatekeeper` response includes `activeFlow` with the ordered steps. Use those step names as the valid statuses for this project.

**Via REST:**
```bash
curl -s http://localhost:3000/projects/<projectId>/flow
```
Or via CLI: `agenfk flow show --project <projectId>`

**Rule:** Do NOT assume the default statuses (TODO → IN_PROGRESS → REVIEW → TEST → DONE) are active. The project may use a custom flow. Always use the flow's actual step `name` values when calling `update_item({ status })`. The gatekeeper will reject invalid transitions.

After completing changes — using MCP tools:
- `update_item(id, {status: "<next-flow-step>"})` — move to the next step in the active flow when coding is done (typically REVIEW in the default flow).
- `validate_progress(itemId, command?)` — validates exit criteria for the current flow step and advances to the next step. `command` is optional: if omitted, uses `project.verifyCommand`. Call `workflow_gatekeeper(role="validating")` first — the response includes the step's exit criteria. If it returns `NO_VERIFY_COMMAND`, auto-detect the project stack from config files (e.g. `package.json`, `Cargo.toml`, `go.mod`, `*.csproj`), set the command via `update_project({ id, verifyCommand })`, and retry.
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
| `update_item(id, {status, ...})` | `agenfk update <id> --status <status>` (not for DONE — use `validate_progress` instead) |
| `add_comment(id, text)` | `agenfk comment <id> "<text>"` |
| `validate_progress(id, command?)` | `agenfk verify <id> "<command>"` (advances to next step) or `agenfk verify <id>` (uses verifyCommand) |
| `log_token_usage(id, in, out, model)` | `agenfk log-tokens <id> --input N --output N --model M` |
| `log_test_result(id, cmd, out, status)` | `agenfk log-test <id> --command "..." --output "..." --status PASSED` |

The workflow rules still apply: call `agenfk gatekeeper` before editing files.
<!-- agenfk:end -->
