# AFK Architecture: AgenFK Framework

## System Overview
AgenFK follows a **Single Owner Architecture** where a centralized API server manages the framework state, ensuring consistency across CLI, UI, and MCP clients.

## Project Structure (Monorepo)
The project is organized as a TypeScript monorepo using npm workspaces under the `agentic-framework/` directory.

- `agentic-framework/packages/core`: The foundation of the system. Contains all shared types, interfaces, and core logic for item lifecycle and state management.
- `agentic-framework/packages/cli`: A command-line interface that allows developers and agents to interact with the framework (create items, update status, etc.).
- `agentic-framework/packages/server`: The central API server built with Express. It manages the `db.json` storage and broadcasts updates via WebSockets.
- `agentic-framework/packages/storage-json`: A storage plugin implementing atomic, file-based JSON persistence.
- `agentic-framework/packages/ui`: A modern web-based Kanban board built with React, Vite, Tailwind CSS, and TanStack Query.

## Key Component Interactions
1.  **Server as Source of Truth**: All state changes must go through the Server.
2.  **CLI/UI as Clients**: The CLI and Web UI communicate with the Server via a RESTful API.
3.  **Real-time Updates**: The Server uses WebSockets to push state changes to the UI for immediate visual feedback.
4.  **Planning Phase (Complex Items)**:
    - For items identified as EPIC or STORY, the system enforces a decomposition step.
    - All sub-items (Stories/Tasks) are created in `TODO` status first.
    - The Agent MUST obtain explicit user approval of the decomposition before transitioning any child item to `IN_PROGRESS`.
5.  **Verification Loop**:
    - **REVIEW Status**: Triggered via `verify_changes` tool. MUST run the project's primary test suite (not just builds).
    - **TEST Status**: A mandatory quality gate following Review. In this stage, the Agent (e.g., Opencode/Claude) is responsible for running deep regression tests and verifying coverage requirements (minimum 80% for new code).
    - **Coverage Rule**: Newly inserted code MUST meet a minimum threshold (e.g., 80%). The specific implementation of this check (e.g., parsing Vitest vs Jest outputs) is project-specific. For the AgenFK Framework itself, a helper script at `scripts/enforce-coverage.ts` is provided to perform this check against Vitest output.
    - **DONE Status**: Only reachable after passing both Review and Test gates.

## Multi-Agent Orchestration
AgenFK supports specialized agents for different lifecycle phases. Handover is managed via status transitions and tool-mediated spawning:

1.  **Planning Agent (TODO Phase)**:
    - **Trigger**: New user request or creation of an EPIC/STORY.
    - **Responsibility**: Scans codebase and context to decompose the request into granular sub-items.
    - **Handover**: Creates child items in `TODO` status and pauses for human approval.
2.  **Coding Agent (IN_PROGRESS Phase)**:
    - **Trigger**: Item transition to `IN_PROGRESS`.
    - **Responsibility**: Executes the implementation plan, writes code, and logs progress comments.
    - **Handover**: Calls `verify_changes` to transition to `REVIEW`.
3.  **Review Agent (REVIEW Phase)**:
    - **Trigger**: `verify_changes` call (auto-transition to `REVIEW`).
    - **Responsibility**: Scans changes for security vulnerabilities, linting errors, and architectural alignment.
    - **Handover**: Successfully completing the review moves the item to `TEST`.
4.  **Testing Agent (TEST Phase)**:
    - **Trigger**: Transition to `TEST`.
    - **Responsibility**: Generates new tests, runs the suite, and verifies 80% coverage.
    - **Handover**: Successful verification allows the transition to `DONE`.
5.  **Closing Agent (DONE Phase)**:
    - **Trigger**: Transition to `DONE`.
    - **Responsibility**: Summarizes work performed and logs a final descriptive comment on the card.

## Tech Stack
- **Language**: TypeScript (Strong typing across the stack)
- **Backend**: Node.js, Express, Socket.io
- **Frontend**: React, Vite, Tailwind CSS, TanStack Query
- **Storage**: JSON (local/portable)
- **Communication**: REST API, WebSockets, MCP
