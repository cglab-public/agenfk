# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository purpose

This repo is the **AgEnFK framework itself** — a TypeScript monorepo that ships:
- An MCP server + REST/WebSocket API (`packages/server`)
- A CLI (`packages/cli`, exposed at the repo root via `bin/agenfk.js`)
- A React Kanban UI (`packages/ui`)
- A `core` package with shared types/lifecycle logic, a `storage-sqlite` plugin, and `telemetry`
- A `create` package (project scaffolder) and per-client rule bundles in `clauderules/`, `cursorrules/`, `codexrules/`, `geminirules/`, plus `commands/` and `skills/` for slash-command/skill packs
- Installer/uninstaller scripts (`scripts/install.mjs`, `scripts/uninstall.mjs`) that copy these rule bundles, MCP config, and PreToolUse hooks into each AI client's config dir

Note: the repo's own CLAUDE.md (this file) is *not* the file that gets installed onto end-user machines — `clauderules/CLAUDE.md` is. The installer merges that bundle plus equivalents (`AGENTS.md`, `.cursor/rules/*.mdc`, etc.) into the user's client config. Keep `clauderules/CLAUDE.md` in sync with `SKILL.md`/`SDLC.md` when changing workflow rules.

## Common commands

Build everything (core/storage/telemetry first, then cli/server/ui):
```
npm run build
```

Build a single package:
```
npm run build -w packages/server
```

Run all tests (vitest, node env, file-parallelism off — tests share filesystem state):
```
npm test
```

Run a single test file or filter by name:
```
npx vitest run packages/server/src/test/foo.test.ts
npx vitest run -t "name pattern"
```

Coverage (gated at 80% for `core`, `storage-sqlite`, `server` per `vitest.config.ts`):
```
npm run test:coverage
```

UI is excluded from the root vitest run. For UI tests + coverage:
```
npm run test:ui:coverage
```

UI dev server / lint:
```
cd packages/ui && npm run dev
cd packages/ui && npm run lint
```

Installer / services (used by end users, but useful when iterating on install logic):
```
npm run install:framework      # copies rules + MCP config into ~/.claude, ~/.cursor, etc.
npm run uninstall:framework
npm run start:services         # launches the API server + UI
```

The CLI binary `bin/agenfk.js` is a thin shim that resolves to `packages/cli`. Build CLI before invoking it directly: `npm run build -w packages/cli`.

## Architecture (big picture)

**Single Owner**: the API server in `packages/server` is the only writer of state. CLI, MCP clients, and UI all go through its REST endpoints; updates fan out over Socket.io. Never read `.agenfk/db.sqlite` directly from other packages — go through the storage interface in `core`.

**Storage**: SQLite-only via `better-sqlite3` (`packages/storage-sqlite`). The repo previously supported `db.json`; existing JSON DBs are auto-migrated by the installer. WAL mode + indexed schema.

**Workflow engine** (`packages/core` + enforced by `packages/server`):
- Items have type (EPIC / STORY / TASK / BUG) and move through a configurable **Flow** of `FlowStep`s (default: TODO → IN_PROGRESS → REVIEW → TEST → DONE; per-project flows override this).
- Forward transitions are gated by `validate_progress(itemId, evidence, command?)`. The final step's `command` defaults to `project.verifyCommand`.
- DONE is unreachable by direct `update_item({ status: "DONE" })` — the server blocks it; only `validate_progress` on the final step can land it.
- `workflow_gatekeeper(intent, itemId?)` is the pre-edit authorization check; it surfaces the active step's `exitCriteria` so the caller knows what to satisfy before `validate_progress`.

**MCP surface**: the server registers MCP tools (`mcp__agenfk__*`) backed by the same handlers as the REST endpoints. Tool definitions live in `packages/server/src` alongside the Express routes. Adding a new MCP tool means: handler in core, REST route in server, MCP tool registration in server, and (usually) a CLI subcommand in `packages/cli` for the fallback path.

**Client integrations**: three clients are supported, with different enforcement models — see `AFK_ARCHITECTURE.md` for the full table. Claude Code and OpenCode get *mechanical* PreToolUse hooks (`agenfk-gatekeeper`, `agenfk-mcp-enforcer`) that hard-block edits without an active task and block bypass routes (direct DB reads, `curl localhost:3000`, raw CLI state queries). Cursor has no hook system, so enforcement there is instructional via `cursorrules/agenfk.mdc` (`alwaysApply: true`) plus the server-side gatekeeper.

## Testing notes

- Root vitest config sets `fileParallelism: false` and `sequence.concurrent: false` because tests touch the filesystem (sqlite DBs, install dirs). Don't flip these without auditing.
- `packages/cli/src/test/cli.test.ts` and `packages/ui/src/test/**` are excluded from the root run — they have their own runners.
- Aliases `@agenfk/core` and `@agenfk/telemetry` resolve to source in tests so you don't need to rebuild between iterations.
- `scripts/enforce-coverage.ts` parses Vitest's `coverage-summary.json` to enforce per-file thresholds beyond the global 80% gate; it's the canonical example of the "newly inserted code must be ≥80% covered" rule referenced in `AFK_ARCHITECTURE.md`.

## Reference docs in this repo

- `README.md` — user-facing overview, install/usage.
- `AFK_ARCHITECTURE.md` — system architecture, multi-agent orchestration, client enforcement matrix.
- `SDLC.md` — the lifecycle the framework enforces on its users (also describes rules this repo dogfoods on itself).
- `SKILL.md` — the master skill file installed across clients; mirror changes here when editing `commands/` or `skills/`.
- `AGENFK_COMPARISON.md`, `AFK_PROJECT_SCOPE.md` — design context.
