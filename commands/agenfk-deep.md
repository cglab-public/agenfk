---
description: Run a task using full Multi-Agent Orchestration (Deep Mode)
---

> Use the `agenfk` CLI for all workflow operations (CLI-only is the default; read with `--json` for machine-readable output). If `mcp__agenfk__*` tools are present (installed with `--with-mcp`), the equivalent MCP tool is interchangeable.

Load the `agenfk` skill. Run its Initialization protocol if needed.

**Clean start from main** — Before starting work:
- Run `git status` — if the working tree has uncommitted or modified files, **STOP** and ask the user how to proceed (stash, commit, or discard). Never start new work on a dirty working tree.
- If NOT on `main` (or `master`) and the current branch doesn't belong to an item you're resuming, run `git checkout main` (or `master`) followed by `git pull`.

Identify the user's request and follow the **Deep Mode** protocol in the skill:
1. Decompose the request into sub-items.
   - **MANDATORY**: For **EPICs** and **STORIES**, you **MUST** decompose the request into all constituent child items (using `agenfk create <TYPE> "<title>" --project <id> --parent <parentId>`) **BEFORE** starting work on the first task.
2. Identify independent tasks that can be performed in parallel.
3. PAUSE for human approval of the plan.
4. Upon approval, begin walking the project's flow by spawning specialized sub-agents — one per step, matched to what that step's exit criteria ask for. Read the steps and their criteria from `agenfk flow show --project <projectId> --json`; do not assume a Code -> Review -> Test -> Close sequence.
5. **Parallelism**: If multiple independent tasks exist, spawn multiple agents simultaneously using the `task` tool. Ensure each sub-agent is passed its specific item ID to authorize changes via `agenfk gatekeeper --intent "<intent>" --item-id <id>`.
6. **Branch verification**: Each sub-agent MUST verify it is on the correct item branch (`git branch --show-current`) before writing any code. If the item has a `branchName` and the agent is not on it, run `git checkout <branchName>` first. **Never code on the wrong branch.**

---

## Quality Guards — MANDATORY

### Feature Implementation
- **End-to-end verification**: After implementing any feature, verify it works end-to-end by tracing the full path from UI interaction to backend response. Do not mark a feature as complete until you've confirmed the UI actually triggers the expected behavior.
- **Evidence-based claims**: Before claiming a feature already exists or is implemented, search the actual codebase for the specific UI components, API endpoints, and database queries. Never assume implementation status without evidence.

### Bug & Error Fixing
- **Root cause first**: When debugging errors, investigate the root cause fully before applying fixes. Avoid adding workarounds that can create new problems (e.g. infinite loops). Trace errors from the symptom back to the actual source.
- **One fix at a time**: Apply a single targeted fix, verify it resolves the issue, then move on. Do not stack multiple speculative fixes.

---

## Parent-Child Status Propagation Rule

**MANDATORY**: A parent item (EPIC or STORY) can ONLY move forward to a step once **ALL** of its child items have reached that step or gone past it. Read the steps from `agenfk flow show --project <projectId> --json`, not from a fixed pipeline. The server auto-rolls a parent forward on ANY flow — by position in the active flow, up to the step of the least-advanced live child, forward only. If the parent is nonetheless left behind (for example after a manual rollback), advance it with `agenfk verify <parentId> --evidence "<all children are past this step>"` once its children are — never with `agenfk update --status`.

## Sibling Propagation Rule

When child items of the same parent share the same source code (same branch/workspace), a single `agenfk verify` call validates the code for **all** siblings:

- After `agenfk verify` passes on **one** sibling (advancing it to the next step), run `agenfk verify <id> --evidence "<text>"` on remaining siblings — the server's sibling propagation detects the already-advanced sibling and skips command execution, passing immediately.
- For the final step (→ DONE): run `agenfk verify <id> --evidence "<text>"` on each remaining sibling — the server's sibling propagation will skip execution and pass immediately.

This avoids redundant build and test runs when the underlying code changes are shared.

---
