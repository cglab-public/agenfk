---
description: Run a task using full Multi-Agent Orchestration (Deep Mode)
---

Load the `agenfk` skill. Run its Initialization protocol if needed.
Identify the user's request and follow the **Deep Mode** protocol in the skill:
1. Decompose the request into sub-items.
   - **MANDATORY**: For **EPICs** and **STORIES**, you **MUST** decompose the request into all constituent child items (using `create_item` with `parentId`) **BEFORE** starting work on the first task.
2. Identify independent tasks that can be performed in parallel.
3. PAUSE for human approval of the plan.
4. Upon approval, begin the automated lifecycle (Code -> Review -> Test -> Close) by spawning specialized sub-agents.
5. **Parallelism**: If multiple independent tasks exist, spawn multiple agents simultaneously using the `task` tool. Ensure each sub-agent is passed its specific `itemId` to authorize changes via `workflow_gatekeeper`.
6. **Branch verification**: Each sub-agent MUST verify it is on the correct item branch (`git branch --show-current`) before writing any code. If the item has a `branchName` and the agent is not on it, run `git checkout <branchName>` first. **Never code on the wrong branch.**

---

## Parent-Child Status Propagation Rule

**MANDATORY**: A parent item (EPIC or STORY) can ONLY move forward in the workflow (e.g., TODO → IN_PROGRESS, IN_PROGRESS → REVIEW, TEST → DONE) once **ALL** of its child items have also moved to that same state or further.

## Sibling Propagation Rule

When child items of the same parent share the same source code (same branch/workspace), a single `validate_progress` call validates the code for **all** siblings:

- After `validate_progress` passes on **one** sibling (advancing it to the next step), call `validate_progress` on remaining siblings — the server's sibling propagation detects the already-advanced sibling and skips command execution, passing immediately.
- For the final step (→ DONE): call `validate_progress` on each remaining sibling — the server's sibling propagation will skip execution and pass immediately.

This avoids redundant build and test runs when the underlying code changes are shared.

---
