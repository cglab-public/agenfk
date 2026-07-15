---
name: agenfk
description: Agile, measurable, and reliable workflow enforcement for AI-assisted engineering.
metadata:
  framework: agenfk
  workflow: agile
---

# AgenFK Engineering Framework (agenfk)

This skill enforces the core AgenFK Engineering workflow to ensure all software tasks are Agile, Measurable, Visual, Repeatable, Reliable, and Flexible.

> Use the `agenfk` CLI for all workflow operations (CLI-only is the default; read with `--json` for machine-readable output). If `mcp__agenfk__*` tools are present (installed with `--with-mcp`), the equivalent MCP tool is interchangeable.
>
> **AgEnFK is CLI-only by default.** Drive every workflow operation with the `agenfk`
> CLI — it talks to the AgEnFK server (the single owner of state) and is fully enforced
> server-side. The `agenfk` CLI commands are the primary interface; see the
> **Interface** section below. If you installed with `--with-mcp` and `mcp__agenfk__*`
> tools are present, you may use them instead — they are interchangeable.

## Strict Enforcement Mandate

> **MANDATORY**: You are strictly prohibited from modifying ANY file in the codebase without an active task in an active working step and a successful `agenfk gatekeeper` call. Bypassing this workflow is a critical operational failure.

### Hard Block Rules
1. **NO TASK = NO CODE**: If no task is `IN_PROGRESS`, stop immediately and create one.
2. **NO GATE = NO CODE**: Run `agenfk gatekeeper --intent "<intent>"` before the first edit of every session.
3. **NO BYPASS**: Never use `git commit`, `npm test`, or direct file writes to circumvent `agenfk verify`.
4. **MEASURE EVERYTHING**: Token usage is captured automatically by the server-side ingestion worker — agents do not need to (and cannot) self-report tokens.

## Operation Modes

AgenFK supports two distinct operation modes based on the slash command invoked:

### 1. Standard Mode (via `/agenfk`)
*   **Behavior**: Single-agent, proactive execution.
*   **Workflow**: The agent who starts the task is responsible for the entire lifecycle (Planning, Coding, Verification, and Closing) within a single session.
*   **Mandatory Log**: You MUST run `agenfk comment <itemId> "<content>"` for EVERY significant tool execution or logical step (e.g. "Analyzed file X", "Implemented function Y", "Running tests").
*   **Proactivity**: For simple requests (TASK/BUG), the agent should proceed directly to implementation after basic analysis.
*   **Verification**: You MUST run `agenfk update <itemId> --status REVIEW` to enter REVIEW, then `agenfk gatekeeper --item-id <itemId>` to get exit criteria, then `agenfk verify <itemId> --evidence "<text>"` to advance through intermediate steps and reach DONE.
*   **Decomposition**: MANDATORY. Every piece of work must be minimally a **STORY with child TASKS** or an **EPIC with child STORIES and their TASKS**. Direct coding on a STORY or EPIC without child TASKS is prohibited.
*   **Handoff**: None. Do not spawn sub-agents.

### 2. Deep Mode (via `/agenfk-deep`)
*   **Behavior**: Multi-agent, automated orchestration.
*   **Trigger**: Use this mode for complex architectural changes, high-security code, or large features.
*   **Supervisor Pattern**: You act as a supervisor, responsible for decomposing the task and spawning specialized sub-agents via the `task` tool at every phase transition.
*   **Parallel Execution**: Deep Mode supports **parallel execution** of independent tasks.
    - If an EPIC or STORY has multiple independent sub-items, you SHOULD spawn multiple sub-agents simultaneously using the `task` tool.
    - When working in parallel, you MUST pass the item ID via `agenfk gatekeeper --intent "<intent>" --item-id <id>` to authorize changes against the specific task.
*   **Plan & Pause**: Mandatory decomposition into sub-items. You **MUST PAUSE** and obtain human approval of the plan before moving any item to `IN_PROGRESS`.
*   **Automated Handover**:
    - **Coding to Review**: Automatically spawn a "Review Agent" after `agenfk update <id> --status REVIEW`.
    - **Review to Test**: Automatically spawn a "Test Agent" after successful review.
    - **Test to Done**: Automatically spawn a "Closing Agent" after successful testing.

---

## Interface — the `agenfk` CLI (MCP optional)

Use the `agenfk` CLI for all workflow state operations. It is the default and fully
enforced by the server. Each workflow tool name in this skill maps to a CLI command:

| Tool name (this skill) | `agenfk` CLI command |
|------------------------|----------------------|
| `workflow_gatekeeper(intent, itemId?)` | `agenfk gatekeeper --intent "<intent>" [--item-id <id>] [--role <planning\|coding\|review\|testing\|closing>] [--json]` |
| `list_projects()` | `agenfk list-projects --json` |
| *(get current project id)* | `agenfk current-project [--json]` — prints the current project id resolved from the nearest `.agenfk/project.json` (walking up from the cwd); `--json` adds the project name/description from the server when reachable. No MCP equivalent — CLI only. |
| `create_project(name)` | `agenfk create-project "<name>" [-d/--description <desc>]` |
| `update_project(id, {...})` | `agenfk update-project <id> [--name <name>][--description <text>][--verify-command <cmd>]` |
| `list_items(projectId, ...)` | `agenfk list [--project <id>] [-t/--type <type>] [-s/--status <status>] [--active] [--all] [--json]` (`--active` = only items in an active working step; flow-aware) |
| `get_item(id)` | `agenfk get <id> --json` |
| `create_item(projectId, type, title)` | `agenfk create <TYPE> "<title>" --project <id> [-d/--description <desc>] [-p/--parent <id>]` |
| `update_item(id, {status})` | `agenfk update <id> [--status <name>][--title <t>][--description <d>][--type <T>]` (status is backward/rollback only) |
| `validate_progress(id, evidence, command?)` | `agenfk verify <id> --evidence "<text>" ["<command>"]` |
| `add_comment(id, text)` | `agenfk comment <id> "<text>" [--author <name>]` |
| `add_context(id, path)` | `agenfk add-context <id> --path <path> [--description <text>][--content <text>]` |
| `move_item(id, target)` / `delete_item(id)` | `agenfk move <id> <targetProjectId>` / `agenfk delete <id>` |
| `pause_work(...)` / `resume_work(id)` | `agenfk pause-work <id> --summary "<s>" --resume-instructions "<r>" [--files a,b][--git-diff <diff>]` / `agenfk resume-work <id>` |
| `get_flow(projectId)` / `list_flows()` | `agenfk flow show [id] [--project <id>] [--json]` (bare `flow show` auto-detects the current project's **active** flow; `--project` is optional) / `agenfk flow list [--json]` |
| `use_flow(id, projectId)` / `delete_flow(id)` | `agenfk flow use <id> [--project <id>]` / `agenfk flow delete <id> [-y/--yes]` |
| `log_test_result(...)` | `agenfk log-test <id> --command "..." --output "..." --status PASSED\|FAILED` |
| `query_token_events(...)` | `agenfk tokens [--item <id>][--project <id>][--client <name>][--since <ts>][--until <ts>][--limit <n>][--json]` |
| `register_pr(...)` / `update_pr_sizing(...)` | `agenfk pr-register --item <id> --number <n> --repo <r> --epic <n> --story <n> --task <n> --bug <n> --model <id> --harness <name>` / `agenfk pr-resize --number <n> --repo <r> --epic <n> --story <n> --task <n> --bug <n> --model <id> --harness <name>` (`--model` and `--harness` are **REQUIRED** on both) |
| `analyze_request(req)` | `agenfk analyze "<request>"` |

**Read output**: append `--json` to any read command (`list`, `get`, `list-projects`,
`current-project`, `flow show`, `tokens`, …) for machine-readable output you can parse
into your context.

**NEVER** use these bypass routes (the `agenfk-mcp-enforcer` hook blocks them where hooks are supported):

| Forbidden | Use instead |
|-----------|-------------|
| Reading `.agenfk/db.sqlite` or `.agenfk/db.json` directly (via Bash or Read tool) | `agenfk list --json` · `agenfk get <id> --json` |
| `curl` / `wget` to `http://localhost:3000` (direct REST API) | `agenfk list` · `agenfk create` · `agenfk update` · `agenfk verify` |

MCP is opt-in (`--with-mcp`). When MCP tools are present, they are equivalent to the CLI commands above.

---

## What I do

1.  **Initialization**
    *   **Clean Start from Main (MANDATORY)**:
        1. Run `git status` — if the working tree has uncommitted or modified files, **STOP** and ask the user how to proceed (stash, commit, or discard). Never start new work on a dirty working tree.
        2. Run `git branch --show-current` — if NOT on `main` (or `master`) and the current branch does not belong to an item you're about to resume, run `git checkout main` (or `master`).
        3. Run `git pull` to ensure you have the latest upstream changes.
    *   **Action**:
        1. Run `agenfk current-project` to resolve the current project id (it finds the nearest `.agenfk/project.json`, walking up from the cwd). If it prints an id, that is the active `projectId` — use it for every command that takes `--project <id>`.
        2. If missing, DO NOT assume an existing project should be reused based on name alone.
        3. Run `agenfk list-projects --json` to see existing projects.
        4. **MANDATORY**: Ask the user if they want to use an existing project (by name/ID) or create a new one (recommended).
        5. If creating a new one, use the current directory name as the default project name unless the user specifies otherwise (`agenfk create-project "<name>"`).
        6. Create/link the project by creating `.agenfk/project.json` with the `{ "projectId": "..." }`.
        7. **Flow-Aware Status Check (MANDATORY)**: Immediately after identifying the project, run `agenfk flow show --project <projectId> --json` to discover the active workflow flow. The `agenfk gatekeeper` response also includes `activeFlow`. **Use the flow's step `name` values as the valid statuses for this project** — do NOT assume the default TODO → IN_PROGRESS → REVIEW → TEST → DONE pipeline is active. The project may have a custom flow with different steps and ordering.
        8. Scan the codebase and generate `AFK_PROJECT_SCOPE.md` and `AFK_ARCHITECTURE.md` if they don't exist. BE THOROUGH AND COMPLETE. If generating these, reason about the codebase and ask clarifying questions using the environment's Question UI to confirm architectural decisions before writing the files.
        9. Fetch all items via `agenfk list --project <projectId> --json` and render the **Board Report** as described below.
        10. **Working a specific item by id**: If the user names a specific item (e.g. "work on `dd9658a6-…`"), load it with `agenfk get <id> --json` and resume that item. Do **not** attempt to read a file named `<id>.json` — items live in the AgEnFK server, not on disk; `agenfk get <id> --json` is the only way to fetch one.
    *   **Board Report Format**:
        *   **Cycle Time Calculation**: For each item, compute cycle time by finding the time it first entered `IN_PROGRESS` (or similar active state) to the time it entered `DONE`/`ARCHIVED`. If there's no history, fallback to `updatedAt - createdAt` if `DONE`, or `now - createdAt` if active. For items that never started (e.g. `TODO`), cycle time is N/A or 0. Format durations as `HH:MM:SS`.
        *   **Per-card display**: Include a `Cycle Time` column in every status group table.
        *   **Summary Header**: Show a metrics line with:
            - Total token usage (sum of all `tokenUsage[].input + tokenUsage[].output` across all items)
            - Total cycle time (sum of cycle times of all DONE items, formatted as `HH:MM:SS`)
            - Average cycle time across DONE items (total ÷ count, formatted as `HH:MM:SS`)
            - Format: `Tokens: X in / Y out | Cycle Total: HH:MM:SS | Cycle Avg: HH:MM:SS (N tasks)`
    *   **Objective**: Maintain project identity and a living map.

2.  **Request Analysis & Clarification**
    *   **Context**: Take into account `AFK_PROJECT_SCOPE.md` and `AFK_ARCHITECTURE.md` for informed reasoning.
    *   **Action**: Run `agenfk analyze "<request>"` for every new user requirement.
    *   **Mode Selection**:
        - If the user invoked `/agenfk`, use **Standard Mode**.
        - If the user invoked `/agenfk-deep`, use **Deep Mode**.
    *   **Reasoning Step**: Before creating ANY item or initializing a project, you MUST reason about the implementation details.
    *   **Question UI**: If there are *any* ambiguities, missing technical details, or decisions to be made, you MUST use the environment's native "Question UI" (e.g., `default_api:question` in Opencode, or equivalent in other environments) to ask the user for clarification before proceeding with creation.
    *   **Objective**: Categorize as **EPIC**, **STORY**, **TASK**, or **BUG**.
    *   **Minimum Decomposition Rule**: After exiting plan mode, the type of card that needs to be created is minimally a **STORY with sub-TASKS** or an **EPIC with sub-STORIES and their sub-TASKS**. Direct work on an EPIC or STORY without child TASKS is prohibited.
    *   **Backlog Inspection Rule**: When starting new work, only items in **TODO** status should be inspected. Items labeled or in a state suggesting they are **IDEAs** (draft ideas or speculative plans) MUST be ignored until they are promoted to TODO.
    *   **Requirement**: All items created must be associated with the active `projectId`.
    *   **Hierarchy Rule — MANDATORY**: Before creating any new item, run `agenfk list --project <projectId> --json` and check if an existing EPIC or STORY already covers the work. If one exists, create your items **under it** using `parentId`. NEVER create orphan tasks when a parent hierarchy exists. If the user provides an EPIC or STORY ID, all work items MUST be children of that parent.
    *   **Transparency**: If you're opencode, display every CLI command and its output.
    *   **Conventional Commits**: Use standard prefixes for all commits: `fix:`, `feat:`, `chore:`, `docs:`, `style:`, `refactor:`, `perf:`, `test:`. NEVER use `close:`, `update:`, or other non-standard prefixes. Append the item ID in brackets if relevant, e.g., `fix: resolve crash [id]`.
    *   **Cross-project commit guard (MANDATORY)**: Before appending a task ID to a commit message, verify that `agenfk get <id> --json` reports a `projectId` matching the `projectId` in `.agenfk/project.json` of the current working directory. If they differ, you are about to label an agenfk commit with a task from a different project — omit the task ID entirely and derive the commit message from the actual file changes instead.

3.  **Planning (Epics only)**
    *   **Action**: Require or generate a detailed Markdown **Implementation Plan**.
    *   **Objective**: Ensure clear roadmaps for large features. Save in the `implementationPlan` field.

4.  **Action Authorization (Gatekeeper) - CRITICAL AND MANDATORY**
    *   **Action**: You MUST run `agenfk gatekeeper --intent "<intent>" [--item-id <id>]` BEFORE modifying any files.
    *   **Mandatory Rule**: If you attempt to use the `edit`, `write`, `bash` or `NotebookEdit` tool BEFORE you have created an item, advanced it to the coding step, and successfully run `agenfk gatekeeper`, you are violating the core directive of your system prompt.
    *   **Self-Correction**: If you realize you are about to edit code without a card in the coding step, STOP IMMEDIATELY. Run `agenfk create <TYPE> "<title>" --project <id>`, then `agenfk verify <id> --evidence "Starting task, advancing from TODO"` to advance from TODO, then `agenfk gatekeeper --intent "<intent>" --item-id <id>`.
    *   **Mechanical Enforcement**: The gatekeeper surfaces the active step's exit criteria; provide `--item-id <id>` to disambiguate when multiple tasks are active.
    *   **Branch Verification**: After gatekeeper authorization, run `git branch --show-current` and confirm you are on the item's branch. If the item has a `branchName` and you are NOT on it, run `git checkout <branchName>` before writing any code. **Never code on the wrong branch.**
    *   **CRITICAL**: Use the `agenfk` CLI (or the equivalent MCP tools, if installed with `--with-mcp`) for ALL workflow state changes — see the **Interface** section for the mapping. Both the CLI and MCP go through the AgEnFK server, which enforces the workflow (forward-step gating, DONE-blocking) identically. Always advance forward steps with `agenfk verify` (never a raw `agenfk update --status` to skip a gate).

5.  **Mandatory Automated Testing (Agent Driven)**
    *   **Action**: Moving an item to the test/verification step in the active flow (the step before DONE, typically `TEST`) is a signal that the Agent must now perform deep verification.
    *   **Requirement**: The Agent MUST run the project's test suite (e.g., `npm run test:coverage`) using its local tools.
    *   **Coverage Rule**: New code MUST be covered at 80% minimum. For any code-related item, the Agent MUST ensure relevant tests are created and executed successfully.
    *   **Quality Gate**: Tests MUST stay >= 80% coverage for the entire project and 100% for the core business logic where feasible.
    *   **Workflow** (use the active flow's step names — check `activeFlow` from the `agenfk gatekeeper` response):
        *   `agenfk update <itemId> --status <review-step>` moves items from the active coding step to the review step when coding is complete (default: `REVIEW`).
        *   Run `agenfk gatekeeper --item-id <itemId>` before `agenfk verify` — the response includes the current step's exit criteria.
        *   `agenfk verify <itemId> --evidence "<text>" ["<command>"]` — `evidence` is **required**: describe concretely how you satisfied the current step's exit criteria. It is logged as a tagged comment (audit trail) and serves as your mandatory confirmation before the step advances. Runs `command` (or `project.verifyCommand` if omitted) and advances to the next flow step on success.
        *   The Agent verifies coverage and regressions in each intermediate step.
        *   Run `agenfk verify <itemId> --evidence "<how you satisfied this step>"` (no command) for the final step — this uses the project's `verifyCommand` and moves to DONE. If it returns `NO_VERIFY_COMMAND`, the agent auto-detects the project stack from config files (e.g. `package.json`, `Cargo.toml`, `go.mod`, `*.csproj`), sets the command via `agenfk update-project <id> --verify-command "<cmd>"`, and retries. Do NOT use `agenfk update <id> --status DONE` — the server blocks direct DONE transitions.
        *   Failure: Agent moves item back to the active coding step.
    *   **Sibling Propagation**: When child items of the same parent share the same source code, a single `agenfk verify` call validates the code for all siblings. After one passes, move remaining siblings to the same step via `agenfk update <id> --status <step>`, then run `agenfk verify <id> --evidence "<text>"` on each to reach DONE.

6.  **Final Verification (Validate Tool)**
    *   **Action**: After self-review, the Agent runs `agenfk gatekeeper --item-id <itemId>` to get the current step's exit criteria, then `agenfk verify <itemId> --evidence "<text>" ["<command>"]` to gate the transition to the next step.
    *   **Test Suite Enforcement**: The project's `verifyCommand` (set via `agenfk update-project <id> --verify-command "<cmd>"`) is used automatically when no `command` is provided. Agents cannot override or bypass it.
    *   **Transition Logic (Automated by Tool)**:
        1. The agent advances the item past the coding step via `agenfk update <id> --status <step>`.
        2. The agent performs self-review (re-reads files, checks correctness).
        3. The agent runs `agenfk verify <itemId> --evidence "<concrete description of how exit criteria were met>" ["<command>"]` — logs evidence as a tagged comment, runs the command, and advances to the next flow step.
        4. Success: Advances to the next step. Failure: Moves back to the coding step. Repeat for each intermediate step until DONE.

7.  **Measurement & Tracking**
    *   **Reporting Requirements**: Token usage is captured automatically by the server-side ingestion worker — agents do not need to (and cannot) self-report tokens.
    *   **Progress Comments**: The Agent **MUST** run `agenfk comment <itemId> "<content>"` for EVERY significant step performed during implementation (e.g. "Modified core types", "Updated UI components", "Ran tests"). This ensures the human user can follow the agent's work in real-time on the Kanban board.
    *   **Completion — Bottom-Up Closure (MANDATORY)**: When closing work, you MUST close the entire hierarchy bottom-up. Use the active flow's step names (check `activeFlow` in the `agenfk gatekeeper` response):
        1. Close all child TASKs first: advance past the coding step via `agenfk update <id> --status <step>`, self-review, then run `agenfk verify <id> --evidence "<evidence>"` for each intermediate step until DONE.
           - **Sibling shortcut**: If one child's `agenfk verify` already advanced past a step, move remaining siblings to that step via `agenfk update <id> --status <step>`. Then run `agenfk verify <id> --evidence "<evidence>"` on each — subsequent calls pass immediately via sibling propagation.
        2. Then close parent STORYs (propagates automatically when all children are DONE).
        3. Then close the EPIC (propagates automatically when all STORYs are DONE).
        NEVER leave cards stuck in intermediate steps. You are responsible for progressing each item all the way to DONE.
        NEVER use `agenfk update <id> --status DONE` — the server rejects direct DONE transitions. Always use `agenfk verify <id> --evidence "<evidence>"` to close an item.
    *   **Post-Completion Prompt (MANDATORY)**: After an item (TASK, STORY, BUG, or EPIC) has been moved to `DONE`, the Agent **MUST** ask the user what they would like to do next, providing exactly these three options:
        1. **Release**: Run `/agenfk-release` to create a new release.
        2. **New Task**: Start a new session for a new task, epic, or bug (by calling `/clear` followed by `/agenfk`).
        3. **Continue Current**: Keep working on the current item (the Agent MUST then ask what else should be included and move the item back to `IN_PROGRESS`).

## Quality Guards — MANDATORY

### Feature Implementation
- **End-to-end verification**: After implementing any feature, verify it works end-to-end by tracing the full path from UI interaction to backend response. Do not mark a feature as complete until you've confirmed the UI actually triggers the expected behavior.
- **Evidence-based claims**: Before claiming a feature already exists or is implemented, search the actual codebase for the specific UI components, API endpoints, and database queries. Never assume implementation status without evidence.

### Bug & Error Fixing
- **Root cause first**: When debugging errors, investigate the root cause fully before applying fixes. Avoid adding workarounds (like force-relogin) that can create new problems (infinite loops). Trace errors from the symptom back to the actual source.
- **One fix at a time**: Apply a single targeted fix, verify it resolves the issue, then move on. Do not stack multiple speculative fixes.

---

## When to use me

Use this skill whenever you are performing software engineering tasks to ensure compliance with the AgenFK Engineering Framework.

## Available Commands (`agenfk` CLI)

*   `agenfk current-project [--json]`: Print the current project id (resolved from the nearest `.agenfk/project.json`). Use this whenever a command needs `--project <id>` or the "active projectId".
*   `agenfk list-projects --json`: List all existing projects.
*   `agenfk create-project "<name>"`: Create a new project.
*   `agenfk create <TYPE> "<title>" --project <id>`: Create a new workflow item.
*   `agenfk update <id> --status <name>`: Update status (backward/rollback only — use `agenfk verify` for forward transitions).
*   `agenfk list --project <id> --json`: Query the backlog.
*   `agenfk get <id> --json`: Get full details.
*   `agenfk add-context <id> --path <path>`: Attach relevant file paths.
*   `agenfk analyze "<request>"`: Categorization strategy.
*   `agenfk gatekeeper --intent "<intent>" [--item-id <id>]`: Pre-flight authorization.
*   `agenfk flow show [--project <id>] --json`: Loads the full active flow with all steps and exit criteria — run at session start to understand your complete workflow contract. `--project` is optional: bare `agenfk flow show` inside an initialized project auto-detects the current project and shows its active flow.
*   `agenfk verify <id> --evidence "<text>" ["<command>"]`: Step-completion gate — `evidence` (how you satisfied the exit criteria, logged as a tagged comment) is required; the command is optional. Advances to next step on success.
*   `agenfk pause-work <id> --summary "<s>" --resume-instructions "<r>"`: Save context snapshot and pause item.
*   `agenfk resume-work <id>`: Restore context and resume paused item.

Token usage is captured automatically by the server-side ingestion worker — agents do not need to (and cannot) self-report tokens.

If you installed with `--with-mcp`, each command maps 1:1 to an `mcp__agenfk__*` tool (e.g. `agenfk verify` ↔ `validate_progress`, `agenfk gatekeeper` ↔ `workflow_gatekeeper`) — they are interchangeable.
