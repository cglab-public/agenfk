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
*   **Verification**: You MUST use `review_changes` (IN_PROGRESS → REVIEW) and `test_changes` (TEST → DONE) to progress items.
*   **Decomposition**: MANDATORY. Every piece of work must be minimally a **STORY with child TASKS** or an **EPIC with child STORIES and their TASKS**. Direct coding on a STORY or EPIC without child TASKS is prohibited.
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
    - **Coding to Review**: Automatically spawn a "Review Agent" after `review_changes`.
    - **Review to Test**: Automatically spawn a "Test Agent" after successful review.
    - **Test to Done**: Automatically spawn a "Closing Agent" after successful testing.

---

## MCP Access Rules — MANDATORY

**ALWAYS** use MCP tool invocations (`list_items`, `create_item`, `update_item`, `get_item`, etc.) for all workflow state operations.

**NEVER** use any of the following shortcuts — PreToolUse hooks will block them mechanically:

| Forbidden | Use instead |
|-----------|-------------|
| Reading `.agenfk/db.sqlite` or `.agenfk/db.json` directly (via Bash or Read tool) | `list_items(projectId)` · `get_item(id)` |
| `curl` / `wget` to `http://localhost:3000` (direct REST API) | `list_items()` · `create_item()` · `update_item()` |
| `agenfk list`, `agenfk status`, `agenfk get`, `npx agenfk ...` (CLI state queries) | `list_items()` · `get_item()` · `list_projects()` |

If MCP tools are not available in your context, surface the connectivity problem clearly rather than falling back to a bypass route.

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
    *   **Action**: Call `analyze_request(request: string)` for every new user requirement.
    *   **Mode Selection**:
        - If the user invoked `/agenfk`, use **Standard Mode**.
        - If the user invoked `/agenfk-deep`, use **Deep Mode**.
    *   **Reasoning Step**: Before creating ANY item or initializing a project, you MUST reason about the implementation details.
    *   **Question UI**: If there are *any* ambiguities, missing technical details, or decisions to be made, you MUST use the environment's native "Question UI" (e.g., `default_api:question` in Opencode, or equivalent in other environments) to ask the user for clarification before proceeding with creation.
    *   **Objective**: Categorize as **EPIC**, **STORY**, **TASK**, or **BUG**.
    *   **Minimum Decomposition Rule**: After exiting plan mode, the type of card that needs to be created is minimally a **STORY with sub-TASKS** or an **EPIC with sub-STORIES and their sub-TASKS**. Direct work on an EPIC or STORY without child TASKS is prohibited.
    *   **Backlog Inspection Rule**: When starting new work, only items in **TODO** status should be inspected. Items labeled or in a state suggesting they are **IDEAs** (draft ideas or speculative plans) MUST be ignored until they are promoted to TODO.
    *   **Requirement**: All items created must be associated with the active `projectId`.
    *   **Hierarchy Rule — MANDATORY**: Before creating any new item, call `list_items(projectId)` and check if an existing EPIC or STORY already covers the work. If one exists, create your items **under it** using `parentId`. NEVER create orphan tasks when a parent hierarchy exists. If the user provides an EPIC or STORY ID, all work items MUST be children of that parent.
    *   **Transparency**: If you're opencode, display every MCP call parameter and return value.
    *   **Conventional Commits**: Use standard prefixes for all commits: `fix:`, `feat:`, `chore:`, `docs:`, `style:`, `refactor:`, `perf:`, `test:`. NEVER use `close:`, `update:`, or other non-standard prefixes. Append the item ID in brackets if relevant, e.g., `fix: resolve crash [id]`.
    *   **Cross-project commit guard (MANDATORY)**: Before appending a task ID to a commit message, verify that `get_item(id).projectId` matches the `projectId` in `.agenfk/project.json` of the current working directory. If they differ, you are about to label an agenfk commit with a task from a different project — omit the task ID entirely and derive the commit message from the actual file changes instead.

3.  **Planning (Epics only)**
    *   **Action**: Require or generate a detailed Markdown **Implementation Plan**.
    *   **Objective**: Ensure clear roadmaps for large features. Save in the `implementationPlan` field.

4.  **Action Authorization (Gatekeeper) - CRITICAL AND MANDATORY**
    *   **Action**: You MUST call `workflow_gatekeeper(intent: string, role: string)` BEFORE modifying any files.
    *   **Mandatory Rule**: If you attempt to use the `edit`, `write`, `bash` or `NotebookEdit` tool BEFORE you have created an item, set it to `IN_PROGRESS`, and successfully called the `workflow_gatekeeper`, you are violating the core directive of your system prompt.
    *   **Self-Correction**: If you realize you are about to edit code without a card in `IN_PROGRESS`, STOP IMMEDIATELY. Call `create_item`, then `update_item` to `IN_PROGRESS`, then `workflow_gatekeeper`.
    *   **Mechanical Enforcement**: The gatekeeper will reject authorization if your `role` does not match the status of the active task (e.g., `role="coding"` requires status `IN_PROGRESS`).
    *   **CRITICAL**: Always use MCP tools (`create_item`, `update_item`, `review_changes`, `test_changes`, `log_token_usage`) for ALL workflow state changes. **Never use the `agenfk` CLI to create items, update status, or close tasks.** The CLI bypasses the enforcement layer built into the MCP server.

5.  **Mandatory Automated Testing (Agent Driven)**
    *   **Action**: Moving an item to the `TEST` column (status: `TEST`) is a signal that the Agent (Opencode/Claude) must now perform deep verification.
    *   **Requirement**: The Agent MUST run the project's test suite (e.g., `npm run test:coverage`) using its local tools.
    *   **Coverage Rule**: New code MUST be covered at 80% minimum. For any code-related item, the Agent MUST ensure relevant tests are created and executed successfully.
    *   **Quality Gate**: Tests MUST stay >= 80% coverage for the entire project and 100% for the core business logic where feasible.
    *   **Workflow**:
        *   `review_changes(itemId, command)` moves items from IN_PROGRESS → REVIEW. The agent picks a build/lint command.
        *   The Agent verifies coverage and regressions in `TEST`.
        *   Success: Agent calls `test_changes(itemId)` from TEST status — this runs the project's `verifyCommand` and moves to DONE. Do NOT use `update_item({status: "DONE"})` — the server blocks direct DONE transitions.
        *   Failure: Agent moves item back to `IN_PROGRESS`.
    *   **Sibling Propagation**: When child items of the same parent share the same source code, a single `review_changes` or `test_changes` call validates the code for all siblings. After one passes, move remaining siblings directly to TEST via `update_item` (skipping individual `review_changes`), then call `test_changes` on each to reach DONE.

6.  **Final Verification (Review Tool)**
    *   **Action**: BEFORE moving to `TEST`, the Agent **MUST** use `review_changes(itemId, command)` with a build/lint command to move to REVIEW.
    *   **Test Suite Enforcement**: The project's `verifyCommand` (set via `update_project`) defines the mandatory test command. `test_changes` always uses it — agents cannot override or bypass it.
    *   **Transition Logic (Automated by Tool)**:
        1. The tool moves the item to `REVIEW`.
        2. The tool executes the command.
        3. Success: Moves to `TEST`. Failure: Moves back to `IN_PROGRESS`.

7.  **Measurement & Tracking**
    *   **Reporting Requirements**: The Agent **MUST** call `log_token_usage(itemId, input, output, model)` immediately after marking an item as `DONE` (e.g., following a successful `test_changes`), or at the end of a significant session of work for an `IN_PROGRESS` item.
    *   **Progress Comments**: The Agent **MUST** call `add_comment(itemId, content)` for EVERY significant step performed during implementation (e.g. "Modified core types", "Updated UI components", "Ran tests"). This ensures the human user can follow the agent's work in real-time on the Kanban board.
    *   **Estimation**: If exact token counts are not available in the environment, the Agent **MUST** provide a reasonable estimate. **Do not skip this step.**
    *   **Completion — Bottom-Up Closure (MANDATORY)**: When closing work, you MUST close the entire hierarchy bottom-up:
        1. Close all child TASKs first: `review_changes` (IN_PROGRESS→REVIEW), self-review (REVIEW→TEST), then `test_changes` from TEST (TEST→DONE).
           - **Sibling shortcut**: If one child's `review_changes` already passed, remaining siblings can skip to TEST via `update_item({ status: "TEST" })`. Then call `test_changes` on each — subsequent calls pass immediately since the code is already verified.
        2. Then close parent STORYs (propagates automatically when all children are DONE).
        3. Then close the EPIC (propagates automatically when all STORYs are DONE).
        NEVER leave cards stuck in REVIEW. If `review_changes` moves an item to REVIEW, you are responsible for progressing it through TEST → DONE. A card in REVIEW is NOT "done".
        NEVER use `update_item({status: "DONE"})` — the server rejects direct DONE transitions. Always use `test_changes` from TEST status to close an item.
    *   **Post-Completion Prompt (MANDATORY)**: After an item (TASK, STORY, BUG, or EPIC) has been moved to `DONE`, the Agent **MUST** ask the user what they would like to do next, providing exactly these three options:
        1. **Release**: Run `/agenfk-release` to create a new release.
        2. **New Task**: Start a new session for a new task, epic, or bug (by calling `/clear` followed by `/agenfk`).
        3. **Continue Current**: Keep working on the current item (the Agent MUST then ask what else should be included and move the item back to `IN_PROGRESS`).

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
*   `review_changes`: Agent-driven review check (IN_PROGRESS → REVIEW).
*   `test_changes`: Enforced test suite execution (TEST → DONE).
*   `get_server_info`: Framework health check.
