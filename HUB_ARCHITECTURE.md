# Hub Architecture

This document describes the **AgEnFK Hub** — the corporate-side server that
collects activity from a fleet of `agenfk` installations, gates upgrades, and
distributes shared workflow definitions — and how the client (the per-machine
`agenfk` server inside each developer's workspace) talks to it.

For the framework-as-a-whole picture see `AFK_ARCHITECTURE.md`. For the
lifecycle the hub helps enforce, see `SDLC.md`. This file zooms into the hub
and the client↔hub wire.

---

## 1. Purpose and shape

The hub is a single Node/Express service backed by SQLite (default) or
Postgres (optional). It owns four concerns:

1. **Ingest** — receives append-only activity events from every installation.
2. **Query** — admin/dashboard read APIs over those events.
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
┌─────────────────────────────────────┐               ┌────────────────────────┐
│  agenfk CLI / MCP / IDE plugin      │               │                        │
│         │                           │               │     /v1/events         │
│         ▼                           │  HTTPS POST   │     /v1/ping           │
│  agenfk server  ───── HubClient ───►│──────────────►│     /v1/upgrade-directive│
│  (writes outbox to local sqlite)    │  HTTPS GET    │     /v1/flows/active   │
│         ▲                           │◄──────────────│                        │
│         │                           │               │     /v1/admin/*        │
│  flusher / flowSync / upgradeSync   │               │     /auth/*            │
│  (background loops)                 │               │     /healthz           │
└─────────────────────────────────────┘               └────────────────────────┘
```

The hub never reaches into the fleet — the fleet always *pulls*. This keeps
firewalls one-directional and removes the need to address individual
installations from the hub.

---

## 2. Storage

The hub speaks one schema with two backends:

- **SQLite** (default). `better-sqlite3`-compatible, WAL mode, single-file
  database under `AGENFK_HUB_DB_PATH` (default `~/.agenfk-hub/db.sqlite`).
  Suited for small-to-mid orgs running one hub instance.
- **Postgres** (`AGENFK_HUB_DB=postgres`, connection in `AGENFK_HUB_PG_URL`).
  For multi-instance deployments and standard ops tooling. Same schema, same
  application code; a small dialect translator rewrites `?` placeholders into
  `$1, $2, …` and adapts the few SQLite-isms.

Schema bootstrap and column-add migrations run on every boot (`CREATE TABLE
IF NOT EXISTS …`, then per-table `ALTER TABLE … ADD COLUMN` guarded by
`information_schema` / `PRAGMA table_info`). Migrations are idempotent and
forward-only.

### Core tables

| Table | What it holds |
|---|---|
| `orgs` | One row per organisation. |
| `users` | Hub admins/viewers (per org). Login + role. |
| `auth_config` | Per-org toggles for password / Google / Entra, OIDC client id+secret (encrypted), email allowlist. |
| `api_keys` | Per-installation tokens. Hashed; never stored plain. Bound to an `installation_id` after the magic-link flow. |
| `installations` | One row per fleet machine that has ever spoken to the hub. Carries `agenfk_version` + `_updated_at`. |
| `events` | Append-only activity log. PK `event_id` is supplied by the client (UUID), so re-delivery is idempotent. |
| `rollups_daily` | Pre-aggregated counts used by the dashboard's histogram. |
| `flows` + `flow_assignments` | Hub-owned flow definitions and their org/project bindings. |
| `upgrade_directives` + `upgrade_directive_targets` | Admin-issued fleet upgrades and their per-installation rollout state. |
| `device_codes`, `used_invites` | Onboarding ceremonies (device-code login, magic-link invites). |

### Idempotency

The ingest path uses `INSERT OR IGNORE` on `events.event_id`, so the client
can safely retry a batch after a network blip — duplicates land as `skipped`
in the response and never double-count.

---

## 3. Authentication

Two distinct realms share `auth_config`:

### 3.1 Human admins → cookie sessions

- **Email + password** (`createPasswordUser` in `auth/password.ts`). bcrypt
  hash, configurable per org. The first user created via `/setup/initial-admin`
  bootstraps the org as `role=admin`.
- **Google OIDC** at `/auth/google/{start,callback}` — uses `auth_config.google_*`
  encrypted client secret and the org's `email_allowlist`.
- **Microsoft Entra (Azure AD) OIDC** at `/auth/entra/{start,callback}` — same
  shape, with tenant id.
- **Sessions**: HMAC-signed cookie (`SESSION_COOKIE`) created by `signSession`
  with `sessionSecret`. `requireSession` and `requireAdmin` middleware enforce
  presence + role on the relevant routes.
- **Device-code flow** at `POST /auth/device/{start,poll,approve}` lets the
  CLI obtain a session via an admin-approved code shown in the terminal.

### 3.2 Installations → bearer API keys

- `agk_<64-hex>` tokens generated by `generateApiKey()`, stored as SHA-256
  digest in `api_keys.token_hash`. Hub never persists the cleartext.
- Issued from the admin UI (or via `POST /v1/admin/api-keys`) — initially
  unbound; the **magic-link** flow at `POST /hub/invite/redeem` binds the
  token to the calling machine's `installation_id`, `os_user`, `git_name`,
  `git_email` so the hub can recognise it on subsequent calls.
- The client sends `Authorization: Bearer <token>` plus an
  `X-Installation-Id: <uuid>` header. `requireApiKey` middleware looks the
  token up by hash, attaches `req.hubApiKey = { orgId, tokenHash, installationId }`,
  and rejects revoked or unknown tokens.
- `X-Agenfk-Version: <semver>` is also sent on every batch and used to keep
  `installations.agenfk_version` fresh.

---

## 4. HTTP surface

All routes are mounted under one Express app (`packages/hub/src/server.ts`).
"Auth" column shows what guard is on the route.

### 4.1 Health & meta

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/healthz` | none | Liveness — returns `{ ok: true, version }`. |
| GET | `/auth/me` | session | Current user (org id, email, role). |
| GET | `/auth/providers` | none | Which login methods are enabled for this hub. |

### 4.2 Setup & onboarding

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/setup/initial-admin` | none, single-shot | Creates the first admin if `users` is empty for the org. |
| POST | `/auth/login` / `POST /auth/logout` | none / session | Email+password sign-in. |
| GET | `/auth/google/start` & `/callback` | none | OIDC dance. |
| GET | `/auth/entra/start` & `/callback` | none | OIDC dance. |
| POST | `/auth/device/start` / `poll` / `approve` | none / none / session | CLI device-code login. |
| POST | `/hub/invite/create` | admin session | Mint a magic-link invitation. |
| POST | `/hub/invite/redeem` | none | Client redeems the magic link to bind its installation to an api_key. |

### 4.3 Ingest (client → hub)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/ping` | api_key | Cheap "are my creds good?" check. |
| POST | `/v1/events` | api_key | Append a batch of activity events. Body: `{ events: HubEvent[] }`. Returns `{ ingested, skipped, rejected, installationId }`. |
| GET | `/v1/upgrade-directive` | api_key | Returns the oldest *pending* directive whose target row matches this installation, or `204` if there is none. |

### 4.4 Distribute (client → hub, read-mostly)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/flows/active` | api_key | Returns `{ flow, hubVersion }` for the org/project, or `{ flow: null }` if no assignment. Honours `If-None-Match` → `304 Not Modified` with the same `ETag`. |

### 4.5 Query (admin dashboard)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/timeline` | session | Recent events (paginated, filterable by `users`, `types`, `projects`, `itemTypes`, `from`, `to`). |
| GET | `/v1/histogram` | session | Daily/hourly buckets honouring the same filter set + `tzOffsetMin`. |
| GET | `/v1/projects` | session | Distinct `remote_url` chips for the project filter. |
| GET | `/v1/event-types` | session | Distinct event-type strings. |
| GET | `/v1/item-types` | session | Distinct item types + counts honouring current filters. |
| GET | `/v1/users` | session | Active users + last-seen + counts. |
| GET | `/v1/metrics` | session | Aggregate counters. |

### 4.6 Admin (`/v1/admin/*`, all session+admin)

| Method | Path | Notes |
|---|---|---|
| GET / PUT | `/auth-config` | Read or update the per-org auth providers and email allowlist. |
| GET / POST / DELETE | `/api-keys` | Manage installation tokens. |
| GET / POST / PUT / DELETE | `/users` (and `/users/invite`, `/users/:id`) | Admin user management. |
| GET / POST / PUT / DELETE | `/flows`, `/flows/:id`, `/flows/default`, `/registry/flows`, `/flows/install` | Flow CRUD plus a community registry installer. |
| GET / PUT | `/flow-assignments` | Bind a flow to an org or project scope. |
| GET | `/projects` | Discovery list of `(project_id, remote_url, last_seen)` derived from `events`. |
| GET / POST | `/upgrade` | List directives (with rolled-up progress) / issue a new directive. |
| GET | `/upgrade/available-versions` | Versions an admin can target — sourced from public `cglab-public/agenfk` GitHub releases, filtered to `>= fleet_floor`, sorted newest → oldest. |

---

## 5. Client → Hub: `HubClient`, outbox, and `Flusher`

Code: `packages/server/src/hub/{hubClient,flusher,types,identity}.ts`.

### 5.1 Configuration discovery

`loadHubConfig()` (`hubClient.ts`) tries env vars first, then
`~/.agenfk/hub.json`:

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

…and writes it to the **outbox table** in the local SQLite (`hubOutboxAppend`).
That call is the *only* synchronous work the request path does — there is no
direct HTTP call. If the hub is down, the request still succeeds; the event
just queues up locally.

`resolveActor(cwd)` in `identity.ts` reads `git config user.name/.email` for
the project the action happened in, falling back to OS user. This is what
ties events back to humans in the dashboard.

### 5.3 Flusher (the sender)

`Flusher` runs a background timer every `intervalMs` (30 s by default):

1. `hubOutboxPeek(batchSize)` — up to 500 rows.
2. `POST /v1/events` with `{ events }` and these headers:
   ```
   Authorization:   Bearer <token>
   X-Installation-Id: <uuid>
   X-Agenfk-Version:  <semver>
   Content-Type:    application/json
   ```
3. On `2xx`: `hubOutboxDelete(ids)`, clear `lastError`, reset backoff.
4. On `5xx` / network: increment `attempts`, set `nextEligibleAt = now +
   min(MAX_BACKOFF, intervalMs * 2^attempts)`. Capped at 5 min.
5. On `4xx`: increment attempts. After `HALT_AFTER_4XX_ATTEMPTS = 5` failed
   tries the flusher **halts** (`status.halted = true`). The dashboard surfaces
   this as the "halted-flusher" banner so the admin can rotate the api_key
   instead of letting the outbox grow forever.

`flush()` collapses overlapping ticks (`inflight` promise) so a slow round-trip
plus a fast timer never queues two batches.

`flushNow(timeoutMs)` is a synchronous primitive used by `upgradeSync` to make
sure the `fleet:upgrade:started` event lands **before** the running process
hands control to a CLI that may kill it. It bypasses the rate-limiter and
spins until the outbox is empty or the deadline hits.

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
project → org. It returns either `{ flow: <flowDoc>, hubVersion: 7 }` with an
`ETag` header, or `{ flow: null }` if no assignment is bound. `304 Not
Modified` short-circuits the whole upsert path.

On a 200, `reconcileProjectFlow` upserts the flow into local storage with
`source = 'hub'`, sets `hubFlowId` on the row, and emits `flow:updated`. Local
REST guards refuse client-side writes to `source='hub'` flows — the hub is
authoritative.

`runFlowSyncTick()` walks the locally-known projects and calls
`reconcileProjectFlow` for each, threading a per-project ETag cache so the
hub mostly sees `304`s. Backoff and jitter live in `startFlowSync()`.

---

## 7. Fleet upgrade flow (end to end)

The hub can tell the fleet "upgrade to 0.3.0-beta.25". The client decides
whether to comply, runs `agenfk upgrade --version <x>`, and reports back via
ordinary events.

### 7.1 Admin issues the directive

`POST /v1/admin/upgrade` (admin session). Body:

```json
{ "targetVersion": "0.3.0-beta.25",
  "scope": { "type": "all" }                            // or "installation" + installationId
  /* "confirmDowngrade": true if applicable */ }
```

The handler:

1. Validates `targetVersion` against a strict semver allowlist.
2. Resolves the in-scope installations.
3. Checks the **single-pending guard** — refuses (`409`) if any in-scope
   installation already has a `pending` or `in_progress` target on a prior
   directive.
4. Checks for **downgrades** — refuses (`409 + downgrades[]`) when the target
   moves any installation's last-known version backwards (per
   `compareSemver`), unless `confirmDowngrade=true`.
5. Verifies the version actually exists as a public release (a
   `releaseExists` callback hits GitHub by default; tests inject a stub).
6. Inserts one `upgrade_directives` row plus one `upgrade_directive_targets`
   row per in-scope installation, all in state `pending`. Audit fields
   (`created_by_email`, `request_ip`) are denormalised onto the directive.

### 7.2 Fleet polls

`upgradeSync.reconcileUpgradeDirective()` runs on a timer in every fleet
installation. One tick:

1. `GET /v1/upgrade-directive` → `{ directiveId, targetVersion, issuedAt }`
   or `204`. The hub returns the **oldest pending** directive whose
   `installation_id` matches this caller; it does **not** transition state on
   read — that's reserved for the corresponding ingest event.
2. If the local `upgrade_state` already records `lastDirectiveId === directiveId`,
   skip (re-entry safety).
3. Reject malformed `targetVersion` defensively (a compromised hub shouldn't
   land exotic argv into the fleet).
4. Append `fleet:upgrade:started` to the outbox.
5. Persist intent to `upgrade_state` *before* spawning the CLI, so a crash
   mid-upgrade can be reconciled on next boot.
6. Call `flushNow(5_000)` to make sure the `started` event lands on the hub
   *before* the upgrade can kill us.
7. Spawn `agenfk upgrade --version <target> --json`. The CLI's last stdout
   line is JSON: `{ status: "upgraded" | "noop" | "failed", fromVersion,
   toVersion, error? }`.
8. On success, append `fleet:upgrade:succeeded` (with `resultVersion`) and
   clear the persisted state — the hub becomes the single source of truth.
9. On failure, append `fleet:upgrade:failed` and persist `outcome="failed"`
   so we don't re-spawn on every poll.

### 7.3 Boot-time replay

If `agenfk upgrade` killed the running server before it could emit
`succeeded`/`failed`, the new server boots, finds `outcome="started"` in
`upgrade_state`, and `replayPendingUpgradeOutcome()` decides:

- If `running version == intended version` → emit `fleet:upgrade:succeeded`.
- Else → emit `fleet:upgrade:failed`.

Either event is appended to the outbox like any other.

### 7.4 Hub records the outcome

The ingest path in `/v1/events` recognises any of `fleet:upgrade:{started,
succeeded,failed}` and updates the matching `upgrade_directive_targets` row:

```
state         ← in_progress / succeeded / failed
attempted_at  ← coalesce(now)
finished_at   ← now (on succeeded/failed)
result_version, error_message ← from payload
```

The Admin → Upgrades dashboard auto-refreshes (`refetchInterval` while any
directive has `pending > 0` or `in_progress > 0`) so the rollout is visible
live.

### 7.5 `/v1/admin/upgrade/available-versions`

Backs the "Target version" select in Admin → Upgrades.

1. `getAgenfkReleases()` (`services/githubReleases.ts`) hits
   `https://api.github.com/repos/cglab-public/agenfk/releases?per_page=100`,
   strips drafts and missing tags, caches the result with a 10-minute TTL.
   On a transient GitHub outage the last-good cache is served instead, so
   the UI keeps working.
2. The route computes the org's **fleet floor** — the oldest non-null
   `installations.agenfk_version` for the session orgId, by `compareSemver`.
3. Filters releases to versions `>= floor` (when present) and sorts
   `newest → oldest` using `compareSemver` (semver §11-correct, including
   numeric prerelease segments — `beta.24 > beta.9`).
4. Returns `{ versions: string[], fleetFloor: string | null }`.
5. Returns `503` if the cache is empty *and* the GitHub fetch fails — better
   than silently presenting "no versions available".

---

## 8. Configuration (env)

| Variable | Purpose |
|---|---|
| `AGENFK_HUB_PORT` | Listen port (default 4000). |
| `AGENFK_HUB_DB` | `sqlite` (default) or `postgres`. |
| `AGENFK_HUB_DB_PATH` | SQLite file path. |
| `AGENFK_HUB_PG_URL` | Postgres connection string. |
| `AGENFK_HUB_SECRET_KEY` | 32-byte AES-GCM key (hex) for OIDC client-secret encryption. |
| `AGENFK_HUB_SESSION_SECRET` | HMAC secret for the session cookie. |
| `AGENFK_HUB_ORG_ID` | Default org for single-tenant deployments. |
| `AGENFK_HUB_PUBLIC_URL` | Origin used in OIDC redirects + magic-link emails. |

For staging, all secrets live in AWS Secrets Manager under
`agenfk-hub-staging/{pg-url,hub-secret-key,hub-session-secret}` and are
projected into the ECS task as env vars.

---

## 9. Observability & operability

- **`/healthz`** — liveness probe (returns running version too, surfaced in
  the hub UI sidebar).
- **Admin dashboard** — every interaction works from the same query API the
  CLI/MCP cousins use; all event timestamps are stored as ISO-UTC and
  rendered in the viewer's timezone (`tzOffsetMin`).
- **Halted-flusher banner** — surfaces the per-installation "I gave up after 5
  consecutive 4xx" state so admins notice token rotations.
- **Auto-refresh on Upgrades page** — polls `/v1/admin/upgrade` every 5 s
  while any directive is live, then stops, so an admin watching a rollout
  sees rows transition without page reloads.

---

## 10. Quick reference: what the client and the hub each own

| Concern | Owner | Notes |
|---|---|---|
| Activity events | Client *writes*, hub *stores* | Idempotent on `event_id`. |
| Workflow definitions (hub-bound) | Hub | Local writes refused for `source='hub'`. |
| Workflow definitions (local) | Client | Hub never sees them. |
| Fleet target version | Admin issues, fleet polls | Single-pending + downgrade guards. |
| Spawning `agenfk upgrade` | Client only | Hub never reaches the fleet. |
| Installation identity | Hub assigns `installationId` at first call; client persists in api_key + outbox events. |
| Available release list | Hub (cached from public GitHub) | Fleet-floor filter is per-org. |
