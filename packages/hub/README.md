# @agenfk/hub

Optional **Corporate Hub** for AgEnFK. Receives events from each AgEnFK installation
(token usage, item lifecycle, validate outcomes, comments) and serves a web dashboard
with org rollup, per-user timelines, and admin tooling. Sign-in via email/password,
Google OAuth, and Microsoft Entra (configurable from the admin UI).

## Quick start (npx from GitHub)

No npm publish required — run directly from the GitHub repo:

```bash
export AGENFK_HUB_SECRET_KEY="$(openssl rand -hex 32)"
export AGENFK_HUB_SESSION_SECRET="$(openssl rand -hex 32)"
export AGENFK_HUB_INITIAL_ADMIN_EMAIL=you@example.com
export AGENFK_HUB_INITIAL_ADMIN_PASSWORD=changeme123

npx --package github:cglab-public/agenfk agenfk-hub
```

Add `--beta` to pull the latest pre-release instead of the latest stable:

```bash
npx --package github:cglab-public/agenfk agenfk-hub --beta
```

Then open `http://localhost:4000/`.

## Quick start (Docker)

The build context must be the **monorepo root**, not `packages/hub`, so workspace deps resolve:

```bash
docker build -t agenfk-hub:latest -f packages/hub/Dockerfile .
docker run --rm -p 4000:4000 \
  -e AGENFK_HUB_SECRET_KEY="$(openssl rand -hex 32)" \
  -e AGENFK_HUB_SESSION_SECRET="$(openssl rand -hex 32)" \
  -e AGENFK_HUB_INITIAL_ADMIN_EMAIL=you@acme.com \
  -e AGENFK_HUB_INITIAL_ADMIN_PASSWORD='changeme123' \
  -v agenfk-hub-data:/data \
  agenfk-hub:latest
```

Then sign in at `http://localhost:4000/`.

### Quick start (docker compose)

```bash
cp packages/hub/.env.example packages/hub/.env
# edit packages/hub/.env — at minimum, fill in AGENFK_HUB_SECRET_KEY and AGENFK_HUB_SESSION_SECRET
docker compose -f packages/hub/docker-compose.yml up -d
```

The compose file mounts a named `hub-data` volume at `/data` so the SQLite DB
survives image rebuilds.

### Production notes

- Run **behind TLS** (nginx, Caddy, an LB, etc.) and set `NODE_ENV=production`
  so session cookies are flagged `Secure`.
- The image runs as the **non-root** user `agenfk` (uid >1000). Mount your data
  volume with appropriate ownership or let the image's `chown -R` line handle a
  fresh volume.
- `HEALTHCHECK` pings `/healthz` every 30s; orchestrators (Kubernetes, ECS,
  Nomad, Swarm) will restart unhealthy containers.
- `tini` is the entrypoint, so `Ctrl-C` and `SIGTERM` from the orchestrator
  reach Node directly — graceful shutdown works.
- Back up the contents of `/data` (which contains `hub.sqlite`, `hub.sqlite-wal`,
  `hub.sqlite-shm`) on the same cadence as any other system-of-record.

## Required environment variables

| Variable                       | Purpose                                               |
| ------------------------------ | ----------------------------------------------------- |
| `AGENFK_HUB_SECRET_KEY`        | 32-byte key (64 hex / 44 base64) for AES-256-GCM      |
| `AGENFK_HUB_SESSION_SECRET`    | HMAC key for session JWTs                             |

## Optional

| Variable                              | Default                       |
| ------------------------------------- | ----------------------------- |
| `AGENFK_HUB_DB`                       | `sqlite` (also: `postgres`)   |
| `AGENFK_HUB_DB_PATH`                  | `/var/lib/agenfk-hub/hub.sqlite` (Docker: `/data/hub.sqlite`) |
| `AGENFK_HUB_PG_URL`                   | (required when `AGENFK_HUB_DB=postgres`) |
| `AGENFK_HUB_PORT`                     | `4000`                        |
| `AGENFK_HUB_ORG_ID`                   | `default`                     |
| `AGENFK_HUB_INITIAL_ADMIN_EMAIL`      | (none — uses /setup wizard)   |
| `AGENFK_HUB_INITIAL_ADMIN_PASSWORD`   | (none — uses /setup wizard)   |
| `AGENFK_HUB_UI_DIR`                   | (auto-detected `../public` or `../../hub-ui/dist`) |

## Enterprise: Postgres backend

For fleet-scale deployments where SQLite's single-file model is impractical
(many concurrent writers, cross-AZ HA, point-in-time recovery, fleet-wide
backup/audit tooling), the hub also supports Postgres. Opt in by setting:

```bash
export AGENFK_HUB_DB=postgres
export AGENFK_HUB_PG_URL='postgres://hub:hub-password@db.internal.acme.com:5432/agenfk_hub?sslmode=require'
```

Anything `pg`-driver-compatible works — including connection pooling proxies
like PgBouncer (transaction-pool mode is fine; the hub does not use prepared
statements that span requests).

**You provision the Postgres server yourself.** Common production paths:

- **AWS** — RDS for PostgreSQL or Aurora PostgreSQL (recommended for managed
  backups, multi-AZ, and read replicas).
- **GCP** — Cloud SQL for PostgreSQL or AlloyDB.
- **Azure** — Azure Database for PostgreSQL (Flexible Server).
- **Self-hosted** — any PostgreSQL ≥ 13 reachable on `AGENFK_HUB_PG_URL` (Docker,
  k8s with the Zalando or CrunchyData operator, plain VMs, etc.).

The hub deliberately does **not** ship a `docker-compose` Postgres service:
production Postgres is a database operator's call, not a hub-vendor opinion.

### What happens on first connect

1. The hub probes the connection at boot and fails fast with a redacted-DSN
   error if the server is unreachable.
2. Schema bootstrap runs `CREATE TABLE IF NOT EXISTS` for every hub table
   (`orgs`, `api_keys`, `installations`, `events`, `rollups_daily`, `users`,
   `device_codes`, `used_invites`, `auth_config`) plus the indexes used by the
   timeline / histogram queries.
3. A column-backfill pass adds `item_type`, `remote_url`, `item_title`, and
   `external_id` to a pre-existing `events` table if any are missing — same
   shape as the SQLite backend so legacy installs migrate cleanly.
4. The default org row + default `auth_config` row are upserted by
   `createHubApp` itself.

The hub user only needs `CREATE`, `SELECT`, `INSERT`, `UPDATE`, `DELETE`, and
`ALTER` on its own database. No superuser, no extensions required.

### Migrating from SQLite to Postgres

Not built into this beta. Treat the SQLite hub as the single-tenant on-ramp and
the Postgres hub as a fresh deployment for the enterprise-fleet phase. If you
need the historical events copied over, raise an issue and we'll prioritise the
one-shot migration tool.

## Issuing installation tokens

Sign in as an admin → **Admin → API keys** → Issue. Copy the shown `agk_…`
token (it is only shown once), then on each developer machine:

```bash
agenfk hub login --url https://hub.acme.com --token agk_… --org default
```

The local AgEnFK server starts pushing events on the next restart. Use
`agenfk hub status` and `agenfk hub flush` to inspect / force the outbox.
