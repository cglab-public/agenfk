# AgenFK Software Development Lifecycle (SDLC)

This document describes the complete development lifecycle enforced by the AgenFK framework — from task creation to release.

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

## 2. Branch Creation

When an item moves to `IN_PROGRESS`, the branching strategy depends on the item type:

### BUG Items (Automatic)

1. **Server auto-assigns** a `branchName` when status transitions to `IN_PROGRESS`.
2. Branch name: `fix/<slugified-title>` (e.g., `fix/login-crash-on-empty-email`).
3. The **workflow gatekeeper** auto-creates and checks out the git branch before the agent's first file edit.
4. No human intervention needed — fully automatic.

### TASK Items (Optional)

1. No branch is auto-created.
2. The gatekeeper informs the agent: *"This TASK has no branch. You may offer the developer to create one with the `create_branch` MCP tool, or continue on the current branch."*
3. The developer decides whether to work on a feature branch or stay on main.
4. If a branch is created: `feature/<slugified-title>`.

### Branch Naming Convention

| Item type | Prefix | Example |
|---|---|---|
| BUG | `fix/` | `fix/null-pointer-in-parser` |
| TASK | `feature/` | `feature/add-dark-mode-toggle` |
| STORY | `feature/` | `feature/user-authentication` |
| EPIC | `feature/` | `feature/git-branch-workflow` |

Branches are only tracked on **top-level items** (no `parentId`). Child tasks inherit the parent's branch.

### MCP Tool: `create_branch`

```
create_branch({ itemId })
```

- Computes the branch name from item type and title.
- Creates the local git branch and switches to it.
- Stores `branchName` on the item.
- Rejects items with a `parentId`.

---

## 3. Status Workflow

```
TODO → IN_PROGRESS → REVIEW → TEST → DONE
```

Each transition has specific rules and enforcement:

### TODO → IN_PROGRESS

- Set via `update_item({ id, status: "IN_PROGRESS" })`.
- For BUG items: server auto-assigns `branchName`.
- Gatekeeper auto-creates/checkouts the git branch.

### IN_PROGRESS → REVIEW (via `review_changes`)

The agent performs implementation and then calls:

```
review_changes({ itemId, command: "npm run build" })
```

- The **agent picks the command** — build, lint, type-check, whatever makes sense.
- If the command passes (exit code 0): item moves to `REVIEW`.
- If it fails: item stays `IN_PROGRESS`.
- A comment is logged with the command output.
- Direct `update_item({ status: "REVIEW" })` is **blocked by the server**.

### REVIEW → TEST

- The agent (or review agent in multi-agent mode) performs a self-review.
- Re-reads modified files, checks correctness, security, and requirements alignment.
- If satisfied: `update_item({ id, status: "TEST" })`.
- If issues found: `update_item({ id, status: "IN_PROGRESS" })` and fix.

### TEST → DONE (via `test_changes`)

The agent calls:

```
test_changes({ itemId })
```

- **No command parameter** — the project's `verifyCommand` is always used.
- The agent cannot override or bypass the test suite.
- If `verifyCommand` is not configured: the tool returns an error instructing the agent to ask the developer and set it via `update_project`.
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

---

## 4. Workflow Gatekeeper

Before any file edit, agents must call:

```
workflow_gatekeeper({ intent, role, itemId })
```

The gatekeeper:
1. Verifies an active task exists in `IN_PROGRESS`.
2. Validates the agent's role matches the phase (e.g., `coding` requires `IN_PROGRESS`).
3. For BUG items with a `branchName`: auto-creates and checks out the git branch if it doesn't exist locally.
4. For TASK items without a branch: hints to the agent about optional branch creation.
5. Rejects coding on EPIC/STORY items (must decompose first).

---

## 5. PR Creation

After code is reviewed and pushed, a pull request can be created:

### MCP Tool: `create_pr`

```
create_pr({ itemId, description: "PR body text", draft: false })
```

- Pushes the branch to remote (`git push -u origin <branch>`).
- Creates a GitHub PR via `gh pr create` (safe argument passing via `spawnSync`).
- Stores `prUrl`, `prNumber`, `prStatus` on the item.
- Returns the PR URL and a release hint.
- Requires `gh` CLI installed and a branch already assigned to the item.
- Only works for top-level items (no `parentId`).

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

### Bug Fix (Fully Automatic Branch)

```
1. create_item({ type: "BUG", title: "Login crash on empty email" })
2. update_item({ status: "IN_PROGRESS" })
   → Server auto-assigns branchName: fix/login-crash-on-empty-email
3. workflow_gatekeeper({ intent: "Fix null check", role: "coding" })
   → Gatekeeper auto-creates and checkouts the branch
4. [Agent implements the fix]
5. review_changes({ itemId, command: "npm run build" })
   → Passes → item moves to REVIEW
6. [Agent self-reviews: re-reads files, checks correctness]
7. update_item({ status: "TEST" })
8. test_changes({ itemId })
   → Runs project verifyCommand (npm run build && npm test)
   → Passes → item moves to DONE
9. create_pr({ itemId, description: "Fix null pointer..." })
   → Pushes branch, creates PR, stores PR URL
10. [Developer reviews and merges PR]
11. /agenfk-release
    → Checks PR is merged → creates release
```

### Feature Task (Optional Branch)

```
1. create_item({ type: "TASK", title: "Add dark mode toggle" })
2. update_item({ status: "IN_PROGRESS" })
3. workflow_gatekeeper({ intent: "Add toggle", role: "coding" })
   → Hint: "This TASK has no branch. Offer to create one or continue on current branch."
4. [Agent asks developer] → Developer says "create a branch"
5. create_branch({ itemId })
   → Creates feature/add-dark-mode-toggle
6. [Agent implements the feature]
7. review_changes({ itemId, command: "npm run build" })
   → Passes → REVIEW
8. [Self-review] → update_item({ status: "TEST" })
9. test_changes({ itemId })
   → Passes → DONE
```

---

## 8. MCP Tools Reference

### Workflow Tools

| Tool | Purpose | Params |
|---|---|---|
| `workflow_gatekeeper` | Pre-flight auth before file edits | `intent`, `role`, `itemId?` |
| `review_changes` | Agent-chosen command, IN_PROGRESS → REVIEW | `itemId`, `command` |
| `test_changes` | Project verifyCommand, TEST → DONE | `itemId` |

### Git Tools

| Tool | Purpose | Params |
|---|---|---|
| `create_branch` | Create + checkout branch for item | `itemId` |
| `create_pr` | Push branch + create GitHub PR | `itemId`, `description?`, `draft?` |

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
| Cannot set REVIEW directly | Server rejects `update_item({ status: "REVIEW" })` |
| Cannot set DONE directly | Server rejects `update_item({ status: "DONE" })` |
| Test suite must run for DONE | `test_changes` uses project `verifyCommand`, not agent command |
| Fixes must be BUG items | Enforced in CLAUDE.md, SKILL.md, skill files |
| Branches only on top-level items | `create_branch` and `create_pr` reject items with `parentId` |
| BUG branches are automatic | Server auto-assigns `branchName` on IN_PROGRESS transition |
| PR must be merged before release | `/agenfk-release` Step 0 PR merge gate |
| MCP-first, not CLI | PreToolUse hooks block direct DB/API access |
