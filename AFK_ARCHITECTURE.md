# AFK Architecture: AgenFK Framework

## System Overview
AgenFK follows a **Single Owner Architecture** where a centralized API server manages the framework state, ensuring consistency across CLI, UI, and MCP clients.

## Project Structure (Monorepo)
The project is organized as a TypeScript monorepo using npm workspaces under the `agentic-framework/` directory.

- `agentic-framework/packages/core`: The foundation of the system. Contains all shared types, interfaces, and core logic for item lifecycle and state management.
- `agentic-framework/packages/cli`: A command-line interface that allows developers and agents to interact with the framework (create items, update status, etc.).
- `agentic-framework/packages/server`: The central API server built with Express. It manages the `db.json` storage and broadcasts updates via WebSockets.
- `agentic-framework/packages/storage-sqlite`: A storage plugin implementing SQLite persistence via `better-sqlite3`. Uses WAL mode and an indexed schema for efficient queries.
- `agentic-framework/packages/ui`: A modern web-based Kanban board built with React, Vite, Tailwind CSS, and TanStack Query.

## Key Component Interactions
1.  **Server as Source of Truth**: All state changes must go through the Server.
2.  **CLI/UI as Clients**: The CLI and Web UI communicate with the Server via a RESTful API.
3.  **Real-time Updates**: The Server uses WebSockets to push state changes to the UI for immediate visual feedback.
4.  **Planning Phase (Complex Items)**:
    - For items identified as EPIC or STORY, the system enforces a decomposition step.
    - All sub-items (Stories/Tasks) are created in `TODO` status first.
    - The Agent MUST obtain explicit user approval of the decomposition before transitioning any child item to `IN_PROGRESS`.
    - **Minimum Decomposition Rule**: After exiting plan mode, the type of card that needs to be created is minimally a **STORY with child TASKS** or an **EPIC with child STORIES and their TASKS**. Direct coding on a STORY or EPIC without child TASKS is prohibited.
    - **Backlog Inspection Rule**: When starting new work, only items in **TODO** status should be inspected. Items labeled or in a state suggesting they are **IDEAs** (draft ideas or speculative plans) MUST be ignored until they are promoted to TODO.
    - **Item Type Selection Rule**: An agent receiving a new request MUST classify it before creating any item. Use TASK only for single-file, immediately-obvious changes. Use STORY for multi-file, single-package work. Use EPIC whenever the request spans multiple packages, introduces new architecture, or requires a plan to decompose — and always run `/agenfk-plan` before coding. Key signals for EPIC: new package/subsystem, 3+ packages touched, multiple distinct user-facing capabilities, or needing Plan Mode to understand scope.
5.  **Verification Loop**:
    - **Intermediate Steps (REVIEW, TEST, etc.)**: Advanced via `validate_progress`. Before calling it, agents call `workflow_gatekeeper(itemId)` to receive the current step's `exitCriteria`. `validate_progress` runs an agent-chosen command (or `verifyCommand` on the final step) to gate advancement.
    - **Exit Criteria**: Free-text conditions on each `FlowStep`. Surfaced by the gatekeeper response so agents know what to satisfy before calling `validate_progress`.
    - **Coverage Rule**: Newly inserted code MUST meet a minimum threshold (e.g., 80%). The specific implementation of this check (e.g., parsing Vitest vs Jest outputs) is project-specific. For the AgenFK Framework itself, a helper script at `scripts/enforce-coverage.ts` is provided to perform this check against Vitest output.
    - **DONE Status**: Only reachable via `validate_progress` at the final intermediate step. Direct `update_item({ status: "DONE" })` is blocked by the server.

## Multi-Agent Orchestration
AgenFK features an automated orchestration layer where the primary agent acts as a supervisor, automatically spawning specialized sub-agents at each phase transition using the `task` tool:

1.  **Planning Agent (TODO Phase)**:
    - **Trigger**: New user request or creation of an EPIC/STORY.
    - **Protocol**: Decomposes request into `TODO` sub-items and **PAUSES** for human approval.
2.  **Coding Agent (IN_PROGRESS Phase)**:
    - **Trigger**: Human approval of the plan.
    - **Protocol**: Implements the plan and calls `update_item({ status: "REVIEW" })` to signal coding is done, then calls `workflow_gatekeeper(itemId)` followed by `validate_progress` to transition to `TEST`.
3.  **Review Agent (REVIEW Phase)**:
    - **Trigger**: Automatic spawn when item enters REVIEW.
    - **Protocol**: Calls `workflow_gatekeeper(itemId)` to read exit criteria, audits code for security and requirements, then calls `validate_progress` to advance to `TEST`.
4.  **Testing Agent (TEST Phase)**:
    - **Trigger**: Automatic spawn after successful review.
    - **Protocol**: Calls `workflow_gatekeeper(itemId)` to read exit criteria, generates tests and verifies 80% coverage, then calls `validate_progress` (uses `verifyCommand`) to move item to `DONE`.
5.  **Closing Agent (DONE Phase)**:
    - **Trigger**: Automatic spawn after successful testing.
    - **Protocol**: Collates progress logs, writes the final summary comment, and prompts the user for the next action: Release, New Task (calls `/clear` and `/agenfk`), or Continue Current.

This automation ensures consistent engineering rigor while minimizing human micro-management.

## Supported AI Clients

AgenFK supports six AI coding assistants. Each integrates with the same MCP server but uses a different hook mechanism for workflow enforcement. **All six clients now have hooks** — the prior "instructional-only" gap for Codex / Cursor / Gemini has closed, and pi gets mechanical pre-edit blocking via its native extension event API.

| Client | MCP Registration | Workflow Rules | Pre-edit hook | Post-tool hook (PR sizing) |
|--------|-----------------|----------------|---------------|----------------------------|
| **Claude Code** | `claude mcp add` (user scope) | `~/.claude/CLAUDE.md` | `PreToolUse` — `agenfk-gatekeeper` + `agenfk-mcp-enforcer` + `agenfk-test-guard` | `PostToolUse` matcher `Bash` — `agenfk-pr-hook --client claude-code` |
| **OpenCode** | `~/.config/opencode/opencode.json` | `~/.config/opencode/skills/agenfk/SKILL.md` | `tool.execute.before` plugin (`agenfk-mcp-enforcer-opencode.mjs`) | `tool.execute.after` plugin (`agenfk-pr-hook-opencode.mjs`) |
| **pi** (0.79+) | opt-in (pi MCP config; not auto-registered) | (not yet bundled — extension provides enforcement) | native extension `~/.pi/agent/extensions/agenfk.ts` — `tool_call(edit\|write)` → gatekeeper, `tool_call(bash)` → mcp-enforcer (delegates to `~/.agenfk/bin/*.mjs`) | same extension — `tool_result(bash)` → `agenfk-pr-hook --client pi`, with the live model from `ctx.getModel()` injected into the reminder |
| **Codex CLI** | `codex mcp add` | `~/.codex/AGENTS.md` | (no equivalent — CLAUDE.md-style instructional) | `hooks.PostToolUse` matcher `Bash` (Codex matches the shell tool as `Bash`) — `agenfk-pr-hook --client codex` |
| **Gemini CLI** (v0.26+) | `gemini mcp add` | `~/.gemini/GEMINI.md` | (no equivalent — instructional) | `AfterTool` matcher `run_shell_command` — `agenfk-pr-hook --client gemini` |
| **Cursor** (1.7+) | `~/.cursor/mcp.json` | `~/.cursor/rules/agenfk.mdc` | (no equivalent — instructional + `alwaysApply: true` rule) | `afterShellExecution` — `agenfk-pr-hook --client cursor` |

### Enforcement model

- **Pre-edit gatekeeping** (is a TASK/BUG in an active working step?) is mechanical on Claude Code, OpenCode, and **pi** — their hook systems support pre-tool blocking (pi via the `tool_call` event returning `{ block, reason }`). On Codex / Gemini / Cursor, this remains **instructional** via the per-client rule docs — backed by the server-side `workflow_gatekeeper` audit trail.
- **Existing-test protection** (is the agent rewriting, skipping or deleting a test that already exists?) is mechanical on **Claude Code** via `agenfk-test-guard`, which returns `permissionDecision: "ask"` rather than blocking — the developer answers the permission prompt itself: approve = accept the change to the test, deny = keep the test and fix the code. It is deliberately not a `deny`: a hard block has no way to express "the developer said yes". Other clients cannot turn a hook verdict into a developer-facing question, so there it stays **instructional** via the Quality Guards rule in each rule bundle.
- **PR sizing prompt** (after `gh pr create` / `git push`) is mechanical on **all six** clients via their respective post-tool hook events. On pi the reminder additionally carries the deterministically-detected model id (`ctx.getModel()`), so the agent reports the real model instead of guessing. Even when the post-tool directive isn't followed, the per-client instruction docs include a belt-and-suspenders rule asking the agent to call `register_pr` / `update_pr_sizing`.

### Note on Codex hook coverage

Codex's hook system reliably fires for the shell tool but not for `apply_patch` or most MCP tool calls (open issues `openai/codex#14882`, `#16732`, May 2026). The PR sizing hook is unaffected because `gh pr create` and `git push` always run via the shell tool. If pre-edit gatekeeping is added to Codex later, this caveat will need to be revisited.

## Tech Stack
- **Language**: TypeScript (Strong typing across the stack)
- **Backend**: Node.js, Express, Socket.io
- **Frontend**: React, Vite, Tailwind CSS, TanStack Query
- **Storage**: SQLite only (`better-sqlite3`). Any existing `db.json` is automatically migrated during install or upgrade.
- **Communication**: REST API, WebSockets, MCP
