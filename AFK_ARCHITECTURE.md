# AFK Architecture: AgenFK Framework

## System Overview
AgenFK follows a **Single Owner Architecture** where a centralized API server manages the framework state, ensuring consistency across CLI, UI, and MCP clients.

## Project Structure (Monorepo)
The project is organized as a TypeScript monorepo using npm workspaces under the `agentic-framework/` directory.

- `agentic-framework/packages/core`: The foundation of the system. Contains all shared types, interfaces, and core logic for item lifecycle and state management.
- `agentic-framework/packages/cli`: A command-line interface that allows developers and agents to interact with the framework (create items, update status, etc.).
- `agentic-framework/packages/server`: The central API server built with Express. It manages the `db.json` storage and broadcasts updates via WebSockets.
- `agentic-framework/packages/storage-json`: A storage plugin implementing atomic, file-based JSON persistence.
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
    - **Intermediate Steps (REVIEW, TEST, etc.)**: Advanced via `validate_progress`. Before calling it, agents call `workflow_gatekeeper(role="validating")` to receive the current step's `exitCriteria`. `validate_progress` runs an agent-chosen command (or `verifyCommand` on the final step) to gate advancement.
    - **Exit Criteria**: Free-text conditions on each `FlowStep`. Surfaced by the gatekeeper in `role="validating"` responses so agents know what to satisfy before calling `validate_progress`.
    - **Coverage Rule**: Newly inserted code MUST meet a minimum threshold (e.g., 80%). The specific implementation of this check (e.g., parsing Vitest vs Jest outputs) is project-specific. For the AgenFK Framework itself, a helper script at `scripts/enforce-coverage.ts` is provided to perform this check against Vitest output.
    - **DONE Status**: Only reachable via `validate_progress` at the final intermediate step. Direct `update_item({ status: "DONE" })` is blocked by the server.

## Multi-Agent Orchestration
AgenFK features an automated orchestration layer where the primary agent acts as a supervisor, automatically spawning specialized sub-agents at each phase transition using the `task` tool:

1.  **Planning Agent (TODO Phase)**:
    - **Trigger**: New user request or creation of an EPIC/STORY.
    - **Protocol**: Decomposes request into `TODO` sub-items and **PAUSES** for human approval.
2.  **Coding Agent (IN_PROGRESS Phase)**:
    - **Trigger**: Human approval of the plan.
    - **Protocol**: Implements the plan and calls `update_item({ status: "REVIEW" })` to signal coding is done, then calls `workflow_gatekeeper(role="validating")` followed by `validate_progress` to transition to `TEST`.
3.  **Review Agent (REVIEW Phase)**:
    - **Trigger**: Automatic spawn when item enters REVIEW.
    - **Protocol**: Calls `workflow_gatekeeper(role="validating")` to read exit criteria, audits code for security and requirements, then calls `validate_progress` to advance to `TEST`.
4.  **Testing Agent (TEST Phase)**:
    - **Trigger**: Automatic spawn after successful review.
    - **Protocol**: Calls `workflow_gatekeeper(role="validating")` to read exit criteria, generates tests and verifies 80% coverage, then calls `validate_progress` (uses `verifyCommand`) to move item to `DONE`.
5.  **Closing Agent (DONE Phase)**:
    - **Trigger**: Automatic spawn after successful testing.
    - **Protocol**: Collates progress logs, writes the final summary comment, and prompts the user for the next action: Release, New Task (calls `/clear` and `/agenfk`), or Continue Current.

This automation ensures consistent engineering rigor while minimizing human micro-management.

## Supported AI Clients

AgenFK supports three AI coding assistants. Each integrates with the same MCP server but uses a different mechanism for workflow enforcement:

| Client | MCP Registration | Workflow Rules | Enforcement Model |
|--------|-----------------|----------------|-------------------|
| **Claude Code** | `claude mcp add` (user scope) | `~/.claude/CLAUDE.md` | **Mechanical** — two PreToolUse hooks: `agenfk-gatekeeper` (blocks edits without IN_PROGRESS task) and `agenfk-mcp-enforcer` (blocks db/REST/CLI bypass routes) |
| **OpenCode** | `~/.config/opencode/opencode.json` | `~/.config/opencode/skills/agenfk/SKILL.md` | **Mechanical** — `tool.execute.before` plugin (`agenfk-mcp-enforcer-opencode.mjs`) intercepting tool calls before execution |
| **Cursor** | `~/.cursor/mcp.json` (Linux/macOS) or `%APPDATA%\Cursor\mcp.json` (Windows) | `~/.cursor/rules/agenfk.mdc` (Linux/macOS) or `%APPDATA%\Cursor\rules\agenfk.mdc` (Windows) | **Instructional** — Cursor has no PreToolUse hook or plugin system. Enforcement relies on the `workflow_gatekeeper` MCP tool called per instruction in `agenfk.mdc`. The model is expected to follow rules; no mechanical trip-wire exists. |

### Enforcement Gap (Cursor)

Claude Code and OpenCode provide *mechanical* enforcement: a hook fires before every tool call and can hard-block it regardless of model intent. Cursor provides no equivalent interception point. AgenFK's Cursor integration compensates with:

1. **`alwaysApply: true` in `agenfk.mdc`** — the rule is auto-attached to every conversation, maximising the chance the model sees it.
2. **Explicit breach-handling instructions** — `agenfk.mdc` instructs the model to stop and resolve a gatekeeper rejection before proceeding, not to silently skip it.
3. **`workflow_gatekeeper` MCP tool** — the server-side check still verifies that a valid IN_PROGRESS task exists and logs the authorization intent, providing an audit trail even without a mechanical block.

## Tech Stack
- **Language**: TypeScript (Strong typing across the stack)
- **Backend**: Node.js, Express, Socket.io
- **Frontend**: React, Vite, Tailwind CSS, TanStack Query
- **Storage**: JSON or SQLite (configurable at install time via `~/.agenfk/config.json`, switchable at runtime with `agenfk db switch`)
- **Communication**: REST API, WebSockets, MCP
