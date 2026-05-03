# @agenfk/hub

Optional **Corporate Hub** for AgEnFK. Receives events from each AgEnFK installation
(token usage, item lifecycle, validate outcomes, comments) and serves a web dashboard
with org rollup, per-user timelines, and admin tooling. Sign-in via email/password,
Google OAuth, and Microsoft Entra (configurable from the admin UI).

## Quick start (Docker)

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
