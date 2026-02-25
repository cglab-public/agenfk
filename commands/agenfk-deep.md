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

---

## Parent-Child Status Propagation Rule

**MANDATORY**: A parent item (EPIC or STORY) can ONLY move forward in the workflow (e.g., TODO → IN_PROGRESS, IN_PROGRESS → REVIEW, TEST → DONE) once **ALL** of its child items have also moved to that same state or further.

---
