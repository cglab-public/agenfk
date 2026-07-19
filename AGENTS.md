# AGENTS.md

Guidance for AI agents (Codex, Claude Code, and others) working **on** the AgEnFK
framework repository itself.

> **Canonical source:** [`CLAUDE.md`](./CLAUDE.md) holds the full repository
> guidance — purpose, architecture, testing notes, and reference docs. Read it
> first. This file mirrors the essentials so non-Claude agents have a standard
> entry point; when the two disagree, `CLAUDE.md` wins. Keep both in sync when you
> change repo-dev instructions.

## Repository purpose

This repo is the **AgEnFK framework itself** — a TypeScript monorepo shipping an
MCP server + REST/WebSocket API (`packages/server`), a CLI (`packages/cli`, exposed
at the repo root via `bin/agenfk.js`), a React Kanban UI (`packages/ui`), shared
`core`/`storage-sqlite`/`telemetry` packages, a `create` scaffolder, per-client rule
bundles (`clauderules/`, `cursorrules/`, `codexrules/`, `geminirules/`), and the
installer/uninstaller scripts. The repo's own `CLAUDE.md`/`AGENTS.md` are **not**
what installs onto end-user machines — `clauderules/CLAUDE.md` and
`codexrules/AGENTS.md` are the shipped bundles.

## Common commands

Build everything (core/storage/telemetry first, then cli/server/ui):
```
npm run build
```

Run all tests (vitest, node env, file-parallelism off — tests share fs state):
```
npm test
```

Run a single test file or filter by name:
```
npx vitest run packages/server/src/test/foo.test.ts
npx vitest run -t "name pattern"
```

Coverage (gated at 80% for `core`, `storage-sqlite`, `server`):
```
npm run test:coverage
```

Bump the monorepo version everywhere at once (root + all `packages/*/package.json`,
including internal `@agenfk/*` dep references across dependencies/devDependencies/
peerDependencies):
```
node scripts/bump-version.mjs <new-version>   # e.g. 1.1.8-beta.6
npm install --package-lock-only               # regenerate the lockfile
git add . && git commit -m "chore: bump version to <new-version>"
```
The old version is read from the root `package.json`; commit the manifest changes
and the regenerated lockfile together so they never drift. The release commands
(`/agenfk-release`, `/agenfk-release-beta`) use this flow.

## Architecture (big picture)

- **Single Owner**: the API server in `packages/server` is the only writer of
  state. CLI, MCP clients, and UI all go through its REST endpoints; updates fan
  out over Socket.io. Never read `.agenfk/db.sqlite` directly — go through the
  storage interface in `core`.
- **Storage**: SQLite-only via `better-sqlite3` (`packages/storage-sqlite`), WAL mode.
- **Workflow engine** (`packages/core`, enforced by `packages/server`): items
  (EPIC/STORY/TASK/BUG) move through a configurable **Flow** of `FlowStep`s.
  Forward transitions are gated by `validate_progress`; DONE is reachable only via
  `validate_progress` on the final step. `workflow_gatekeeper` is the pre-edit
  authorization check.
- **Port discovery**: the API server binds a free port (bumping off 3000 when
  busy) and writes the actual port to `~/.agenfk/server-port`. Clients discover it
  via `getApiUrl()` (`packages/telemetry`); standalone hooks under `bin/` read the
  file directly. Never hardcode `:3000` for a live server connection.

See [`CLAUDE.md`](./CLAUDE.md) and [`AFK_ARCHITECTURE.md`](./AFK_ARCHITECTURE.md)
for the full picture.
