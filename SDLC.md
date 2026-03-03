## AgenFK Software Development Lifecycle (SDLC)

This document describes the complete development lifecycle enforced by the AgenFK framework — from task creation to release.

---

## 0. Strict Enforcement Mandate

**MANDATORY**: AI Agents are strictly prohibited from modifying ANY file in the codebase without an active task in `IN_PROGRESS` status and a successful `workflow_gatekeeper` call.

**Hard Block Rules**:
1. **NO TASK = NO CODE**: If no task is `IN_PROGRESS`, stop immediately and create one.
2. **NO GATE = NO CODE**: Call `workflow_gatekeeper` before the first edit of every session.
3. **NO BYPASS**: Never use `git commit`, `npm test`, or direct file writes to circumvent `review_changes` and `test_changes`.
4. **MEASURE EVERYTHING**: Every task MUST have token usage logged via `log_token_usage` before completion.

Bypassing these rules is a critical operational failure and degrades the project's measurability and reliability.

---

## 1. Item Creation & Classification

Every unit of work begins as an **item** in AgenFK. Items must be correctly classified:

| Request type | Item type |
|---|---|
| Bug, regression, defect, crash, incorrect behaviour | **BUG** |
| New capability, feature, enhancement | **TASK** / **STORY** / **EPIC** |

**Fix-Must-Be-Bug Rule**: Creating a TASK, STORY, or EPIC for a fix is a workflow violation. The system enforces this in skill files, CLAUDE.md, and SKILL.md.

### Hierarchy

- **EPIC** — spans multiple packages or introduces new architecture. Must be decomposed via `/agenfk-plan`.
- **STORY** — multi-file, single-package work. Decomposed into child TASKs.
- **TASK** — single-file or immediately-obvious changes. The leaf work unit.
- **BUG** — a defect fix. Also a leaf work unit.

Coding is only allowed on **TASK** and **BUG** items. EPICs and STORYs must be decomposed first.

---

## 2. Branch Management

Branches are managed manually by the developer. AgenFK does not create branches automatically.

### Convention

| Item type | Suggested prefix | Example |
|---|---|---|
| BUG | `fix/` | `fix/null-pointer-in-parser` |
| TASK | `feature/` | `feature/add-dark-mode-toggle` |
| STORY | `feature/` | `feature/user-authentication` |
| EPIC | `feature/` | `feature/git-branch-workflow` |

The developer creates the branch and links it to the item via `update_item({ id, branchName: '<branch>' })`.

Branches are only tracked on **top-level items** (no `parentId`). Child tasks inherit the parent's branch.

### Gatekeeper Branch Checkout

If the item has a `branchName` that exists locally, the **workflow gatekeeper** will auto-checkout the branch before the agent's first edit. If the branch does not exist locally, the gatekeeper warns the agent to create and check out the branch manually.

---

## 3. Status Workflow

```
TODO → IN_PROGRESS → REVIEW → TEST → DONE
```

Each transition has specific rules and enforcement:

### TODO → IN_PROGRESS

- Set via `update_item({ id, status: "IN_PROGRESS" })`.
- If a `branchName` is set on the item and the branch exists locally, the gatekeeper auto-checks it out.

### IN_PROGRESS → REVIEW

- Set via `update_item({ id, status: "REVIEW" })` when implementation is complete.
- This is a direct transition — no tool gate required.
- The agent signals that coding is done and the item is ready for review.

### REVIEW → TEST (via `review_changes`)

The agent (or review agent in multi-agent mode) performs a self-review, then calls:

```
review_changes({ itemId, command: "npm run build" })
```

- First, the agent re-reads modified files and checks correctness, security, and requirements alignment.
- If issues are found: `update_item({ id, status: "IN_PROGRESS" })` and fix.
- Once satisfied, `review_changes` runs the build gate:
  - The **agent picks the command** — build, lint, type-check, whatever makes sense.
  - If the command passes (exit code 0): item moves to `TEST`.
  - If it fails: item moves back to `IN_PROGRESS`.
  - A comment is logged with the command output.

### TEST → DONE (via `test_changes`)

The agent calls:

```
test_changes({ itemId })
```

- **No command parameter** — the project's `verifyCommand` is always used.
- The agent cannot override or bypass the test suite.
- If `verifyCommand` is not configured: the tool returns `NO_VERIFY_COMMAND`. The agent auto-detects the project stack from config files (e.g. `package.json`, `Cargo.toml`, `go.mod`, `*.csproj`), sets the command via `update_project({ id, verifyCommand })`, and retries. If nothing can be detected, the agent asks the developer as a last resort.
- If the command passes: item moves to `DONE`, auto-git-commit is triggered.
- If it fails: item moves back to `IN_PROGRESS`.
- A test record is logged on the item.
- Direct `update_item({ status: "DONE" })` is **blocked by the server**.

### Project verifyCommand

Each project defines its own test suite command. Set once, enforced forever:

```
update_project({ id, verifyCommand: "npm run build && npm test" })
```

Examples by stack:
- Node.js: `npm run build && npm test`
- Rust: `cargo build && cargo test`
- Python: `pytest`
- Go: `go build ./... && go test ./...`

The `verifyCommand` is stored on the **Project entity** and used by `test_changes` for every TEST → DONE transition. Agents cannot supply their own command.

### Sibling Propagation Rule

When child items of the same parent share the same source code (same branch/workspace), a single `review_changes` or `test_changes` call validates the code for **all** siblings:

- After `review_changes` passes on **one** sibling, move remaining siblings directly to TEST via `update_item({ status: "TEST" })` — no individual `review_changes` calls needed.
- After `test_changes` passes on **one** sibling, call `test_changes` on remaining siblings in TEST — the same verified code will pass immediately.

This avoids redundant build and test runs when the underlying code changes are shared across sibling items.

---

## 4. Workflow Gatekeeper

Before any file edit, agents must call:

```
workflow_gatekeeper({ intent, role, itemId })
```

The gatekeeper:
1. Verifies an active task exists in `IN_PROGRESS`.
2. Validates the agent's role matches the phase (e.g., `coding` requires `IN_PROGRESS`).
3. If the item has a `branchName` that exists locally, auto-checks it out.
4. If the branch is set but does not exist locally, warns the agent to create it manually.
5. Rejects coding on EPIC/STORY items (must decompose first).

---

## 5. PR Creation

Pull requests are created manually by the developer. Use the `/agenfk-pr` skill or run `gh pr create` directly.

After creating a PR, store the details on the item:
```
update_item({ id, branchName: '<branch>', prUrl: '<url>', prNumber: <number>, prStatus: 'open' })
```

### PR Status Tracking

The item tracks PR state:
- `prStatus: 'open'` — PR is open and awaiting review.
- `prStatus: 'draft'` — PR created as draft.
- `prStatus: 'merged'` — PR has been merged.
- `prStatus: 'closed'` — PR was closed without merge.

### UI Visibility

The Kanban board displays:
- A **branch chip** (monospace, truncated) showing the branch name.
- A **PR badge** (color-coded by status, clickable link to the PR).
- Both are only shown on top-level items (`!item.parentId`).

---

## 6. Release Flow

Releases are triggered manually by the developer after PR merge.

### Pre-Release Check

The `/agenfk-release` skill includes a **Step 0 PR merge gate**:

1. Fetches the item's `prNumber`.
2. Runs `agenfk pr check <itemId>` to verify the PR is merged.
3. If not merged: **aborts** and tells the user to wait.
4. If no PR is tracked or `gh` is not installed: proceeds (no gate).

### Release Process

1. Developer runs `/agenfk-release`.
2. PR merge gate is checked.
3. Changes are committed and pushed.
4. A GitHub release is created (via `gh release create`).

### Beta Releases

`/agenfk-release-beta` creates a pre-release without the PR merge gate.

---

## 7. Complete Lifecycle Example

### Bug Fix

```
1. [Developer] git checkout -b fix/login-crash-on-empty-email
2. create_item({ type: "BUG", title: "Login crash on empty email" })
3. update_item({ id, status: "IN_PROGRESS", branchName: "fix/login-crash-on-empty-email" })
4. workflow_gatekeeper({ intent: "Fix null check", role: "coding" })
   → Gatekeeper auto-checks out the branch
5. [Agent implements the fix]
6. update_item({ status: "REVIEW" })
7. [Agent self-reviews: re-reads files, checks correctness]
8. review_changes({ itemId, command: "npm run build" })
   → Passes → item moves to TEST
9. test_changes({ itemId })
   → Runs project verifyCommand (npm run build && npm test)
   → Passes → item moves to DONE
10. [Developer] git push -u origin fix/login-crash-on-empty-email
11. [Developer] gh pr create (or /agenfk-pr)
12. [Developer reviews and merges PR]
13. /agenfk-release → creates release
```

### Feature Task

```
1. create_item({ type: "TASK", title: "Add dark mode toggle" })
2. update_item({ status: "IN_PROGRESS" })
3. workflow_gatekeeper({ intent: "Add toggle", role: "coding" })
4. [Agent implements the feature]
5. update_item({ status: "REVIEW" })
6. [Self-review] → review_changes({ itemId, command: "npm run build" })
   → Passes → TEST
7. test_changes({ itemId })
   → Passes → DONE
```

---

## 8. MCP Tools Reference

### Workflow Tools

| Tool | Purpose | Params |
|---|---|---|
| `workflow_gatekeeper` | Pre-flight auth before file edits | `intent`, `role`, `itemId?` |
| `review_changes` | Agent-chosen build command, REVIEW → TEST | `itemId`, `command` |
| `test_changes` | Project verifyCommand, TEST → DONE | `itemId` |

### Project Tools

| Tool | Purpose | Params |
|---|---|---|
| `create_project` | Create a new project | `name`, `description?` |
| `update_project` | Update project settings | `id`, `name?`, `description?`, `verifyCommand?` |
| `list_projects` | List all projects | — |

### Item Tools

| Tool | Purpose | Params |
|---|---|---|
| `create_item` | Create EPIC/STORY/TASK/BUG | `projectId`, `type`, `title`, `description?` |
| `update_item` | Update item fields/status | `id`, `status?`, `title?`, `description?` |
| `get_item` | Get item details | `id` |
| `list_items` | List items by project/status | `projectId`, `status` |
| `delete_item` | Trash an item | `id` |
| `add_comment` | Log progress on item | `itemId`, `content` |
| `add_context` | Attach file/context to item | `itemId`, `path` |

### Reporting Tools

| Tool | Purpose | Params |
|---|---|---|
| `log_token_usage` | Track AI token consumption | `itemId`, `input`, `output`, `model` |
| `log_test_result` | Record test execution | `itemId`, `command`, `output`, `status` |
| `analyze_request` | Suggest item type for request | `request` |

---

## 9. Enforcement Summary

| Rule | Enforced by |
|---|---|
| Must have IN_PROGRESS task before editing files | `workflow_gatekeeper` + PreToolUse hooks |
| REVIEW requires build gate for TEST | `review_changes` runs build command to advance REVIEW → TEST |
| Cannot set DONE directly | Server rejects `update_item({ status: "DONE" })` |
| Test suite must run for DONE | `test_changes` uses project `verifyCommand`, not agent command |
| Fixes must be BUG items | Enforced in CLAUDE.md, SKILL.md, skill files |
| Branches managed by developer | No automatic branch creation; developer creates and links branches manually |
| MCP-first, not CLI | PreToolUse hooks block direct DB/API access |
