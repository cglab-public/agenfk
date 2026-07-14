<!-- agenfk:start -->
## AgEnFK Workflow — MANDATORY

> **AgEnFK is CLI-only by default.** All workflow operations below use the `agenfk`
> CLI, which talks to the AgEnFK server (the single owner of state) and is fully
> enforced server-side. If you installed with `--with-mcp` and `mcp__agenfk__*`
> tools are present in your tool list, you may use the equivalent MCP tool for any
> command — they are interchangeable. When in doubt, use the CLI.

### Clean Start — MANDATORY at task start

Before creating or starting a new task:
1. Run `git status` — if the working tree has uncommitted or modified files, **STOP** and ask the user how to proceed (stash, commit, or discard). Never start new work on a dirty working tree.
2. Run `git branch --show-current` — if NOT on `main`/`master` and the current branch doesn't belong to an item you're resuming, run `git checkout main` (or `master`).
3. Run `git pull` to ensure you have the latest upstream changes.

Before modifying ANY file (Edit, Write, NotebookEdit), you MUST:
1. Have an AgEnFK task in any active working step for the active project.
2. Run `agenfk gatekeeper --intent "<intent>" [--item-id <id>]` to confirm authorization.
   - Pass `--item-id` whenever multiple tasks are active simultaneously.

If gatekeeper returns `❌`, you MUST stop and resolve the issue first:
- If no task is active — create and start one:
  - `agenfk create TASK "<title>" --project <id>`
  - `agenfk verify <id> --evidence "Starting task, advancing from TODO"` — advances from TODO to the first working step
- If multiple tasks are active — use `--item-id` to disambiguate.
- Never proceed past a gatekeeper rejection.

3. **Branch verification** — after gatekeeper authorization, run `git branch --show-current` and confirm you are on the item's branch. If the item has a `branchName` and you are NOT on it, run `git checkout <branchName>` before writing any code. **Never code on the wrong branch.**

### Flow-Aware Status Check — MANDATORY at session start

At the beginning of every session, check the active workflow flow for the project:

```bash
agenfk flow show --project <projectId> --json
```

This returns all steps in order with their exit criteria. This is your workflow contract: each step's exit criteria is your mandatory work definition before calling `agenfk verify`.

**Rule:** Do NOT assume the default statuses (TODO → IN_PROGRESS → REVIEW → TEST → DONE) are active. The project may use a custom flow with different step names and order. Always use the flow's actual step `name` values when calling `agenfk update <id> --status <name>`.

Working the flow:
- `agenfk flow show --project <id> --json` — load the full flow with all steps and exit criteria at session start. Your working contract for the session.
- `agenfk verify <id> --evidence "<evidence>" ["<command>"]` — step-completion gate. `--evidence` is **required**: describe how you satisfied the current step's exit criteria (logged as a tagged comment). **Use this for ALL forward step transitions** (including TODO → first working step). The command is optional: if omitted, uses `project.verifyCommand` on the final step. If verify reports `NO_VERIFY_COMMAND`, auto-detect the project stack from config files (e.g. `package.json`, `Cargo.toml`, `go.mod`, `*.csproj`), set the command via `agenfk update-project <id> --verify-command "<cmd>"`, and retry. Only ask the developer as a last resort.

Token usage is captured automatically by the server-side ingestion worker — agents do not need to (and cannot) self-report tokens.

### PR sizing — MANDATORY

After running `gh pr create`, you MUST run `agenfk pr-register --item <id> --number <n> --repo <owner/repo> --epic <n> --story <n> --task <n> --bug <n>`, where the counts cover the items included in this PR. After `git push` to a branch that already has a registered PR and you've added more items, run `agenfk pr-resize --number <n> --repo <owner/repo> --epic <n> --story <n> --task <n> --bug <n>` with the new counts. The server records a shadow sizing computed from the item tree as a sanity check — only your declared count is authoritative. You MUST also pass `--model <your model id> --harness <your client>` (**both REQUIRED** — `pr-register`/`pr-resize` reject omission) on both commands so the `pr.opened`/`pr.updated` hub event records which agent runtime opened the PR. Report **your actual model** (e.g. for Claude Code, `claude-opus-4-8`) — never copy an example that isn't yours. If you cannot state your own model id directly, **determine your model** from your harness configuration or the current session log before reporting — never omit or guess it (e.g. read the harness's default/selected-model setting, or the session transcript which records the model per turn). A PostToolUse hook prompts you to do this on each `gh pr create` / `git push`.

**Use `agenfk verify` (not `agenfk update --status`) for all FORWARD step transitions** — it enforces the exit-criteria gate and is the only way to reach the final step. `agenfk update <id> --status <name>` is for backward/rollback transitions only.

**Exception**: The `agenfk-release` and `agenfk-release-beta` commands are exempt from the active task requirement. Do not create or require a task when executing these commands.

### Quality Guards — MANDATORY

- **Feature verification**: After implementing any feature, verify it works end-to-end by tracing the full path from UI interaction to backend response. Do not mark complete until confirmed.
- **Evidence-based claims**: Before claiming a feature already exists, search the codebase for the specific UI components, API endpoints, and database queries. Never assume without evidence.
- **Root cause debugging**: When fixing errors, investigate the root cause fully before applying fixes. Avoid workarounds that create new problems (e.g. infinite loops). Trace from symptom to source. One fix at a time.

### STRICTLY FORBIDDEN shortcuts

**NEVER** bypass the `agenfk` CLI/server by using these shortcuts. PreToolUse hooks enforce this mechanically:

| Forbidden | Use instead |
|-----------|-------------|
| Reading `.agenfk/db.sqlite` or `.agenfk/db.json` directly (Bash or Read) | `agenfk list --json`, `agenfk get <id> --json` |
| `curl` / `wget` to `http://localhost:3000` | `agenfk list`, `agenfk create`, `agenfk update`, `agenfk verify` |

Two PreToolUse hooks enforce the workflow:
- `agenfk-gatekeeper` — blocks Edit/Write/NotebookEdit when no active task.
- `agenfk-mcp-enforcer` — blocks the direct-DB and `curl localhost:3000` bypass routes above. (In CLI-only mode it permits the `agenfk` CLI; when MCP is registered it steers state queries to the MCP tools instead.)

### Command Reference — the `agenfk` CLI

This is the full workflow surface. Each row notes the equivalent MCP tool (available only if you installed with `--with-mcp`; `—` means there is no MCP equivalent — use the CLI). Run `agenfk <command> --help` for the authoritative option list; only the flags that matter day-to-day are shown here.

**Workflow & items**

| Operation | CLI command | MCP tool |
|-----------|-------------|----------|
| Authorize a pre-edit | `agenfk gatekeeper --intent "<intent>" [--item-id <id>] [--role <planning\|coding\|review\|testing\|closing>] [--json]` | `workflow_gatekeeper` |
| List projects | `agenfk list-projects --json` | `list_projects` |
| Get the current project id | `agenfk current-project [--json]` (resolves the nearest `.agenfk/project.json`; `--json` adds the project name/description from the server when reachable) | — |
| Create a project | `agenfk create-project "<name>" [-d/--description <desc>]` | `create_project` |
| Update a project | `agenfk update-project <id> [--name <name>][--description <text>][--verify-command <cmd>]` | `update_project` |
| List items | `agenfk list [--project <id>] [-t/--type <type>] [-s/--status <status>] [--all] [--json]` | `list_items` |
| Get an item | `agenfk get <id> --json` | `get_item` |
| Create an item | `agenfk create <TYPE> "<title>" --project <id> [-d/--description <desc>] [-p/--parent <id>]` | `create_item` |
| Update / roll back status | `agenfk update <id> [--status <name>][--title <t>][--description <d>][--type <T>]` (status is backward/rollback only) | `update_item` |
| Advance a step (forward) | `agenfk verify <id> --evidence "<text>" ["<command>"]` | `validate_progress` |
| Add a comment | `agenfk comment <id> "<text>" [--author <name>]` | `add_comment` |
| Attach context | `agenfk add-context <id> --path <path> [--description <text>][--content <text>]` | `add_context` |
| Move an item | `agenfk move <id> <targetProjectId>` | `move_item` |
| Delete an item | `agenfk delete <id>` | `delete_item` |
| Pause work | `agenfk pause-work <id> --summary "<s>" --resume-instructions "<r>" [--files a,b][--git-diff <diff>]` | `pause_work` |
| Resume work | `agenfk resume-work <id>` | `resume_work` |
| Log a test result | `agenfk log-test <id> --command "..." --output "..." --status PASSED\|FAILED` | `log_test_result` |
| Analyze a request | `agenfk analyze "<request>"` | `analyze_request` |
| Query token events | `agenfk tokens [--item <id>][--project <id>][--client <name>][--since <ts>][--until <ts>][--limit <n>][--json]` | `query_token_events` |

**Flows**

| Operation | CLI command | MCP tool |
|-----------|-------------|----------|
| Show a flow | `agenfk flow show [id] [--project <id>] [--json]` — bare `agenfk flow show` inside an initialized project auto-detects the current project and shows its **active** flow; `--project` is optional | `get_flow` |
| List flows | `agenfk flow list [--json]` | `list_flows` |
| Create a flow | `agenfk flow create <name>` (interactive) | `create_flow` |
| Edit a flow | `agenfk flow edit <id>` (interactive) | `update_flow` |
| Activate a flow | `agenfk flow use <id> [--project <id>]` (defaults to current project) | `use_flow` |
| Delete a flow | `agenfk flow delete <id> [-y/--yes]` | `delete_flow` |
| Reset to default flow | `agenfk flow reset [--project <id>]` | — |
| Publish a flow | `agenfk flow publish <id> [--registry <owner/repo>]` | — |
| Browse community flows | `agenfk flow browse [--registry <owner/repo>]` | — |
| Install a community flow | `agenfk flow install <filename> [--registry <owner/repo>]` | — |

**Git, PRs & release sizing**

| Operation | CLI command | MCP tool |
|-----------|-------------|----------|
| Create a branch for an item | `agenfk branch create <itemId> [--name <name>]` | — |
| Push an item's branch | `agenfk branch push <itemId>` | — |
| Show an item's branch status | `agenfk branch status <itemId>` | — |
| Create + auto-register a PR for an item | `agenfk pr create <itemId> [--title <t>][--body <b>][--draft] --model <id> --harness <name>` (`--model`/`--harness` **REQUIRED**; auto-emits `pr.opened` with item-tree-derived sizing — no separate `pr-register` needed) | — |
| Check a PR's status | `agenfk pr status <itemId>` | — |
| Check whether a PR is merged | `agenfk pr check <itemId>` | — |
| Register a PR (sizing) | `agenfk pr-register --item <id> --number <n> --repo <r> --epic <n> --story <n> --task <n> --bug <n> --model <id> --harness <name>` (`--model` and `--harness` are **REQUIRED**) | `register_pr` |
| Resize a PR (sizing) | `agenfk pr-resize --number <n> --repo <r> --epic <n> --story <n> --task <n> --bug <n> --model <id> --harness <name>` (`--model` and `--harness` are **REQUIRED**) | `update_pr_sizing` |

**Services, install & maintenance** (CLI-only — no MCP equivalents)

| Operation | CLI command |
|-----------|-------------|
| Start services (server + UI) | `agenfk up [-q/--quiet][--debuglog]` |
| Stop services | `agenfk down` |
| Restart services | `agenfk restart [-q/--quiet]` |
| Force-kill all processes/ports | `agenfk kill` |
| Open / show the dashboard | `agenfk ui` |
| Check framework health | `agenfk health` |
| Upgrade the framework | `agenfk upgrade [-f/--force][-b/--beta][--version <ver>][--json][--debuglog]` |
| Back up the database | `agenfk backup` |
| Show database type/path/backups | `agenfk db status` |
| Initialize a project in the cwd | `agenfk init [name] [-d/--description <desc>]` |
| Fix Claude Code MCP integration | `agenfk configure-ide` |
| Start the MCP server (stdio) | `agenfk mcp` |

**Integrations, rules/skills & config** (CLI-only)

| Operation | CLI command |
|-----------|-------------|
| List supported integrations | `agenfk integration list` |
| Install integration(s) | `agenfk integration install <platform\|all> [-y/--yes][--with-mcp][--no-mcp]` |
| Uninstall integration(s) | `agenfk integration uninstall <platform\|all> [-y/--yes]` |
| Pause integration(s) | `agenfk integration pause <platform\|all> [-y/--yes]` |
| Resume integration(s) | `agenfk integration resume <platform\|all> [-y/--yes]` |
| Install/uninstall workflow rules & skills | `agenfk skills install [-g/--global][-p/--project]` · `agenfk skills uninstall [-g/--global][-p/--project]` · `agenfk skills status` |
| Enable/disable telemetry | `agenfk config set telemetry <true\|false>` |
| Set the community flow registry | `agenfk config set flowRegistry <owner/repo>` |
| Configure JIRA OAuth | `agenfk jira setup` · `agenfk jira status` · `agenfk jira disconnect` |
| Configure GitHub Issues import | `agenfk github setup [--owner <owner>][--repo <repo>]` · `agenfk github status` · `agenfk github disconnect` |

### Reading state — `--json`

Read commands emit JSON. Append `--json` to `list`, `get`, `list-projects`, `current-project`, `flow show`,
`flow list`, and `tokens` for machine-readable output you can parse into your context:

```bash
agenfk list --project <id> --json
agenfk get <id> --json
agenfk flow show --project <id> --json
agenfk list-projects --json
```

A compact `--toon` format is also available on the same read commands if you want to save output tokens.

### Optional: MCP mode

MCP is **opt-in**. To register the AgEnFK MCP server with your client, install with
`--with-mcp` (e.g. `npx agenfk@latest --with-mcp`, or `agenfk integration install <platform> --with-mcp`).
When MCP tools are present, prefer them for state changes; the CLI commands above remain
available and equivalent. To turn MCP back off, re-run the installer with `--no-mcp`.
<!-- agenfk:end -->
