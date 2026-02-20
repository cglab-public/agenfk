# AgenFK Engineering Framework (AEF) - Project Plan

## Objective
Create a framework for AI-assisted software engineering that enforces an Agile, measurable, visual, repeatable, reliable, and flexible workflow.

## Key Features
*   **Agile Workflow:** Epics, Stories, Tasks, Bugs.
*   **Measurability:** Track token usage (input/output) and model per item.
*   **Visualization:** Timeline, Kanban, Metric charts.
*   **Repeatability:** Deterministic tools, prompt templates, RAG.
*   **Reliability:** CI/CD integration, Unit Tests, Code Reviews.
*   **Flexibility:** Plugin architecture, support for multiple AI platforms (Opencode, Claude, etc.).

## Phase 1: Foundation & Core Architecture (The Engine) - COMPLETED
**Goal:** Establish the plugin system, data models, and CLI.

1.  **Project Initialization:** (Done)
    *   Monorepo structure (`packages/core`, `packages/cli`, `packages/server`, `packages/ui`).
    *   Stack: TypeScript, Node.js, JSON Storage (pivoted from SQLite for portability).

2.  **Core Domain Modeling:** (Done)
    *   Entities: `Epic`, `Story`, `Task`, `Bug` with `tokenUsage` and `context`.
    *   Plugin Interface: `StorageProvider`, `TokenTracker`, `LLMProvider`.

3.  **Implementation - Iteration 1:** (Done)
    *   `packages/core`: Interfaces and Plugin Manager.
    *   `packages/storage-json`: JSON file-based implementation of `StorageProvider`.
    *   `packages/cli`: CLI tool (`agenfk`) for `init`, `create`, `list`, `update`, `delete`, `up`, `ui`.

## Phase 2: Measurability & Connectivity (The Brain) - COMPLETED
**Goal:** Connect to AI tools and track metrics.

1.  **MCP Server:** (Done)
    *   Expose tools (`create_item`, `update_item`, `list_items`, `get_item`) via Model Context Protocol.
    *   Implemented in `packages/server`.
    *   Supports stdio transport.

2.  **Token Tracking & Context:** (Done)
    *   Added `log_token_usage` tool to MCP server.
    *   Added `add_context` tool to MCP server.
    *   Allows agents to self-report usage and attach context.

## Phase 3: Visualization & Workflow (The Eyes) - COMPLETED
**Goal:** Visual interface for oversight.

1.  **Web Dashboard:** (Done)
    *   React/Vite app in `packages/ui`.
    *   Kanban Board implemented (`KanbanBoard.tsx`).
    *   API layer connected to `packages/server` (REST).
    *   Tailwind CSS for styling.
    *   Builds successfully.

2.  **Server Updates:** (Done)
    *   Upgraded `packages/server` to include Express.
    *   Exposed REST API endpoints (`GET/POST/PUT/DELETE /items`).

3.  **Documentation & Branding:** (Done)
    *   Global rename to **AgenFK**.
    *   Custom SVG Logo implementation.
    *   Comprehensive `README.md` with architecture and installation guides.

**Project Status:**
All planned phases (Foundation, Measurability, Visualization) are complete for the MVP. The framework is now functional with:
*   CLI for command-line ops.
*   MCP for AI agents.
*   Web UI for human oversight.
*   JSON storage for portability.
*   Enforced verification workflows.


**Goal:** Visual interface for oversight.

1.  **Web Dashboard:**
    *   React/Vite app.
    *   Kanban, Timeline, Metrics views.
    *   Real-time updates.

## Technical Architecture

### Monorepo Structure
*   `packages/core`: Shared interfaces, types, and logic.
*   `packages/cli`: Command-line interface.
*   `packages/server`: MCP and API server.
*   `packages/ui`: Web dashboard.
*   `packages/storage-sqlite`: Default storage plugin.

### Data Model
*   **Epic:** High-level feature.
*   **Story:** User story within an Epic.
*   **Task:** Actionable unit of work.
*   **Bug:** Defect report.
*   **Common Fields:** `id`, `title`, `description`, `status`, `tokenUsage`, `context`.
