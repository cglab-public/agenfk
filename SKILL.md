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

## What I do

1.  **Initialization**
    *   **Action**:
        1. Check for `.agenfk/project.json` in the project root.
        2. If missing, call `list_projects()` via MCP to see existing projects.
        3. Ask the user if they want to use an existing project or create a new one (recommended).
        4. Create/link the project by creating `.agenfk/project.json` with the `{ "projectId": "..." }`.
        5. Scan the codebase and generate `AFK_PROJECT_SCOPE.md` and `AFK_ARCHITECTURE.md` if they don't exist. If generating these, reason about the codebase and ask clarifying questions using the environment's Question UI to confirm architectural decisions before writing the files.
        6. Fetch all items via `list_items(projectId)` and render the **Board Report** as described below.
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
    *   **Action**: Call `analyze_request(request: string)` for every new user requirement.
    *   **Reasoning Step**: Before creating ANY item (Epic, Story, Task, or Bug) or initializing a project, you MUST reason about the implementation details. 
    *   **Question UI**: If there are *any* ambiguities, missing technical details, or decisions to be made, you MUST use the environment's native "Question UI" (e.g., `default_api:question` in Opencode, or equivalent in other environments) to ask the user for clarification before proceeding with creation.
    *   **Objective**: Categorize as **EPIC**, **STORY**, **TASK**, or **BUG**.
    *   **Requirement**: All items created must be associated with the active `projectId`.

3.  **Planning (Epics only)**
    *   **Action**: Require or generate a detailed Markdown **Implementation Plan**.
    *   **Objective**: Ensure clear roadmaps for large features. Save in the `implementationPlan` field.

4.  **Action Authorization (Gatekeeper)**
    *   **Action**: Call `workflow_gatekeeper(intent: string)` BEFORE any code change.
    *   **Requirement**: Exactly one task must be `IN_PROGRESS` for the active project.
    *   **CRITICAL**: Always use MCP tools (`create_item`, `update_item`, `verify_changes`, `log_token_usage`) for ALL workflow state changes. **Never use the `agenfk` CLI to create items, update status, or close tasks.** The CLI bypasses the enforcement layer built into the MCP server.

5.  **Mandatory Automated Testing**
    *   **Action**: Moving an item to the `TEST` column (status: `TEST`) triggers an automated verification run on the server.
    *   **Enforcement**: The server executes `npm run test:coverage` (or a configured command) and parses the output.
    *   **Coverage Rule**: New code MUST be covered at 80% minimum.
    *   **Automation**: 
        *   Success: Item moves automatically to `REVIEW`.
        *   Failure: Item moves back to `IN_PROGRESS` with logs attached to `reviews`.

6.  **Final Verification (Review)**
    *   **Action**: BEFORE declaring an item as `DONE` (if code was modified), the Agent **MUST** use the `verify_changes(itemId, command)` tool.
    *   **Review Rules**:
        *   **TASKS**: Always require individual verification.
        *   **STORIES with sub-tasks**: Implicitly verified when all children are `DONE`.
        *   **STORIES without sub-tasks**: Require manual verification via `verify_changes`.
    *   **Transition Logic (Automated by Tool)**:
        1. The tool moves the item to `REVIEW`.
        2. The tool executes the command.
        3. Success: Moves to `DONE`. Failure: Moves back to `IN_PROGRESS`.

7.  **Measurement & Tracking**
    *   **Reporting Requirements**: The Agent **MUST** call `log_token_usage(itemId, input, output, model)` immediately after marking an item as `DONE` (e.g., following a successful `verify_changes`), or at the end of a significant session of work for an `IN_PROGRESS` item.
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
*   `workflow_gatekeeper`: Pre-flight authorization.
*   `verify_changes`: Execute dynamic syntax/build checks and update status.
*   `get_server_info`: Framework health check.
