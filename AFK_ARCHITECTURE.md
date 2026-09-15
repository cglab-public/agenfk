# AFK Architecture: AgenFK Framework

## System Overview
AgenFK follows a **Single Owner Architecture** where a centralized API server manages the framework state, ensuring consistency across CLI, UI, and MCP clients.

## Project Structure (Monorepo)
The project is organized as a TypeScript monorepo using npm workspaces under the `agentic-framework/` directory.

- `agentic-framework/packages/core`: The foundation of the system. Contains all shared types, interfaces, and core logic for item lifecycle and state management.
- `agentic-framework/packages/cli`: A command-line interface that allows developers and agents to interact with the framework (create items, update status, etc.).
- `agentic-framework/packages/server`: The central API server built with Express. It manages the `db.json` storage and broadcasts updates via WebSockets.
- `agentic-framework/packages/storage-sqlite`: A storage plugin implementing SQLite persistence via `better-sqlite3`. Uses WAL mode and an indexed schema for efficient queries.
- `agentic-framework/packages/ui`: A modern web-based Kanban board built with React, Vite, Tailwind CSS, and TanStack Query.

## Key Component Interactions
1.  **Server as Source of Truth**: All state changes must go through the Server.
2.  **CLI/UI as Clients**: The CLI and Web UI communicate with the Server via a RESTful API.
3.  **Real-time Updates**: The Server uses WebSockets to push state changes to the UI for immediate visual feedback.
4.  **Planning Phase (Complex Items)**:
    - For items identified as EPIC, the system enforces a decomposition step into stories; for a STORY, decomposition into tasks happens only when the story is large.
    - When decomposing, all sub-items (Stories/Tasks) are created in `TODO` status first.
    - The Agent MUST obtain explicit user approval of a decomposition before transitioning any child item to `IN_PROGRESS`.
    - **Minimum Decomposition Rule**: An **EPIC** is created with its child **STORIES** (each story decomposed into tasks when large) — an EPIC is never worked directly. A **STORY** is worked directly when small, or created with sub-**TASK**s when large — the agent's judgement.
    - **Backlog Inspection Rule**: When starting new work, only items in **TODO** status should be inspected. Items labeled or in a state suggesting they are **IDEAs** (draft ideas or speculative plans) MUST be ignored until they are promoted to TODO.
    - **Item Type Selection Rule**: An agent receiving a new request MUST classify it before creating any item. Use TASK only for single-file, immediately-obvious changes. Use STORY for multi-file, single-package work. Use EPIC whenever the request spans multiple packages, introduces new architecture, or requires a plan to decompose — and always run `/agenfk-plan` before coding. Key signals for EPIC: new package/subsystem, 3+ packages touched, multiple distinct user-facing capabilities, or needing Plan Mode to understand scope.
5.  **Verification Loop**:
    - **Intermediate Steps (REVIEW, TEST, etc.)**: Advanced via `validate_progress`. Before calling it, agents call `workflow_gatekeeper(itemId)` to receive the current step's `exitCriteria`. `validate_progress` runs an agent-chosen command (or `verifyCommand` on the final step) to gate advancement.
    - **Exit Criteria**: Free-text conditions on each `FlowStep`. Surfaced by the gatekeeper — both `agenfk gatekeeper` and the `workflow_gatekeeper` MCP tool report the current step's criteria and the active flow's steps, resolved by one shared implementation in `@agenfk/core`. A step with no criteria says so explicitly rather than staying silent. Note the shipped default flow defines none (CGLAB-82).
    - **Coverage Rule**: Newly inserted code MUST meet a minimum threshold (e.g., 80%). The specific implementation of this check (e.g., parsing Vitest vs Jest outputs) is project-specific. For the AgenFK Framework itself, a helper script at `scripts/enforce-coverage.ts` is provided to perform this check against Vitest output.
    - **DONE Status**: Only reachable via `validate_progress` at the final intermediate step. Direct `update_item({ status: "DONE" })` is rejected on the REST path, but the MCP handler currently re-issues it with the internal verify token — see CGLAB-81. Treat DONE-by-any-route-but-verify as prohibited regardless.

## Multi-Agent Orchestration
AgenFK features an automated orchestration layer where the primary agent acts as a supervisor, automatically spawning specialized sub-agents at each step transition using the `task` tool. The steps below name the DEFAULT flow for illustration; a project's own flow decides how many hand-offs there are and what each one is for:

1.  **Planning Agent (TODO Phase)**:
    - **Trigger**: New user request or creation of an EPIC/STORY.
    - **Protocol**: Decomposes request into `TODO` sub-items and **PAUSES** for human approval.
2.  **Coding Agent (IN_PROGRESS Phase)**:
    - **Trigger**: Human approval of the plan.
    - **Protocol**: Implements the plan, then calls `validate_progress` to close the coding step. Never signal completion with `update_item({ status })` — a forward transition by any route other than `validate_progress` skips the gate.
3.  **Review Agent (REVIEW Phase)**:
    - **Trigger**: Automatic spawn when item enters REVIEW.
    - **Protocol**: Calls `workflow_gatekeeper(itemId)` to read exit criteria, audits code for security and requirements, then calls `validate_progress` to advance to `TEST`.
4.  **Testing Agent (TEST Phase)**:
    - **Trigger**: Automatic spawn after successful review.
    - **Protocol**: Calls `workflow_gatekeeper(itemId)` to read exit criteria, generates tests and verifies 80% coverage, then calls `validate_progress` (uses `verifyCommand`) to move item to `DONE`.
5.  **Closing Agent (DONE Phase)**:
    - **Trigger**: Automatic spawn after successful testing.
    - **Protocol**: Collates progress logs, writes the final summary comment, and prompts the user for the next action: Release, New Task (calls `/clear` and `/agenfk`), or Continue Current.

This automation ensures consistent engineering rigor while minimizing human micro-management.

## Supported AI Clients

AgenFK supports six AI coding assistants. Each integrates with the same MCP server but uses a different hook mechanism for workflow enforcement. **All six clients now have hooks** — the prior "instructional-only" gap for Codex / Cursor / Gemini has closed, and pi gets mechanical pre-edit blocking via its native extension event API.

| Client | MCP Registration | Workflow Rules | Pre-edit hook | Post-tool hook (PR sizing) |
|--------|-----------------|----------------|---------------|----------------------------|
| **Claude Code** | `claude mcp add` (user scope) | `~/.claude/CLAUDE.md` | `PreToolUse` — `agenfk-gatekeeper` + `agenfk-mcp-enforcer` | `PostToolUse` matcher `Bash` — `agenfk-pr-hook --client claude-code` |
| **OpenCode** | `~/.config/opencode/opencode.json` | `~/.config/opencode/skills/agenfk/SKILL.md` | `tool.execute.before` plugin (`agenfk-mcp-enforcer-opencode.mjs`) | `tool.execute.after` plugin (`agenfk-pr-hook-opencode.mjs`) |
| **pi** (0.79+) | opt-in (pi MCP config; not auto-registered) | (not yet bundled — extension provides enforcement) | native extension `~/.pi/agent/extensions/agenfk.ts` — `tool_call(edit\|write)` → gatekeeper, `tool_call(bash)` → mcp-enforcer (delegates to `~/.agenfk/bin/*.mjs`) | same extension — `tool_result(bash)` → `agenfk-pr-hook --client pi`, with the live model from `ctx.getModel()` injected into the reminder |
| **Codex CLI** | `codex mcp add` | `~/.codex/AGENTS.md` | (no equivalent — CLAUDE.md-style instructional) | `hooks.PostToolUse` matcher `Bash` (Codex matches the shell tool as `Bash`) — `agenfk-pr-hook --client codex` |
| **Gemini CLI** (v0.26+) | `gemini mcp add` | `~/.gemini/GEMINI.md` | (no equivalent — instructional) | `AfterTool` matcher `run_shell_command` — `agenfk-pr-hook --client gemini` |
| **Cursor** (1.7+) | `~/.cursor/mcp.json` | `~/.cursor/rules/agenfk.mdc` | (no equivalent — instructional + `alwaysApply: true` rule) | `afterShellExecution` — `agenfk-pr-hook --client cursor` |

### Enforcement model

- **Pre-edit gatekeeping** (is a TASK/BUG in an active working step?) is mechanical on Claude Code, OpenCode, and **pi** — their hook systems support pre-tool blocking (pi via the `tool_call` event returning `{ block, reason }`). On Codex / Gemini / Cursor, this remains **instructional** via the per-client rule docs — backed by the server-side `workflow_gatekeeper` audit trail.
- **PR sizing prompt** (after `gh pr create` / `git push`) is mechanical on **all six** clients via their respective post-tool hook events. On pi the reminder additionally carries the deterministically-detected model id (`ctx.getModel()`), so the agent reports the real model instead of guessing. Even when the post-tool directive isn't followed, the per-client instruction docs include a belt-and-suspenders rule asking the agent to call `register_pr` / `update_pr_sizing`.

### Note on Codex hook coverage

Codex's hook system reliably fires for the shell tool but not for `apply_patch` or most MCP tool calls (open issues `openai/codex#14882`, `#16732`, May 2026). The PR sizing hook is unaffected because `gh pr create` and `git push` always run via the shell tool. If pre-edit gatekeeping is added to Codex later, this caveat will need to be revisited.

## Hub Federation (hub of hubs)

A hub can enrol with another hub, making it a **child** and the other a **parent**.
The parent gets a view across the group; the child keeps running its own show.
Every claim below names the file it is true in, so it can be checked rather than
trusted.

### Principals

A **federation key** is its own kind of credential, never an `api_keys` row
(`packages/hub/src/auth/federationKey.ts`, table `federation_keys`). That
separation is the point: an installation key can never reach a `/v1/federation/*`
route, and a federation key can never post a developer's telemetry. A key is
refused the moment its hub is revoked or detached, so a detached child cannot
poll with a credential nobody got round to deleting.

Enrolment is invite-based: the parent mints a single-use invite, the child
presents it once, and the parent issues the key
(`routes/federation.ts`, `POST /v1/federation/enroll`).

### What a parent can see and do

- **See the events its children forward**, shaped by the identity policy below.
- **Read aggregate metrics per child hub**, kept apart by `child_hub_id` on
  `events` and `rollups_daily` rather than in a separate table.
- **Dispatch one of its flows** to some or all children, which install it as an
  `org_available` flow of origin `parent` (`services/federation/federationSync.ts`).
- **Dispatch a target agenfk version**, which each child fans out over its own
  installations (`services/federation/upgradeFanout.ts`), and **cancel** it.
- **Set the identity policy** for the group, or per child.
- **Detach a child**, which is the only way a child is released.

### What a parent cannot do — the part that matters

- **It cannot reach into a child's database.** There is no query path from
  parent to child at all: every federation route is child-initiated, and a
  directive tells the child what to do rather than asking it anything. Beyond
  forwarded events the parent learns only what the relationship itself requires
  — the child's chosen name, its hub version, its liveness, and the progress
  reports it sends about work the parent asked for.
- **Hiding someone stops their activity reaching the parent from that moment.**
  The exclusion happens at ingest, before anything is queued (`routes/events.ts`,
  CGLAB-31), and a group upgrade does not name their machines upstream either —
  the count travels, the identity does not
  (`services/federation/upgradeProgress.ts`). It is **go-forward only**: events
  already delivered stay at the parent, and rows already in the outbox are still
  sent. Hiding is not a retraction.
- **It cannot stop a child working.** No network call to the parent happens on
  the ingest path: forwarding only writes to a local outbox, and a failure to do
  even that is caught outside the ingest transaction. A parent that is down,
  slow, hostile or gone is invisible to the child's own developers. Pinned by
  `test/federation-standalone.test.ts`, which ingests while a tick is stuck
  mid-call against a parent that never answers.
- **It cannot silently take a fleet backwards.** A downgrade needs the parent
  admin to confirm it explicitly. The child re-validates the version's SHAPE
  against the same strict tag regex it applies to its own admin — note it does
  *not* re-check that the release exists, so a parent can dispatch a plausible
  version that is real nowhere, and each machine then refuses it individually.
- **It cannot overwrite a flow the child authored.** A dispatched flow is keyed
  by id, and every locally-authored flow has a random one, so a clash by NAME
  installs alongside rather than replacing. The one exception is a flow the
  parent previously dispatched and the child kept on leaving: re-joining and
  re-dispatching reclaims it, deliberately, or a re-join could never restore the
  group's standard.
- **It cannot claim work landed.** Serving a directive is not the same as it
  landing: a target stays `pending` until the child reports, and "asked to stop"
  (`cancel-pending`) is deliberately distinct from "stopped" (`cancelled`).

### Identity policy

The policy belongs to the parent — `keep` or `pseudonymize` — set for the group
or overridden per child, and the override wins in both directions because it is
an override, not an escalation (`services/federation/forwarding.ts`).

**The default is `keep`, and `keep` forwards the event whole**: the actor's git
email, the item title, the entire free-form payload. A fresh group has no policy
row, and no policy row means `keep`. If that is not what you want, it is one
setting and it is not the one you get by doing nothing — this is the single most
decision-relevant fact about federating, so it is stated before the nuance
rather than after it.

Two properties make it auditable rather than merely configurable. The child can
read the policy it is currently forwarding under (`GET /v1/admin/federation`), so
people are not subject to a control their own admin cannot see. And the policy
travels **with** each queued row rather than being read at delivery time, so
switching it can never retroactively change the meaning of rows already queued.

Under `pseudonymize` the payload is reduced to a known list of forwardable keys
rather than filtered for known-bad ones: a deny-list on a free-form blob is a
promise nobody can keep. The pseudonym is derived per child hub from that hub's
own secret, so the same person appears as two different people to a parent
watching two sibling hubs, and rotating `AGENFK_HUB_SECRET_KEY` re-pseudonymises
everyone from that point on. Both are deliberate; neither is reversible.

### Leaving a group

**Leaving is parent-granted.** A child cannot let itself out: `DELETE
/v1/admin/federation` succeeds only once the parent has detached it, which flips
the binding to `revoked` (`routes/admin.ts`). That keeps the parent's roster
authoritative — a child cannot quietly vanish from a dispatch target list — and
it is why there is a release *request* rather than a release action.

The binding's state is stored in clear beside the encrypted token on purpose.
Gating the leave on decryptability turned rotating `AGENFK_HUB_SECRET_KEY` into a
product-surface way out of the group.

What a child keeps when it leaves:

- **Flows the parent dispatched stay, and become editable.** Their origin flips
  from `parent` to `hub`, so nothing a team is mid-project under disappears
  (`services/federation/parentFlows.ts`). This fires on both exits — the parent
  detaching, discovered as a 401, and the child's own leave — because a hub whose
  parent detached it would otherwise hold flows nobody on earth can edit.
- **Its outbox**, deliberately: it is this hub's own record of what it never
  managed to send, and discarding it would destroy data as a side effect of
  tidying up a relationship.
- **Everything else**, because none of it was ever the parent's.

Sync stops rather than retrying, and a revoked binding stops queueing instead of
growing a table forever for a parent that is never coming back.

Two limits worth knowing before you join, because neither is obvious and both
are the kind of thing people discover at a bad moment:

- **A parent that simply goes dark cannot be left.** Leaving requires the
  binding to be `revoked`, and only the parent answering 401 produces that. A
  parent that stops responding without detaching leaves the child bound and
  ticking, with no exit through the product.
- **The outbox is capped** (`MAX_OUTBOX_ROWS`, 50,000) and trims the OLDEST rows
  first. A long enough outage silently loses the front of the queue rather than
  refusing new work.

And what leaving does not do: **nothing is deleted at the parent.** The child
keeps its own things, but every event it already forwarded stays upstream. Detach
ends the relationship going forward; it is not a recall.

### Deployment

A hub needs no configuration to be standalone: the federation worker starts
unconditionally and every tick is a no-op without a binding, so a hub that never
joins a group pays one cheap query a minute (`FEDERATION_TICK_MS`, 60s).

Neither role needs much more than that. `HUB_ARCHITECTURE.md` §2.7 covers what an
operator actually sets — which is almost nothing, plus one flag for a parent on a
private network — and why enrolment is deliberately a decision made in the UI
rather than a variable in the environment.

## Tech Stack
- **Language**: TypeScript (Strong typing across the stack)
- **Backend**: Node.js, Express, Socket.io
- **Frontend**: React, Vite, Tailwind CSS, TanStack Query
- **Storage**: SQLite only (`better-sqlite3`). Any existing `db.json` is automatically migrated during install or upgrade.
- **Communication**: REST API, WebSockets, MCP
