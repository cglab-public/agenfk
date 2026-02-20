---
name: agenfk
description: Agile, measurable, and reliable workflow enforcement for AI-assisted engineering.
compatibility: opencode
metadata:
  framework: agenfk
  workflow: agile
---

# Agentic Engineering Framework (agenfk)

This skill enforces the core Agentic Engineering workflow to ensure all software tasks are Agile, Measurable, Visual, Repeatable, Reliable, and Flexible.

## What I do

1.  **Initialization**
    *   **Action**: Scan the codebase and generate `AFK_PROJECT_SCOPE.md` (project objective) and `AFK_ARCHITECTURE.md` (structure, components, dependencies) if they don't exist.
    *   **Objective**: Maintain a living map of the project.

2.  **Request Analysis**
    *   **Action**: Call `analyze_request(request: string)` for every new user requirement.
    *   **Objective**: Categorize as **EPIC**, **STORY**, **TASK**, or **BUG**. Ask for clarification if ambiguous.

3.  **Planning (Epics only)**
    *   **Action**: Require or generate a detailed Markdown **Implementation Plan**.
    *   **Objective**: Ensure clear roadmaps for large features. Save in the `implementationPlan` field.

4.  **Action Authorization (Gatekeeper)**
    *   **Action**: Call `workflow_gatekeeper(intent: string)` BEFORE any code change.
    *   **Requirement**: Exactly one task must be `IN_PROGRESS`. Rectify if not.

5.  **Measurement & Tracking**
    *   **Reporting**: Call `log_token_usage(itemId, input, output, model)` for every unit of work.
    *   **Completion**: Move tasks to `DONE` and update parents when finished.

## When to use me

Use this skill whenever you are performing software engineering tasks to ensure compliance with the Agentic Engineering Framework.

## Available Tools (MCP: agentic)

*   `create_item`: Create a new workflow item.
*   `update_item`: Update status or properties.
*   `list_items`: Query the backlog.
*   `get_item`: Get full details.
*   `log_token_usage`: Record resource consumption.
*   `add_context`: Attach relevant file paths.
*   `analyze_request`: Categorization strategy.
*   `workflow_gatekeeper`: Pre-flight authorization.
*   `get_server_info`: Framework health check.
