# Changelog

All notable changes to AgEnFK are documented here.

## [1.1.17-beta.3] — 2026-09-02

- **PR Overview dash: multi-select models filter** — the hub-ui PR Overview page's
  model filter is now a `FacetMultiselect` row (same component as Project/
  Developer); `?model=` is a CSV end-to-end (URL → toggle-set → data query →
  match-any on the PR *opener's* model), applied to both the current and
  previous-period windows so delta badges stay honest. Legacy single-value
  `?model=x` links keep working (`PrWindow.model` → `models: string[] | null`).
- **`parseList` hardening** — repeated query params (`?model=a&model=b`, which
  Express delivers as an array) are normalized to CSV form instead of 500-ing;
  covers every list filter (users/projects/types/itemTypes/model).
- **CLI test robustness** — hub deadletter list assertions are now
  color-independent (ANSI-tolerant), fixing a flake when the verify worker ran
  with `FORCE_COLOR`.

## [1.1.17-beta.2] — 2026-09-01

Hub org-boundary hardening (CGLAB-117) — after the 31 Aug 2026 incident, a clobbered
`~/.agenfk/hub.json` made one installation flush another org's queued events; the hub
rejected all 57 inside a `200 OK` and the flusher deleted them with the batch. This
release makes that failure mode structurally impossible and gives the operator the
tools to see and recover from it. See `HUB_ARCHITECTURE.md` §5.6.

### Added
- **Hub per-event rejection reasons**: `POST /v1/events` now answers
  `rejections: [{ eventId, reason }]` alongside the counters, with a four-code taxonomy
  (`invalid`, `org_mismatch`, `foreign_installation`, `hidden_user`).
- **Flusher org boundary**: only rows stamped for the installation's own org (or the
  pre-login `''` sentinel) ever enter a batch — enforced in SQL
  (`hubOutboxPeekDeliverable`), so stale rows never consume attempts and never starve
  the queue head. Surfaced as `staleOrgDepth` + per-org breakdown in
  `/internal/hub/status`, `agenfk hub status`, `agenfk hub flush`.
- **Deadletter instead of silent delete**: hub-refused events are preserved to
  `~/.agenfk/hub-deadletter.jsonl` *before* leaving the outbox; a failed write keeps
  the rows for retry. Against an old hub (no per-event detail) nothing is deleted at
  all — the batch is kept and re-sent idempotently with a loud `lastError`.
- **`agenfk hub carry-over --from <orgId> --to <orgId>`**: the sole path that rewrites
  an event's org stamp between named orgs — summary first, typed target confirmation
  (`--yes` for scripts, refusal on non-TTY), loud warning when the target is not the
  configured org, and every run audited to `~/.agenfk/hub-audit.jsonl`.
- **`agenfk hub deadletter`** (list, grouped by org) and
  **`agenfk hub deadletter discard --org X | --all`** (re-read before write, atomic
  replace, unparseable lines preserved on `--org`).
- **Identity gates**: `hub login` (both paths) and `hub join` refuse to persist a
  `hub.json` unless the URL about to be persisted answers `/healthz` with
  `service=agenfk-hub` — including the server-supplied `hubUrl` in device/redeem
  responses, and the invite is no longer POSTed to an ungated URL.
- **`hub repoint --carry-over`**: an org rename rewrites the outbox only when
  explicitly asked, through the same confirm + audit sequence; the default now prints
  the exact carry-over command and leaves the outbox untouched. The hub-ui rename
  campaign emits `--carry-over` (runners: add `--yes`).
- **Honest flush reporting**: `agenfk hub flush` exits 1 + red when the cycle ends
  with `lastError` — including a `200` that carried refusals — and prints yellow
  carry-over guidance when stale rows remain; `agenfk hub status` shows stale-org and
  deadletter depths.

### Fixed
- A `200 OK` containing per-event refusals no longer clears `lastError` — permanent
  loss no longer prints green.
- A no-op flush cycle (nothing deliverable) clears a historical `lastError`; `hub
  flush` no longer stays red forever after a transient failure once the outbox is
  empty.
- One corrupt outbox row (invalid JSON payload) could 500 the whole confirmed
  carry-over rewrite; the rewrite is now `json_valid`-guarded in SQL.
- `hub login` device flow: a refused/aborted config write no longer gets swallowed by
  the poll loop's error handling (endless polling instead of refusal).

## [1.1.0-beta.2] — 2026-06-23

### Changed
- **All skill flavors are now CLI-first**: the main `agenfk` skill and every sibling (`agenfk-code/close/test/review/deep/plan/pr/flow/calc-tokens`, plus `SKILL.md` and the per-client flavor files) now instruct the `agenfk` CLI directly instead of MCP-style function calls — each skill is self-contained (agents like Pi load each `~/.agents/skills/<name>/SKILL.md` independently). MCP tool names remain as optional "(MCP: …)" equivalents.
- Read commands in the skills and rule bundles use `--json` for machine-readable output.
- Removed the stale `log_token_usage` tool reference (token usage is ingested server-side).

### Fixed
- `bin/agenfk.js` refuses to run destructively from a source checkout (carried from beta.1; tightened guard).

## [1.1.0-beta.1] — 2026-06-23

### Changed
- **CLI-only by default**: AgEnFK no longer registers the MCP server with any client on install. The `agenfk` CLI is now the primary, fully server-enforced interface for the entire workflow. MCP becomes **opt-in**.
- **Upgrades flip cleanly to CLI-only**: a default (no `--with-mcp`) install/upgrade now *unregisters* any previously-registered agenfk MCP server across clients (claude/codex/gemini/cursor/opencode), so you don't end up in a half-state with stale MCP tools. Pass `--with-mcp` to keep/register it.
- Rule bundles (`CLAUDE.md`, `AGENTS.md`, `agenfk.mdc`, `GEMINI.md`) and `SKILL.md` rewritten to present the CLI as the default path, with a full CLI↔MCP command-mapping table; removed the prior "never use the CLI" guidance.

### Added
- **MCP opt-in flags**: `--with-mcp` registers the MCP server (e.g. `npx agenfk@latest --with-mcp`, `agenfk integration install <platform> --with-mcp`); `--no-mcp` force-disables it. The preference is persisted in `~/.agenfk/config.json` so re-installs honor it.
- **CLI parity commands** closing the former MCP-only gaps: `agenfk pause-work`, `resume-work`, `update-project`, `add-context`, `flow delete`, and `analyze`.
- **`--toon` global flag**: read commands (`list`, `get`, `list-projects`, `flow list`, `flow show`, `tokens`, `pr-register`, `pr-resize`, `update-project`) can emit compact **TOON** (Token-Oriented Object Notation) instead of JSON to reduce output tokens — tabular form for arrays of uniform objects.

### Platforms
- Claude Code: fully supported; gatekeeper + mcp-enforcer PreToolUse hooks still install (the enforcer permits the CLI when MCP is absent).
- Opencode / Gemini CLI / OpenAI Codex CLI / Cursor: CLI-driven workflow via the updated rule bundles; MCP available via `--with-mcp`.

## [0.2.1] — 2026-03-07

### Added
- **Custom Workflow Flows**: Projects can define custom multi-step flows with named steps and exit criteria (replaces fixed TODO → IN_PROGRESS → DONE).
- **Flow Designer**: Visual drag-and-drop flow editor in the Kanban UI.
- **TDD Flow**: Built-in TDD flow template (TODO → CREATE_UNIT_TESTS → IN_PROGRESS → REVIEW → DONE).
- **`get_flow` MCP tool**: Returns the active flow for a project including all steps and exit criteria.
- **`validate_progress` evidence param**: Mandatory `evidence` field logged as a tagged comment for audit trail.
- **Flow publish/install**: Share and install community workflow flows via a public registry repo.
- **Color-coded flow steps**: Steps and Kanban columns render with configurable accent colors.
- **Step colors in FlowStep type**: `color` field added to `FlowStep` in core and UI packages.

### Changed
- `review_changes` and `test_changes` MCP tools are now aliases of `validate_progress` (kept for backward compatibility).
- `validate_progress` on the final step enforces the project's `verifyCommand` automatically.
- Workflow gatekeeper now surfaces current step's exit criteria in the authorization response.

### Platforms
- Claude Code: fully supported via PreToolUse hooks.
- Opencode: fully supported via MCP + skill system.
- Google Gemini CLI: fully supported via MCP + workflow rules.
- OpenAI Codex CLI: fully supported via MCP + `AGENTS.md` rules.
- Cursor: experimental via `.mdc` instructional rules.

## [0.2.0] — 2026-03-01

### Added
- SQLite storage backend (`packages/storage-sqlite`) as an alternative to JSON.
- Telemetry package (`packages/telemetry`) for token usage tracking.
- `agenfk integration list/install/uninstall` commands for per-platform integration management.
- `agenfk health` command for system diagnostics.
- `agenfk upgrade --beta` flag for opting into pre-release versions.
- Parent–child status propagation: parent EPICs and STORYs auto-advance when all children advance.
- Sibling propagation: siblings on the same branch skip redundant build runs.

### Changed
- `agenfk up` now bootstraps services on first run if build artifacts are missing.
- MCP server now runs in stdio mode (`agenfk mcp`), compatible with all MCP clients.

## [0.1.x] — 2026-02-20 to 2026-02-28

Initial development: core monorepo setup, JSON storage, Express REST API, WebSocket real-time updates, React Kanban UI, CLI, MCP integration for Claude Code and Opencode, `validate_progress` workflow gate, auto git-commit on DONE.
