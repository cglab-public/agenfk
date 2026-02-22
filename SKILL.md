---
name: agenfk
description: Agile, measurable, and reliable workflow enforcement for AI-assisted engineering.
compatibility: opencode
metadata:
  framework: agenfk
  workflow: agile
---

# AgenFK Engineering Framework (agenfk)

This skill enforces the core AgenFK Engineering workflow to ensure all software tasks are Agile, Measurable, Visual, Repeatable, Reliable, and Flexible.

## Operation Modes

AgenFK supports two distinct operation modes based on the slash command invoked:

### 1. Standard Mode (via `/agenfk`)
*   **Behavior**: Single-agent, proactive execution.
*   **Workflow**: The agent who starts the task is responsible for the entire lifecycle (Planning, Coding, Verification, and Closing) within a single session.
*   **Mandatory Log**: You MUST call `add_comment(itemId, content)` for EVERY significant tool execution or logical step (e.g. "Analyzed file X", "Implemented function Y", "Running tests").
*   **Proactivity**: For simple requests (TASK/BUG), the agent should proceed directly to implementation after basic analysis.
*   **Verification**: You MUST use `verify_changes` to run tests before closing.
*   **Decomposition**: Optional. If the task is simple, do not decompose into sub-items unless it provides significant organizational value.
*   **Handoff**: None. Do not spawn sub-agents.

### 2. Deep Mode (via `/agenfk-deep`)
*   **Behavior**: Multi-agent, automated orchestration.
*   **Trigger**: Use this mode for complex architectural changes, high-security code, or large features.
*   **Supervisor Pattern**: You act as a supervisor, responsible for decomposing the task and spawning specialized sub-agents via the `task` tool at every phase transition.
*   **Parallel Execution**: Deep Mode supports **parallel execution** of independent tasks.
    - If an EPIC or STORY has multiple independent sub-items, you SHOULD spawn multiple sub-agents simultaneously using the `task` tool.
    - When working in parallel, you MUST pass the `itemId` to the `workflow_gatekeeper(intent, role, itemId)` to authorize changes against the specific task.
*   **Plan & Pause**: Mandatory decomposition into sub-items. You **MUST PAUSE** and obtain human approval of the plan before moving any item to `IN_PROGRESS`.
*   **Automated Handover**:
    - **Coding to Review**: Automatically spawn a "Review Agent" after `verify_changes`.
    - **Review to Test**: Automatically spawn a "Test Agent" after successful review.
    - **Test to Done**: Automatically spawn a "Closing Agent" after successful testing.

---

## What I do

1.  **Initialization**
    *   **Action**:
        1. Check for `.agenfk/project.json` in the project root.
        2. If missing, DO NOT assume an existing project should be reused based on name alone.
        3. Call `list_projects()` via MCP to see existing projects.
        4. **MANDATORY**: Ask the user if they want to use an existing project (by name/ID) or create a new one (recommended).
        5. If creating a new one, use the current directory name as the default project name unless the user specifies otherwise.
        6. Create/link the project by creating `.agenfk/project.json` with the `{ "projectId": "..." }`.
        7. Scan the codebase and generate `AFK_PROJECT_SCOPE.md` and `AFK_ARCHITECTURE.md` if they don't exist. BE THOROUGH AND COMPLETE. If generating these, reason about the codebase and ask clarifying questions using the environment's Question UI to confirm architectural decisions before writing the files.
        8. Fetch all items via `list_items(projectId)` and render the **Board Report** as described below.
    *   **Board Report Format**:
        *   **Cycle Time Calculation**: For each item, compute cycle time as `updatedAt - createdAt`. Format durations as `HH:MM:SS`. For DONE/ARCHIVED items this represents total elapsed time. For active items (TODO, IN_PROGRESS, BLOCKED) it represents age.
        *   **Per-card display**: Include a `Cycle Time` column in every status group table.
        *   **Summary Header**: Show a metrics line with:
            - Total token usage (sum of all `tokenUsage[].input + tokenUsage[].output` across all items)
            - Total cycle time (sum of cycle times of all DONE items, formatted as `HH:MM:SS`)
            - Average cycle time across DONE items (total ÷ count, formatted as `HH:MM:SS`)
            - Format: `Tokens: X in / Y out | Cycle Total: HH:MM:SS | Cycle Avg: HH:MM:SS (N tasks)`
    *   **Objective**: Maintain project identity and a living map.

2.  **Request Analysis & Clarification**
    *   **Context**: Take into account `AFK_PROJECT_SCOPE.md` and `AFK_ARCHITECTURE.md` for informed reasoning.
    *   **Action**: Call `analyze_request(request: string)` for every new user requirement.
    *   **Mode Selection**: 
        - If the user invoked `/agenfk`, use **Standard Mode**.
        - If the user invoked `/agenfk-deep`, use **Deep Mode**.
    *   **Reasoning Step**: Before creating ANY item or initializing a project, you MUST reason about the implementation details. 
    *   **Question UI**: If there are *any* ambiguities, missing technical details, or decisions to be made, you MUST use the environment's native "Question UI" (e.g., `default_api:question` in Opencode, or equivalent in other environments) to ask the user for clarification before proceeding with creation.
    *   **Objective**: Categorize as **EPIC**, **STORY**, **TASK**, or **BUG**.
    *   **Requirement**: All items created must be associated with the active `projectId`.
    *   **Transparency**: If you're opencode, display every MCP call parameter and return value.
    *   **Conventional Commits**: Use standard prefixes for all commits: `fix:`, `feat:`, `chore:`, `docs:`, `style:`, `refactor:`, `perf:`, `test:`. NEVER use `close:`, `update:`, or other non-standard prefixes. Append the item ID in brackets if relevant, e.g., `fix: resolve crash [id]`.

3.  **Planning (Epics only)**
    *   **Action**: Require or generate a detailed Markdown **Implementation Plan**.
    *   **Objective**: Ensure clear roadmaps for large features. Save in the `implementationPlan` field.

4.  **Action Authorization (Gatekeeper)**
    *   **Action**: Call `workflow_gatekeeper(intent: string, role: string)` BEFORE any code change.
    *   **Mandatory Roles**: You MUST specify your current role: `planning`, `coding`, `review`, `testing`, or `closing`.
    *   **Mechanical Enforcement**: The gatekeeper will reject authorization if your `role` does not match the status of the active task (e.g., `role="coding"` requires status `IN_PROGRESS`).
    *   **CRITICAL**: Always use MCP tools (`create_item`, `update_item`, `verify_changes`, `log_token_usage`) for ALL workflow state changes. **Never use the `agenfk` CLI to create items, update status, or close tasks.** The CLI bypasses the enforcement layer built into the MCP server.

5.  **Mandatory Automated Testing (Agent Driven)**
    *   **Action**: Moving an item to the `TEST` column (status: `TEST`) is a signal that the Agent (Opencode/Claude) must now perform deep verification.
    *   **Requirement**: The Agent MUST run the project's test suite (e.g., `npm run test:coverage`) using its local tools.
    *   **Coverage Rule**: New code MUST be covered at 80% minimum.
    *   **Workflow**: 
        *   The `verify_changes` tool automatically moves items from `REVIEW` to `TEST` upon success.
        *   The Agent verifies coverage and regressions in `TEST`.
        *   Success: Agent moves item to `DONE`.
        *   Failure: Agent moves item back to `IN_PROGRESS`.

6.  **Final Verification (Review Tool)**
    *   **Action**: BEFORE moving to `TEST`, the Agent **MUST** use the `verify_changes(itemId, command)` tool.
    *   **Mandatory Tests**: The `command` passed to `verify_changes` MUST include the project's primary testing solution (e.g., `npm test`, `pytest`, `go test`). Simple builds (`npm run build`) are NOT sufficient. The Agent must perform stack detection (e.g., checking `package.json`, `requirements.txt`, `go.mod`) to identify the correct test command.
    *   **Transition Logic (Automated by Tool)**:
        1. The tool moves the item to `REVIEW`.
        2. The tool executes the command.
        3. Success: Moves to `TEST`. Failure: Moves back to `IN_PROGRESS`.

7.  **Measurement & Tracking**
    *   **Reporting Requirements**: The Agent **MUST** call `log_token_usage(itemId, input, output, model)` immediately after marking an item as `DONE` (e.g., following a successful `verify_changes`), or at the end of a significant session of work for an `IN_PROGRESS` item.
    *   **Progress Comments**: The Agent **MUST** call `add_comment(itemId, content)` for EVERY significant step performed during implementation (e.g. "Modified core types", "Updated UI components", "Ran tests"). This ensures the human user can follow the agent's work in real-time on the Kanban board.
    *   **Estimation**: If exact token counts are not available in the environment, the Agent **MUST** provide a reasonable estimate. **Do not skip this step.**
    *   **Completion**: Update parent Story/Epic status automatically.

## When to use me

Use this skill whenever you are performing software engineering tasks to ensure compliance with the AgenFK Engineering Framework.

## Available Tools (MCP: agenfk)

*   `list_projects`: List all existing projects.
*   `create_project`: Create a new project.
*   `create_item`: Create a new workflow item (requires `projectId`).
*   `update_item`: Update status or properties.
*   `list_items`: Query the backlog (filter by `projectId`).
*   `get_item`: Get full details.
*   `log_token_usage`: Record resource consumption.
*   `add_context`: Attach relevant file paths.
*   `analyze_request`: Categorization strategy.
*   `workflow_gatekeeper`: Pre-flight authorization and role verification.
*   `verify_changes`: Execute dynamic syntax/build checks and update status.
*   `get_server_info`: Framework health check.
