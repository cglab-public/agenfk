# @agenfk/hub

Optional **Corporate Hub** for AgEnFK. Receives events from each AgEnFK installation
(token usage, item lifecycle, validate outcomes, comments) and serves a web dashboard
with org rollup, per-user timelines, and admin tooling. Sign-in via email/password,
Google OAuth, and Microsoft Entra (configurable from the admin UI).

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
| `AGENFK_HUB_DB_PATH`                  | `/var/lib/agenfk-hub/hub.sqlite` (Docker: `/data/hub.sqlite`) |
| `AGENFK_HUB_PORT`                     | `4000`                        |
| `AGENFK_HUB_ORG_ID`                   | `default`                     |
| `AGENFK_HUB_INITIAL_ADMIN_EMAIL`      | (none — uses /setup wizard)   |
| `AGENFK_HUB_INITIAL_ADMIN_PASSWORD`   | (none — uses /setup wizard)   |
| `AGENFK_HUB_UI_DIR`                   | (auto-detected `../public` or `../../hub-ui/dist`) |

## Issuing installation tokens

Sign in as an admin → **Admin → API keys** → Issue. Copy the shown `agk_…`
token (it is only shown once), then on each developer machine:

```bash
agenfk hub login --url https://hub.acme.com --token agk_… --org default
```

The local AgEnFK server starts pushing events on the next restart. Use
`agenfk hub status` and `agenfk hub flush` to inspect / force the outbox.
