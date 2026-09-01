# Hub Architecture

This document is the **single reference** for the AgEnFK Hub — what it does,
how it talks to the fleet, how to run it, and what the current functionality
is. It is intentionally not an update log; if a feature is described here, it
is part of the hub today.

For the framework as a whole see `AFK_ARCHITECTURE.md`. For the lifecycle the
hub helps enforce, see `SDLC.md`.

---

## 1. Purpose and shape

The hub is a single Node/Express service backed by SQLite (default) or
Postgres (optional). It owns four concerns:

1. **Ingest** — receives append-only activity events from every installation.
2. **Query** — admin/dashboard read APIs over those events (timeline,
   histogram, rollups, recent events, per-user views).
3. **Govern** — central definitions for workflows (flows) and admin-issued
   fleet upgrade directives, plus identity & access for human admins.
4. **Distribute** — exposes the canonical "this is the active flow for your
   project" and "is there a pending upgrade for you" answers that each fleet
   installation polls.

A single hub serves one or more *organisations*. Every row in every table is
keyed by `org_id`. Every API session, every API key, and every event carries
`orgId`; the server refuses any cross-org read or write.

### Process layout

```
       per-developer machine                                    corp hub
┌─────────────────────────────────────┐               ┌──────────────────────────┐
│  agenfk CLI / MCP / IDE plugin      │               │                          │
│         │                           │               │     /v1/events           │
│         ▼                           │  HTTPS POST   │     /v1/ping             │
│  agenfk server  ───── HubClient ───►│──────────────►│     /v1/upgrade-directive│
│  (writes outbox to local sqlite)    │  HTTPS GET    │     /v1/flows/active     │
│         ▲                           │◄──────────────│                          │
│         │                           │               │     /v1/admin/*          │
│  flusher / flowSync / upgradeSync   │               │     /auth/*              │
│  (background loops)                 │               │     /healthz             │
└─────────────────────────────────────┘               └──────────────────────────┘
```

The hub never reaches into the fleet — the fleet always *pulls*. This keeps
firewalls one-directional and removes the need to address individual
installations from the hub.

---

## 2. Running the hub

### 2.1 npx (single-tenant tryout)

```bash
export AGENFK_HUB_SECRET_KEY="$(openssl rand -hex 32)"
export AGENFK_HUB_SESSION_SECRET="$(openssl rand -hex 32)"
export AGENFK_HUB_INITIAL_ADMIN_EMAIL=you@example.com
export AGENFK_HUB_INITIAL_ADMIN_PASSWORD=changeme123
npx --package github:cglab-public/agenfk agenfk-hub
```

Add `--beta` to pull the latest pre-release. Open `http://localhost:4000/`.

### 2.2 Docker

The build context must be the **monorepo root**, not `packages/hub`, so the
workspace deps resolve:

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

Or via compose:

```bash
cp packages/hub/.env.example packages/hub/.env
# edit packages/hub/.env — at minimum AGENFK_HUB_SECRET_KEY and AGENFK_HUB_SESSION_SECRET
docker compose -f packages/hub/docker-compose.yml up -d
```

The compose file mounts a named `hub-data` volume at `/data`.

### 2.3 Releases — global vs hub-only

The hub ships through two independent release paths:

- **Global releases** (`v*` tags, `release.yml`): the framework tarball
  (`agenfk-dist.tar.gz`) includes the hub — every framework release is also a
  hub release.
- **Hub-only releases** (`hub-v*` tags, `hub-image.yml`): for shipping the hub
  *between* framework releases. Pushing a `hub-v*` tag builds + pushes the
  GHCR Docker image (`ghcr.io/<owner>/<repo>/agenfk-hub:<tag>` + `:latest`)
  and creates a GitHub Release carrying `agenfk-hub-dist.tar.gz` (packaged by
  `scripts/package-hub-dist.mjs`: hub + hub-ui + core dists and the root
  manifests — no framework surfaces) for non-Docker deployments.

Cut a hub-only release with the repo-private `/agenfk-release-hub` command
(`.claude/commands/agenfk-release-hub.md`): it bumps `packages/hub/package.json`
only, tags `hub-v<version>`, and pushes; CI does the rest. The `hub-v*` and
`v*` tag namespaces never collide.

### 2.4 Production posture

- Run **behind TLS** (nginx, Caddy, an LB) and set `NODE_ENV=production` so
  session cookies are flagged `Secure`.
- The image runs as the non-root user `agenfk` (uid > 1000). Mount your data
  volume with appropriate ownership or rely on the image's `chown -R`.
- `HEALTHCHECK` pings `/healthz` every 30s; orchestrators (Kubernetes, ECS,
  Nomad, Swarm) will restart unhealthy containers.
- `tini` is the entrypoint, so `SIGTERM` from the orchestrator reaches Node
  directly and graceful shutdown works.
- Back up the contents of `/data` (`hub.sqlite`, `-wal`, `-shm`) on the same
  cadence as any other system-of-record.

### 2.5 Port autoselection

The hub binds to `AGENFK_HUB_PORT` (default `4000`) and the local fleet
server binds to `AGENFK_PORT` (default `3000`). The fleet server picks the
**first free port at-or-after** its requested value, then writes the bound
port to `~/.agenfk/server-port`. Any tooling that needs to reach the local
server (the UI, CLI, install script) reads that file rather than assuming
`3000`. This makes side-by-side installs and corp-hub-co-located dev safe.

### 2.6 Configuration

| Variable | Required | Purpose |
|---|---|---|
| `AGENFK_HUB_SECRET_KEY` | yes | 32-byte AES-256-GCM key (64 hex / 44 base64) for OIDC client-secret encryption. |
| `AGENFK_HUB_SESSION_SECRET` | yes | HMAC key for session cookies. |
| `AGENFK_HUB_PORT` | no | Listen port (default `4000`). |
| `AGENFK_HUB_DB` | no | `sqlite` (default) or `postgres`. |
| `AGENFK_HUB_DB_PATH` | no | SQLite file path (Docker default `/data/hub.sqlite`). |
| `AGENFK_HUB_PG_URL` | when `AGENFK_HUB_DB=postgres` | `pg`-driver DSN. |
| `AGENFK_HUB_ORG_ID` | no | Default org for single-tenant deployments (`default`). |
| `AGENFK_HUB_PUBLIC_URL` | no | Origin used in OIDC redirects + magic-link emails. |
| `AGENFK_HUB_INITIAL_ADMIN_EMAIL` / `_PASSWORD` | no | Bootstraps the first admin without the `/setup` wizard. |
| `AGENFK_HUB_UI_DIR` | no | Override for the SPA bundle path (auto-detected). |
| `AGENFK_HUB_LIVE_INSTALL_WINDOW_HOURS` | no | How recently an installation must have reported to block an identity merge (default `48`). A machine dormant longer stops blocking; the alias the merge records is what prevents it resurrecting the key. |

For staging deployments, secrets typically live in AWS Secrets Manager (or
equivalent) under `agenfk-hub-<env>/{pg-url,hub-secret-key,hub-session-secret}`
and project into the task as env vars.

---

## 3. Storage

The hub speaks one schema with two backends:

- **SQLite** (default). `better-sqlite3`-compatible, WAL mode, single-file
  database at `AGENFK_HUB_DB_PATH`. Suited for small-to-mid orgs running one
  hub instance.
- **Postgres** (`AGENFK_HUB_DB=postgres`, DSN in `AGENFK_HUB_PG_URL`). For
  multi-instance deployments and standard ops tooling. Same schema, same
  application code; a small dialect translator rewrites `?` placeholders into
  `$1, $2, …` and adapts the few SQLite-isms.

Schema bootstrap and column-add migrations run on every boot
(`CREATE TABLE IF NOT EXISTS …`, then per-table `ALTER TABLE … ADD COLUMN`
guarded by `information_schema` / `PRAGMA table_info`). Migrations are
idempotent and forward-only. The hub user needs only `CREATE`, `SELECT`,
`INSERT`, `UPDATE`, `DELETE`, and `ALTER` on its own database. No superuser,
no extensions required.

### Core tables

| Table | What it holds |
|---|---|
| `orgs` | One row per organisation. |
| `users` | Hub admins/viewers (per org). Login + role. |
| `auth_config` | Per-org toggles for password / Google / Entra, OIDC client id+secret (encrypted), email allowlist. |
| `api_keys` | Per-installation tokens. Hashed; never stored plain. Bound to an `installation_id` after the magic-link flow. |
| `installations` | One row per fleet machine that has ever spoken to the hub. Carries `agenfk_version` + `_updated_at` (the **running version**, see §5.4). |
| `events` | Append-only activity log. PK `event_id` is supplied by the client (UUID), so re-delivery is idempotent. Each row also carries the `reporting_version` that delivered it (the `X-Agenfk-Version` header — see §5.5). |
| `rollups_daily` | Pre-aggregated counts used by the dashboard's histogram. |
| `flows` + `flow_assignments` | Hub-owned flow definitions and their org/project bindings. |
| `upgrade_directives` + `upgrade_directive_targets` | Admin-issued fleet upgrades and their per-installation rollout state, including `result_version` (on-disk after the upgrade). |
| `device_codes`, `used_invites` | Onboarding ceremonies (device-code login, magic-link invites). |

### Idempotency

The ingest path uses `INSERT OR IGNORE` on `events.event_id`, so the client
can safely retry a batch after a network blip — duplicates land as `skipped`
in the response and never double-count. Per-batch metadata (the version
header, fleet-upgrade transitions) is applied **outside** the per-event
duplicate gate, so a retry of an already-ingested batch still keeps the
installation row fresh.

### Choosing a backend

For most orgs SQLite is enough. Move to Postgres when you need multiple hub
instances, cross-AZ HA, point-in-time recovery, or fleet-wide audit tooling.
Common production paths:

- **AWS** — RDS for PostgreSQL or Aurora PostgreSQL.
- **GCP** — Cloud SQL or AlloyDB.
- **Azure** — Azure Database for PostgreSQL Flexible Server.
- **Self-hosted** — any PostgreSQL ≥ 13 reachable on `AGENFK_HUB_PG_URL`.

The hub deliberately does **not** ship a compose Postgres service: production
Postgres is a database operator's call. Migrating an existing SQLite hub to
Postgres is not built in — treat SQLite as the single-tenant on-ramp.

---

## 4. Authentication

Two distinct realms share `auth_config`:

### 4.1 Human admins → cookie sessions

- **Email + password** (`createPasswordUser` in `auth/password.ts`). bcrypt
  hash. The first user created via `/setup/initial-admin` (or via
  `AGENFK_HUB_INITIAL_ADMIN_*` env vars) bootstraps the org as `role=admin`.
- **Google OIDC** at `/auth/google/{start,callback}` — uses
  `auth_config.google_*` encrypted client secret and the org's
  `email_allowlist`.
- **Microsoft Entra (Azure AD) OIDC** at `/auth/entra/{start,callback}` —
  same shape, with tenant id.
- **Sessions**: HMAC-signed cookie (`SESSION_COOKIE`) created by
  `signSession` with `sessionSecret`. `requireSession` and `requireAdmin`
  middleware enforce presence + role on the relevant routes.
- **Device-code flow** at `POST /auth/device/{start,poll,approve}` lets the
  CLI obtain a session via an admin-approved code shown in the terminal.

#### Invite-required SSO

A successful Google or Entra OIDC handshake **does not auto-create a hub
user** — even if the email passes the allowlist. The IdP only proves "this
person controls this email"; an admin must have already invited that email
into the hub. `findInvitedSsoUser` (in `auth/oauth.ts`) looks the user up
by `(provider, provider_subject)` first, then by email; if neither matches
an existing row, the callback returns 403 *"Account not invited — ask your
admin to invite you first"* without setting a session.

Admins invite users from **Admin → Users → Invite user**. The form has an
**Auth method** toggle:

- **Password** — admin sets an initial password. The user can sign in with
  email + password, or later via SSO using the same email (the email-match
  upgrade flips `provider` from `password` to `google`/`entra` in place,
  preserving the row id and role; password sign-in is then locked out for
  that user because `/auth/login` rejects when `provider !== 'password'`).
- **SSO only** — no password is collected. The row is inserted with
  `password_hash = NULL` so password login is permanently impossible
  (`/auth/login` rejects on `!user.password_hash`). The user must sign in
  via Google/Entra; first SSO sign-in upgrades the row in place.

The email allowlist (`auth_config.email_allowlist`) still runs as a second
gate before the user lookup, so an admin who accidentally invites an
out-of-scope email cannot let that user in. New SSO sign-ins default to
`role=viewer` only via the *invite* — there is no implicit role.

### 4.2 Installations → bearer API keys

- `agk_<64-hex>` tokens, generated by `generateApiKey()` and stored as a
  SHA-256 digest in `api_keys.token_hash`. The hub never persists the
  cleartext.
- Issued from the admin UI (or `POST /v1/admin/api-keys`) — initially
  unbound. The **magic-link** flow at `POST /hub/invite/redeem` binds the
  token to the calling machine's `installation_id`, `os_user`, `git_name`,
  `git_email` so the hub can recognise it on subsequent calls.
- Magic-link invites: admins generate one or more invites from
  **Admin → API keys → Generate invite** (the button keeps producing fresh
  cards, each with its own copy/dismiss controls). The response includes
  the public hub URL, so the rendered command is fully self-contained:
  `agenfk hub join <hubUrl> <inviteToken>`. Recipients paste it as-is — no
  `AGENFK_HUB_URL` or pre-existing `~/.agenfk/hub.json` required. The
  legacy single-arg form `agenfk hub join <inviteToken>` still works when
  the receiver already has a hub config or sets `AGENFK_HUB_URL`.
- The client sends `Authorization: Bearer <token>` plus
  `X-Installation-Id: <uuid>` and `X-Agenfk-Version: <semver>` on every
  request. `requireApiKey` middleware looks the token up by hash, attaches
  `req.hubApiKey = { orgId, tokenHash, installationId }`, and rejects
  revoked or unknown tokens.

Issuing a token to a developer:

```
Sign in as admin → Admin → API keys → Issue
# copy the agk_… (shown once)
```

Then on each fleet machine:

```bash
agenfk hub login --url https://hub.acme.com --token agk_… --org default
```

`agenfk hub status` and `agenfk hub flush` inspect and force the local
outbox.

---

## 5. Client → Hub: ingest

Code: `packages/server/src/hub/{hubClient,flusher,types,identity}.ts`.

### 5.1 Configuration discovery

`loadHubConfig()` tries env vars first, then `~/.agenfk/hub.json`:

```json
{
  "url":   "https://hub.example.com",
  "token": "agk_…",
  "orgId": "acme"
}
```

If any of `AGENFK_HUB_URL`, `AGENFK_HUB_TOKEN`, `AGENFK_HUB_ORG` is missing
and the file is absent, the client runs in **disabled** mode — `recordEvent`
is a no-op. The server keeps working without a hub.

### 5.2 Local outbox

Every interesting state change calls `HubClient.recordEvent({ type, payload,
projectId?, itemId?, itemTitle?, externalId?, remoteUrl? })`. The client
synthesises a `HubEvent`:

```ts
{
  eventId:        randomUUID(),       // idempotency key
  installationId,                     // bound at boot
  orgId,                              // from hub config
  occurredAt:     new Date().toISOString(),
  actor:          { osUser, gitName, gitEmail, cwd },
  projectId, itemId, itemType, itemTitle, externalId, remoteUrl,
  type, payload,
}
```

…and writes it to the **outbox table** in the local SQLite. That call is the
*only* synchronous work the request path does — there is no inline HTTP
call. If the hub is down, the request still succeeds; the event queues
locally.

`resolveActor(cwd)` reads `git config user.name/.email` for the project the
action happened in, falling back to OS user. This is what ties events back
to humans in the dashboard.

### 5.3 Flusher

`Flusher` runs a background timer every `intervalMs` (30 s by default):

1. `hubOutboxPeekDeliverable(batchSize, orgId)` — up to 500 rows that
   carry *this installation's* org stamp (see §5.6; rows stamped for
   another org never enter a batch, and never starve the ones behind
   them).
2. `POST /v1/events` with `{ events }` and these headers:

   ```
   Authorization:    Bearer <token>
   X-Installation-Id: <uuid>
   X-Agenfk-Version:  <semver>
   Content-Type:     application/json
   ```
3. On `2xx`: delete the rows, clear `lastError`, reset backoff — except
   that a cycle which *refused* events (§5.6) keeps `lastError` set, and
   a cycle with nothing deliverable clears a historical `lastError` (a
   no-op is not a failed attempt).
4. On `5xx` / network: increment `attempts`, set
   `nextEligibleAt = now + min(MAX_BACKOFF, intervalMs * 2^attempts)`.
   Capped at 5 min.
5. On `4xx`: increment attempts. After five consecutive 4xx responses the
   flusher **halts** (`status.halted = true`). The dashboard surfaces this
   as a "halted-flusher" banner so the admin can rotate the api_key.

`flush()` collapses overlapping ticks (`inflight` promise), so a slow
round-trip plus a fast timer never queues two batches.

`flushNow(timeoutMs)` is a synchronous primitive used by `upgradeSync` to
make sure the `fleet:upgrade:started` event lands on the hub *before* the
running process hands control to a CLI that may kill it.

### 5.4 `installations.agenfk_version` — the running version

The flusher resolves its `CURRENT_VERSION` once at module load (from
`packages/server/package.json`) and bakes it into the axios default headers.
Every batch carries that value as `X-Agenfk-Version`.

The hub validates the header against a strict semver allowlist and stamps
it onto the installation row **once per batch** (outside the per-event
duplicate gate, so an outbox replay of already-ingested events still keeps
the row fresh):

```sql
UPDATE installations
   SET agenfk_version = :header,
       agenfk_version_updated_at = now
 WHERE id = :installationId AND org_id = :orgId
```

This means `installations.agenfk_version` is the version of the **module
currently loaded in memory** on the fleet process, not the version on disk.
The two diverge when an upgrade lands new files but the process doesn't
restart — and that divergence is *information*, not a bug to paper over.
On-disk truth lives separately on `upgrade_directive_targets.result_version`
(§7.4). Surfacing both lets admins see "the upgrade landed, but a process
is stuck on the old code" at a glance.

### 5.5 `events.reporting_version` — per-event observability

Each event row also stores the `X-Agenfk-Version` header that delivered it
(or `NULL` if absent/malformed) in `events.reporting_version`. The Recent
Events admin view renders it as a small `v<version>` badge on every row.

This makes stuck processes visible directly in the activity stream: when
recent events are still tagged with the pre-upgrade version after a
`fleet:upgrade:succeeded`, the in-memory module did not pick up the new
code.

### 5.6 The org tenancy boundary (CGLAB-117)

Every event carries an `orgId` stamp — the **tenancy watermark**. It is
set when the event is queued (`hub login`/`join` stamp it; events queued
before any login carry the empty sentinel `''`, which boot-time stamping
adopts into the current org) and it is the boundary the hub enforces on
ingest. The invariant this section documents:

> **A→B no-leak:** an installation bound to org A can never deliver,
> move, or destroy an event stamped for any other org — and a rejected
> event is never deleted without a preserved copy.

This exists because of a real incident (31 Aug 2026): a test fixture
clobbered a live `~/.agenfk/hub.json`, the installation began flushing
another org's queued events, the hub rejected all 57 inside a `200 OK`,
and the flusher deleted them with the batch. Recovery was SQLite WAL
forensics. Every layer below closes one step of that chain.

**Hub side — per-event rejections** (`packages/hub/src/routes/events.ts`).
`POST /v1/events` answers with
`{ ingested, skipped, rejected, hiddenDropped, rejections: [{ eventId, reason }] }`.
The reason taxonomy is exactly four codes:

| reason | meaning |
| --- | --- |
| `invalid` | event failed schema validation (no usable `eventId`, bad shape) |
| `org_mismatch` | `orgId` ≠ the org the api key is bound to |
| `foreign_installation` | installation not bound to this key, or not enrolled in this org (BOLA guard) |
| `hidden_user` | installation's user is hidden from the org |

**Spoke side — the boundary is enforced before the POST, in SQL.**
`hubOutboxPeekDeliverable(limit, orgId)` selects only rows whose payload
stamp equals the configured org (or the `''` sentinel). Stale-stamped
rows *stay in the outbox* — they never enter a batch, never consume
attempts, and never starve the head of the queue. They surface as
`staleOrgDepth` in `/internal/hub/status`, `agenfk hub status`, and
`agenfk hub flush`.

**Spoke side — the deadletter file.** When a modern hub reports
rejections, the rejected rows are written to
`~/.agenfk/hub-deadletter.jsonl` (one JSON line per event:
`{ eventId, occurredAt, deadletteredAt, reason, payload }`, file mode
`0600`) *before* they leave the outbox; if that write
fails, the rows stay for retry. Nothing is ever deleted without a
preserved copy. Against an **old hub** (no `rejections` field, just
`rejected > 0`) the flusher deletes *nothing* — the batch is kept and
re-sent (hub-side `INSERT OR IGNORE` makes re-sends idempotent) with a
loud `lastError` and escalating backoff.

**`agenfk hub deadletter`** lists what was refused, grouped by org stamp
(unparseable lines are shown, never silently dropped), and
`agenfk hub deadletter discard --org X | --all` removes entries —
re-reading the file immediately before writing, writing atomically
(tmp + rename), and preserving unparseable lines on `--org` discards.

**`agenfk hub carry-over` is the sole stamp-rewrite path.** It moves
queued events from one *named* org stamp to another:
`agenfk hub carry-over --from <orgId> --to <orgId>`. It is
deliberately heavy:

- prints a summary first (count, `occurredAt` range, event types, per
  org, descending);
- warns LOUDLY when the target is not the configured org — the events
  are then *carried but still not deliverable*;
- demands a typed confirmation of the **target** org id (`--yes` skips;
  a non-TTY run refuses rather than hanging);
- POSTs the rewrite to the local server's
  `/internal/hub/rewrite-outbox-org` (verify-token gated);
- **audits every run** to `~/.agenfk/hub-audit.jsonl`
  (`{ at, from, to, rewritten, osUser }`). An audit failure after a
  successful rewrite is shouted, never swallowed.

Nothing else rewrites an existing stamp across named orgs. `hub repoint --carry-over`
(an org *rename* — same tenancy, new id) is the only repoint variant that touches the
outbox, and it routes through the same confirm + audit sequence; plain `hub repoint`
prints the exact carry-over command and leaves the outbox untouched.

**Reporting.** `agenfk hub flush` exits `1` with a red diagnostic when
the cycle ends with `lastError` (transport failure *or* refusals — a
`200` containing rejections is an error, not a green success), prints
yellow carry-over guidance when stale rows remain, and only prints
`✓ Flush completed` when the outbox is clean. `agenfk hub status` shows
`Stale-org rows`, `Deadlettered`, and the per-org outbox breakdown.
`hub login`/`hub join` print the same stale-org guidance after writing
config — with exact counts and ready-to-run commands — and never
auto-rewrite a non-empty foreign org. Identity gates: `login` (both
paths) and `join` refuse to persist a `hub.json` unless the URL they are
about to persist answers `/healthz` with `service=agenfk-hub` —
including the server-supplied `hubUrl` in redeem/device responses.

Code: `packages/server/src/hub/flusher.ts` (boundary, deadletter,
rejection handling), `packages/storage-sqlite/src/index.ts`
(`hubOutboxPeekDeliverable`, `hubOutboxRewriteOrgId`,
`hubOutboxOrgSummaries`), `packages/cli/src/commands/hub.ts`
(carry-over, deadletter, gates, reporting),
`packages/hub/src/routes/events.ts` (rejections). The deadletter path is
a contract between flusher and CLI (`DEFAULT_DEADLETTER_PATH`),
drift-pinned by tests in both packages; the docs↔code facts above are
pinned by `packages/hub/src/test/hub-docs-tenancy.test.ts`.

---

## 6. Client ← Hub: flow synchronisation

Code: `packages/server/src/hub/flowSync.ts`.

Each project on the developer's machine periodically asks the hub "what flow
should I be using?":

```
GET /v1/flows/active?projectId=<id>
Authorization: Bearer <token>
If-None-Match: "<lastEtag>"   ; if we've fetched before
```

The hub looks up `flow_assignments` for `(orgId, scope)` in this precedence:
project → org. It returns either `{ flow: <flowDoc>, hubVersion: 7 }` with
an `ETag`, or `{ flow: null }` if no assignment is bound. `304 Not Modified`
short-circuits the upsert path.

On a 200, `reconcileProjectFlow` upserts the flow into local storage with
`source = 'hub'`, sets `hubFlowId` on the row, and emits `flow:updated`.
Local REST guards refuse client-side writes to `source='hub'` flows — the
hub is authoritative. `runFlowSyncTick()` walks the locally-known projects
and calls `reconcileProjectFlow` for each, threading a per-project ETag
cache so the hub mostly sees `304`s.

Flow definitions are authored in the hub admin UI (powered by
`@agenfk/flow-editor`). Authors can install community flows from the
`registry/flows` endpoint, set per-org defaults, and assign overrides at
project scope.

---

## 7. Fleet upgrade flow (end to end)

The hub can tell the fleet "upgrade to 0.3.0-beta.32". The client decides
whether to comply, runs `agenfk upgrade --version <x>`, and reports back
via ordinary events.

### 7.1 Admin issues the directive

`POST /v1/admin/upgrade` (admin session). Body:

```json
{ "targetVersion": "0.3.0-beta.32",
  "scope": { "type": "all" }                            // or "installation" + installationId
  /* "confirmDowngrade": true if applicable */ }
```

The handler:

1. Validates `targetVersion` against the strict semver allowlist.
2. Resolves the in-scope installations.
3. **Single-pending guard** — refuses (`409`) if any in-scope installation
   already has a `pending` or `in_progress` target on a prior directive.
4. **Downgrade guard** — refuses (`409 + downgrades[]`) when the target
   moves any installation's last-known running version backwards (per
   `compareSemver`), unless `confirmDowngrade=true`.
5. Verifies the version actually exists as a public release (`releaseExists`
   callback hits GitHub by default; tests inject a stub).
6. Inserts one `upgrade_directives` row plus one `upgrade_directive_targets`
   row per in-scope installation, all in state `pending`. Audit fields
   (`created_by_email`, `request_ip`) are denormalised onto the directive.

### 7.2 Fleet polls

`upgradeSync.reconcileUpgradeDirective()` runs on a timer in every fleet
installation. One tick:

1. `GET /v1/upgrade-directive` → `{ directiveId, targetVersion, issuedAt }`
   or `204`. The hub returns the **oldest pending** directive whose
   `installation_id` matches this caller; it does **not** transition state
   on read — that's reserved for the corresponding ingest event.
2. If the local `upgrade_state` already records
   `lastDirectiveId === directiveId`, skip (re-entry safety).
3. Reject malformed `targetVersion` defensively.
4. Append `fleet:upgrade:started` to the outbox.
5. Persist intent to `upgrade_state` *before* spawning the CLI, so a crash
   mid-upgrade can be reconciled on next boot.
6. Call `flushNow(5_000)` so the `started` event lands on the hub *before*
   the upgrade can kill us.
7. Spawn `agenfk upgrade --version <target> --json` **asynchronously**.
   The CLI's last stdout line is JSON: `{ status: "upgraded" | "noop" |
   "failed", fromVersion, toVersion, error? }`.
8. On success, append `fleet:upgrade:succeeded` (with `resultVersion` =
   on-disk after the upgrade) and clear the persisted state — the hub
   becomes the single source of truth.
9. On failure, append `fleet:upgrade:failed` and persist `outcome="failed"`
   so we don't re-spawn on every poll.

#### Why the spawn is async

The CLI invocation is wired through `spawnImpl`, which returns a Promise.
A synchronous `spawnSync` would block the API server's event loop while
`agenfk upgrade` ran, which would in turn make every probe inside the
upgrade flow ("is the local API running?" curl in the CLI, the same check
in `install.mjs`) time out and report `not running`. Those probes drive
the down-then-up restart. With them broken, files would land on disk while
the in-memory process kept executing the old code — visible to admins as
"installation stuck on the old version after the upgrade succeeded". The
async spawn keeps the event loop responsive so the probes resolve
correctly and the auto-restart actually fires.

### 7.3 Boot-time replay

If `agenfk upgrade` killed the running server before it could emit
`succeeded`/`failed`, the new server boots, finds `outcome="started"` in
`upgrade_state`, and `replayPendingUpgradeOutcome()` decides:

- If `running version == intended version` → emit `fleet:upgrade:succeeded`.
- Else → emit `fleet:upgrade:failed`.

Either event is appended to the outbox like any other.

### 7.4 Hub records the outcome

The ingest path in `/v1/events` recognises any of `fleet:upgrade:{started,
succeeded,failed}` and updates the matching `upgrade_directive_targets`
row:

```
state         ← in_progress / succeeded / failed
attempted_at  ← coalesce(now)
finished_at   ← now (on succeeded/failed)
result_version, error_message ← from payload
```

Note: the `result_version` lives on the directive_target row, not on
`installations.agenfk_version`. The latter only updates from the
`X-Agenfk-Version` header (i.e. the running module). If those two diverge
after an upgrade succeeds, the running process did not actually restart —
see §5.4.

The Admin → Upgrades dashboard auto-refreshes (`refetchInterval` while any
directive has `pending > 0` or `in_progress > 0`) so the rollout is
visible live.

### 7.5 `/v1/admin/upgrade/available-versions`

Backs the "Target version" select in Admin → Upgrades.

1. `getAgenfkReleases()` hits
   `https://api.github.com/repos/cglab-public/agenfk/releases?per_page=100`,
   strips drafts and missing tags, caches the result with a 10-minute TTL.
   On a transient GitHub outage the last-good cache is served instead.
2. The route computes the org's **fleet floor** — the oldest non-null
   `installations.agenfk_version` for the session orgId, by `compareSemver`.
3. Filters releases to versions `>= floor` (when present) and sorts
   newest → oldest using `compareSemver` (semver §11-correct, including
   numeric prerelease segments — `beta.24 > beta.9`).
4. Returns `{ versions: string[], fleetFloor: string | null }`.
5. Returns `503` if the cache is empty *and* the GitHub fetch fails.

---

## 8. HTTP surface

All routes mount on one Express app (`packages/hub/src/server.ts`). "Auth"
is the guard.

### 8.1 Health & meta

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/healthz` | none | Liveness — returns `{ ok: true, version }`. |
| GET | `/auth/me` | session | Current user (org id, email, role). |
| GET | `/auth/providers` | none | Which login methods are enabled for this hub. |

### 8.2 Setup & onboarding

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/setup/initial-admin` | none, single-shot | First admin if `users` is empty. |
| POST | `/auth/login` / `/auth/logout` | none / session | Email+password sign-in. |
| GET | `/auth/google/start` & `/callback` | none | OIDC. |
| GET | `/auth/entra/start` & `/callback` | none | OIDC. |
| POST | `/auth/device/start` / `poll` / `approve` | none / none / session | CLI device-code login. |
| POST | `/hub/invite/create` | admin session | Mint a magic-link invitation. Response: `{ inviteToken, hubUrl, joinCommand: "agenfk hub join <hubUrl> <inviteToken>", expiresAt }`. |
| POST | `/hub/invite/redeem` | none | Bind installation to api_key. |

### 8.3 Ingest (client → hub)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/ping` | api_key | Cheap "creds good?" check. |
| POST | `/v1/events` | api_key | `{ events: HubEvent[] }`. Returns `{ ingested, skipped, rejected, installationId }`. Stamps the batch's `X-Agenfk-Version` onto each new event row's `reporting_version` and onto the installation row. |
| GET | `/v1/upgrade-directive` | api_key | Oldest *pending* directive for this installation, or `204`. |

### 8.4 Distribute (client → hub, read-mostly)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/flows/active` | api_key | `{ flow, hubVersion }` for the org/project, or `{ flow: null }`. Honours `If-None-Match` → `304`. |

### 8.5 Query (admin dashboard)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/timeline` | session | Recent events (paginated, filterable by `users`, `types`, `projects`, `itemTypes`, `from`, `to`). Each row includes `reporting_version`. |
| GET | `/v1/histogram` | session | Daily/hourly buckets honouring the same filter set + `tzOffsetMin`. Backs both the org-wide and per-user activity timelines, including the **Today** (intra-day, hour-bucketed) range. |
| GET | `/v1/projects` | session | Distinct `remote_url` chips for the project filter. |
| GET | `/v1/event-types` | session | Distinct event-type strings. |
| GET | `/v1/item-types` | session | Distinct item types + counts honouring current filters. |
| GET | `/v1/users` | session | Active users + last-seen + counts. |
| GET | `/v1/metrics` | session | Aggregate counters. |

### 8.6 Admin (`/v1/admin/*`, all session+admin)

| Method | Path | Notes |
|---|---|---|
| GET / PUT | `/auth-config` | Read or update per-org auth providers + email allowlist. |
| GET / POST / DELETE | `/api-keys` | Manage installation tokens. |
| GET / POST / PUT / DELETE | `/users` (and `/users/invite`, `/users/:id`) | Admin user management. `POST /users/invite` body: `{ email, role, password? }` — password optional (omit for an SSO-only invite, in which case the row is created with `password_hash=NULL` and the user must sign in via Google/Entra). |
| GET / POST / PUT / DELETE | `/flows`, `/flows/:id`, `/flows/default`, `/registry/flows`, `/flows/install` | Flow CRUD plus a community registry installer. |
| GET / PUT | `/flow-assignments` | Bind a flow to an org or project scope. |
| GET | `/projects` | Discovery list of `(project_id, remote_url, last_seen)` derived from `events`. |
| GET | `/installations` | Per-installation rollup (`agenfk_version`, `agenfk_version_updated_at`, last_seen, identity). |
| GET / POST | `/upgrade` | List directives (with rolled-up progress) / issue a new directive. |
| GET | `/upgrade/available-versions` | Versions an admin can target — public GitHub releases filtered to `>= fleet_floor`, newest → oldest. |

---

## 9. Dashboard

The hub UI is a React/Vite SPA served by the hub itself. Its main views:

- **Org dashboard** — fleet-wide rollups, the activity timeline (with
  `7d / 30d / 90d / Today` ranges; Today is hour-bucketed and shows events
  emitted within the current local day), top users/projects/types.
- **User detail** — same timeline scoped to a single user, plus a
  Recent Events list. Each event row shows its emitting type, item type,
  external tracker id, project, item title, occurred-at, and a green
  `v<version>` badge sourced from `events.reporting_version`.
- **Admin → API keys** — issue and revoke installation tokens.
- **Admin → Users** — invite admins/viewers, manage roles.
- **Admin → Flows** — author/edit flow definitions (via
  `@agenfk/flow-editor`), assign them to org/project scope, install from
  the community registry.
- **Admin → Installations** — list of every installation that has spoken
  to the hub, with their last-known running version and last-seen
  timestamp. Divergence between `agenfk_version` here and the
  `result_version` of a recent succeeded directive is the signature of
  a stuck process (§5.4–5.5).
- **Admin → Upgrades** — issue directives, watch rollout progress live.
- **Admin → Auth** — configure password / Google / Entra and the email
  allowlist.

All event timestamps are stored as ISO-UTC and rendered in the viewer's
timezone (the UI passes `tzOffsetMin` so server-side date-bucketing aligns
with the wall clock the admin sees).

---

## 10. Observability & operability

- **`/healthz`** — liveness probe; returns the running hub version too,
  surfaced in the hub UI sidebar.
- **Halted-flusher banner** — surfaces the per-installation "I gave up
  after 5 consecutive 4xx" state so admins notice token rotations.
- **Auto-refresh on Upgrades page** — polls `/v1/admin/upgrade` every 5 s
  while any directive is live, then stops, so an admin watching a rollout
  sees rows transition without page reloads.
- **Per-event reporting version** — the green `v<version>` badge on each
  Recent Events row makes "the upgrade said success but this process is
  still stuck" visible in real time.
- **Auto-refresh on directives** — same five-second refetch logic for the
  Installations view so version drift propagates as soon as the next
  fleet flush completes.

---

## 11. Identity-provider setup

Operator-side configuration for Google and Microsoft Entra OIDC. Both
providers redirect the user back to a hub callback URL — that URL **must
be registered with the IdP exactly as it will appear in production**, so
work out your hub's public origin first (`AGENFK_HUB_PUBLIC_URL`, e.g.
`https://hub.acme.com`).

### 11.1 Google Workspace / Google OAuth

1. **Pick a project** in [Google Cloud Console](https://console.cloud.google.com).
2. **OAuth consent screen** (APIs & Services → OAuth consent screen):
   - User type: *Internal* if every signed-in user belongs to your
     Workspace; *External* otherwise.
   - App name, support email, developer contact: required.
   - Scopes: add `openid`, `email`, `profile`. The hub does not need any
     Google API beyond OIDC userinfo.
3. **Create the OAuth client** (APIs & Services → Credentials → *Create
   credentials* → *OAuth client ID*):
   - Application type: **Web application**.
   - Authorised redirect URI: `<AGENFK_HUB_PUBLIC_URL>/auth/google/callback`
     (e.g. `https://hub.acme.com/auth/google/callback`).
   - Save. Google shows the **client ID** and **client secret** once.
4. **In the hub** (signed in as admin → **Admin → Auth**):
   - Toggle **Google** on.
   - Paste the client ID and client secret. The secret is encrypted with
     `AGENFK_HUB_SECRET_KEY` (AES-256-GCM) before persisting; only the
     decrypted form ever leaves memory during the OIDC exchange.
   - Optionally tighten the **email allowlist** (`acme.com`,
     `*.subsidiary.com`, or specific addresses).
   - Save.
5. **Invite users** (**Admin → Users → Invite user → Auth method: SSO
   only**) so they're allowed to complete the SSO sign-in. Without an
   invite they'll get a 403 "Account not invited" even with a valid
   Google login. The first sign-in upgrades their row in place.

Things that commonly go wrong: redirect URI mismatch (must match the
public origin the hub sees, not `localhost` if you're running behind a
reverse proxy — set `AGENFK_HUB_PUBLIC_URL` and the `X-Forwarded-Proto`/
`X-Forwarded-Host` headers); consent screen still in test mode (External
users will be blocked until it's published or they're added as test
users); `email_verified=false` from Google (the hub rejects with 403, by
design).

### 11.2 Microsoft Entra (Azure AD)

1. **Register the application** in the [Microsoft Entra admin
   center](https://entra.microsoft.com) → *Identity → Applications → App
   registrations → New registration*:
   - Name (anything you like — appears on the consent prompt).
   - Supported account types: pick the narrowest one that fits.
     *Single tenant* is correct when only your own tenant should sign in.
     *Multitenant* if you want users from any Entra tenant. Personal
     Microsoft accounts are off by default; enable only if you really
     need them.
   - Redirect URI: platform **Web**, value
     `<AGENFK_HUB_PUBLIC_URL>/auth/entra/callback`.
   - Register. Note the **Application (client) ID** and the **Directory
     (tenant) ID** from the Overview page.
2. **API permissions** (the same blade): the default Microsoft Graph
   `User.Read` is enough — the hub only needs the OIDC scopes
   `openid email profile` and reads the resulting id-token claims.
   *No admin consent is required for these scopes.*
3. **Client secret** (*Certificates & secrets → New client secret*):
   - Description + expiry. Pick the shortest expiry your operations can
     handle and put a rotation reminder somewhere.
   - Copy the **Value** field (not the Secret ID) — Entra shows it once.
4. **Token configuration** (recommended): under *Token configuration →
   Add optional claim*, add `email` to the **ID token**. Some tenants
   don't emit `email` by default; without it the hub falls back to
   `preferred_username`, which on consumer/MSA accounts is not always an
   email. Adding the optional claim avoids surprises.
5. **In the hub** (**Admin → Auth**):
   - Toggle **Microsoft Entra** on.
   - **Tenant ID**: paste the Directory (tenant) ID from step 1, or
     `organizations` for any work/school tenant, or `common` for any
     account (only if your "Supported account types" allows it).
   - **Client ID**: the Application (client) ID.
   - **Client secret**: the *Value* you copied from step 3.
   - Optionally restrict the email allowlist.
   - Save.
6. **Invite users** the same way as for Google. The user-lookup gate is
   provider-agnostic.

Things that commonly go wrong: registering the wrong tenant id (Directory
ID vs Application ID — these are easy to swap); using *Secret ID* instead
of *Value*; pasting an expired secret (rotate before the visible expiry,
not after); `id_token` missing `email` (add the optional claim above);
proxy stripping `X-Forwarded-Proto` so the hub computes an `http://…`
redirect URI that doesn't match the registered `https://…` value.

### 11.3 What the user sees

After provider config + invite:

1. User opens the hub URL → Login page shows **Sign in with Google** /
   **Sign in with Microsoft** buttons (only the providers you enabled).
2. Click → IdP consent → redirected back to
   `/auth/{google,entra}/callback?code=…&state=…`.
3. Hub validates state cookie + exchanges the code, runs the allowlist,
   then `findInvitedSsoUser`. If they're invited, a session cookie is set
   and they land on `/`. If not, **403 "Account not invited — ask your
   admin to invite you first"** — no session cookie, no row created.

---

## 12. Quick reference: who owns what

| Concern | Owner | Notes |
|---|---|---|
| Activity events | Client *writes*, hub *stores* | Idempotent on `event_id`. |
| Workflow definitions (hub-bound) | Hub | Local writes refused for `source='hub'`. |
| Workflow definitions (local) | Client | Hub never sees them. |
| Fleet target version | Admin issues, fleet polls | Single-pending + downgrade guards. |
| Spawning `agenfk upgrade` | Client only | Hub never reaches the fleet. |
| Installation identity | Hub assigns at first call; client persists in api_key + outbox events. |
| Available release list | Hub (cached from public GitHub) | Fleet-floor filter is per-org. |
| `installations.agenfk_version` | Header from the running module — i.e. the version actually executing in memory. | Updates once per batch. |
| `upgrade_directive_targets.result_version` | Payload of `fleet:upgrade:succeeded` — i.e. on-disk after the upgrade. | Per-directive, not the global "running" view. |
| `events.reporting_version` | Header that delivered each individual event. | Per-event observability for stuck processes. |
