<!-- agenfk:start -->
## AgEnFK Workflow — MANDATORY

> **STRICT ENFORCEMENT MANDATE**: You are prohibited from modifying ANY file in the codebase without an active AgEnFK task. Bypassing this workflow is a critical operational failure.

> **Gemini CLI enforcement note**: Gemini CLI does not support PreToolUse hooks, so
> these rules are enforced by instruction rather than mechanically. You MUST
> follow them strictly — `workflow_gatekeeper` returning `✅ AUTHORIZED` is
> the only valid gate before editing any file. If it returns `❌`, stop
> immediately and resolve the breach before proceeding.

### Clean Start — MANDATORY at task start

Before creating or starting a new task:
1. Run `git status` — if the working tree has uncommitted or modified files, **STOP** and ask the user how to proceed (stash, commit, or discard). Never start new work on a dirty working tree.
2. Run `git branch --show-current` — if NOT on `main`/`master` and the current branch doesn't belong to an item you're resuming, run `git checkout main` (or `master`).
3. Run `git pull` to ensure you have the latest upstream changes.

### Hard Block Rules
1. **NO TASK = NO CODE**: If no task is active, you must STOP and create one.
2. **NO GATE = NO CODE**: You must call `workflow_gatekeeper` before the first edit of every session.
3. **NO BYPASS**: Never use `git commit`, `npm test`, or direct file writes to circumvent the `validate_progress` tool.

Before modifying ANY file, you MUST:
1. Have an AgEnFK task in any active working step for the active project.
2. Call `workflow_gatekeeper(intent, itemId?)` via MCP to confirm authorization.
   - Pass `itemId` whenever multiple tasks are active simultaneously.
   - `role=` is accepted for backward compatibility but is no longer enforced.

If gatekeeper returns `❌`, you MUST stop and resolve the issue first:
- If no task is active — create and start one using MCP tools:
  - `create_item(projectId, "TASK", "<title>")`
  - `validate_progress(id, evidence="Starting task, advancing from TODO")` — advances from TODO to the first working step
- If multiple tasks are active — use `itemId` to disambiguate.
- Never proceed past a gatekeeper rejection.

3. **Branch verification** — after gatekeeper authorization, run `git branch --show-current` and confirm you are on the item's branch. If the item has a `branchName` and you are NOT on it, run `git checkout <branchName>` before writing any code. **Never code on the wrong branch.**

### Flow-Aware Status Check — MANDATORY at session start

At the beginning of every session, check the active workflow flow for the project:

**Via MCP (preferred):** Call `get_flow(projectId)` at session start — returns all steps in order with their exit criteria. This is your workflow contract: each step's exit criteria is your mandatory work definition before calling `validate_progress`.

**Via REST:**
```bash
curl -s http://localhost:3000/projects/<projectId>/flow
```
Or via CLI: `agenfk flow show --project <projectId>`

**Rule:** Do NOT assume the default statuses (TODO → IN_PROGRESS → REVIEW → TEST → DONE) are active. The project may use a custom flow. Always use the flow's actual step `name` values when calling `update_item({ status })`.

After completing changes — using MCP tools:
- `get_flow(projectId)` — call at session start to load the full flow with all steps and exit criteria.
- `validate_progress(itemId, evidence, command?)` — step-completion gate. `evidence` is **required**: describe how you satisfied the current step's exit criteria (logged as a tagged comment). **Use this for ALL forward step transitions**. `command` is optional: if omitted, uses `project.verifyCommand` on the final step. If it returns `NO_VERIFY_COMMAND`, auto-detect the project stack from config files (e.g. `package.json`, `Cargo.toml`, `go.mod`, `*.csproj`), set the command via `update_project({ id, verifyCommand })`, and retry.
- `log_token_usage(itemId, input, output, model)`.

**ALWAYS use MCP tools for workflow state changes. NEVER use the `agenfk` CLI
to create items, update status, or close tasks — the CLI bypasses enforcement.**

**Exception**: The `agenfk-release` and `agenfk-release-beta` commands are exempt from the active task requirement. Do not create or require a task when executing these commands.

### Quality Guards — MANDATORY

- **Feature verification**: After implementing any feature, verify it works end-to-end by tracing the full path from UI interaction to backend response. Do not mark complete until confirmed.
- **Evidence-based claims**: Before claiming a feature already exists, search the codebase for the specific UI components, API endpoints, and database queries. Never assume without evidence.
- **Root cause debugging**: When fixing errors, investigate the root cause fully before applying fixes. Avoid workarounds that create new problems (e.g. infinite loops). Trace from symptom to source. One fix at a time.

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
| `workflow_gatekeeper(intent, itemId?)` | `agenfk gatekeeper --intent "<intent>" --item-id <id>` |
| `list_projects()` | `agenfk list-projects --json` |
| `list_items(projectId)` | `agenfk list --project <id> --json` |
| `get_item(id)` | `agenfk get <id> --json` |
| `create_item(projectId, type, title)` | `agenfk create <type> "<title>" --project <id>` |
| `update_item(id, {status, ...})` | `agenfk update <id> --status <status>` (backward/rollback only — use `validate_progress` for all forward transitions) |
| `add_comment(id, text)` | `agenfk comment <id> "<text>"` |
| `get_flow(projectId)` | `agenfk flow show --project <id> --json` |
| `validate_progress(id, evidence, command?)` | `agenfk verify <id> --evidence "<evidence>" "<command>"` or `agenfk verify <id> --evidence "<evidence>"` |
| `log_token_usage(id, in, out, model)` | `agenfk log-tokens <id> --input N --output N --model M` |
| `log_test_result(id, cmd, out, status)` | `agenfk log-test <id> --command "..." --output "..." --status PASSED` |

The workflow rules still apply: call `agenfk gatekeeper` before editing files.
<!-- agenfk:end -->
