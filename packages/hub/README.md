# @agenfk/hub

The optional **Corporate Hub** for AgEnFK — the corp-side server that
collects fleet activity, gates upgrades, and distributes shared workflow
definitions.

The single source of truth for what the hub does, how to run it, and how
the fleet talks to it lives in **[HUB_ARCHITECTURE.md](../../HUB_ARCHITECTURE.md)**
at the repo root. That document covers:

- Running the hub (npx, Docker, compose, production posture, port autoselect)
- Required and optional environment variables
- Storage backends (SQLite default, Postgres optional) and migration policy
- Authentication (sessions for admins, bearer api_keys for installations)
- Client → hub ingest, the local outbox, and the flusher
- Client ← hub flow synchronisation
- Fleet upgrade end-to-end (directives, polling, async spawn, boot replay)
- HTTP surface (health, setup, ingest, distribute, query, admin)
- Dashboard views and per-event observability

For the framework as a whole, see `AFK_ARCHITECTURE.md`.
For the lifecycle the hub helps enforce, see `SDLC.md`.
