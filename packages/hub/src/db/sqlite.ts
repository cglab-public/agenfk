import * as fs from 'fs';
import * as path from 'path';
import type { HubDb, Params, RunResult } from './types';
import { sanitizeRemoteUrl, remoteUrlFromRepo } from '../util/remoteUrl.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type RawDb = InstanceType<typeof DatabaseSync>;

const SCHEMA_SQLITE = `
  CREATE TABLE IF NOT EXISTS orgs (
    id TEXT PRIMARY KEY,
    name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    token_hash TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at TEXT,
    installation_id TEXT,
    os_user TEXT,
    git_name TEXT,
    git_email TEXT
  );

  CREATE TABLE IF NOT EXISTS installations (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    os_user TEXT,
    git_name TEXT,
    git_email TEXT,
    agenfk_version TEXT,
    agenfk_version_updated_at TEXT,
    retired_at TEXT,
    retired_by_user_id TEXT,
    retired_by_email TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    type TEXT NOT NULL,
    project_id TEXT,
    item_id TEXT,
    item_type TEXT,
    remote_url TEXT,
    item_title TEXT,
    external_id TEXT,
    reporting_version TEXT,
    payload TEXT NOT NULL,
    child_hub_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_org_time ON events(org_id, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_events_user_time ON events(org_id, user_key, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(org_id, type, occurred_at);
  -- BUG ab9b39d3: the Admin -> Flows assignment listing looks up the latest
  -- remote_url per project; without this it seq-scans the whole events table.
  CREATE INDEX IF NOT EXISTS idx_events_org_project_time ON events(org_id, project_id, occurred_at);

  CREATE TABLE IF NOT EXISTS rollups_daily (
    org_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    day TEXT NOT NULL,
    events_count INTEGER NOT NULL DEFAULT 0,
    items_closed INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    validate_passes INTEGER NOT NULL DEFAULT 0,
    validate_fails INTEGER NOT NULL DEFAULT 0,
    prs_opened INTEGER NOT NULL DEFAULT 0,
    -- CGLAB-613: flow adherence rolled up from the stamped step.transitioned
    -- payloads CGLAB-612 emits. judged = the event named a flowRevision;
    -- compliant = both statuses were steps of that revision. Additive, 0 on
    -- old rows, so a historical day stays out of both sides of the score.
    transitions_judged INTEGER NOT NULL DEFAULT 0,
    transitions_compliant INTEGER NOT NULL DEFAULT 0,
    -- '' means "this hub's own data". A child hub's id here keeps a group's
    -- series apart without a separate table or a WHERE clause on every
    -- existing query.
    child_hub_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (org_id, child_hub_id, user_key, day)
  );
  CREATE INDEX IF NOT EXISTS idx_rollups_org_day_user ON rollups_daily(org_id, day, user_key);

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    -- Display name as the identity provider reports it. Nullable: password
    -- invites carry no name, and an IdP may withhold the claim.
    name TEXT,
    password_hash TEXT,
    provider TEXT NOT NULL,
    provider_subject TEXT,
    role TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS device_codes (
    device_code TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    org_id TEXT,
    token_hash TEXT,
    approved_at TEXT,
    -- Identity of the machine that started this code, so the token can be
    -- BOUND when it is issued at approve time. Without it the device flow
    -- produced an unbound key, and an unbound key is never handed a fleet
    -- directive — the install went permanently invisible. (BUG 159360db.)
    installation_id TEXT,
    os_user TEXT,
    git_name TEXT,
    git_email TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_device_codes_user_code ON device_codes(user_code);

  CREATE TABLE IF NOT EXISTS used_invites (
    nonce TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    used_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Hub federation (CGLAB-181): child hubs enrolled with this (parent) hub,
  -- and the federation keys they authenticate with. A federation key is a
  -- principal of its own — never an api_keys row — so the two credential
  -- kinds cannot reach each other's routes. detached_at is the parent-side
  -- "leave the group" marker: every federation route refuses a detached hub
  -- even if its key row was not revoked.
  CREATE TABLE IF NOT EXISTS child_hubs (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    hub_version TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    detached_at TEXT,
    detached_by_user_id TEXT,
    detached_by_email TEXT,
    release_requested_at TEXT,
    release_reason TEXT,
    identity_policy TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_child_hubs_org ON child_hubs(org_id);

  -- Flow dispatch (CGLAB-182): a parent hub sends one of its flows to its
  -- child hubs. The dispatch is the intent; the targets are what actually
  -- happened, one row per hub.
  --
  -- scope_type 'all' deliberately does NOT expand into target rows when the
  -- dispatch is created: 'all' means every current AND FUTURE child hub, so a
  -- hub enrolling next month has to receive it on its first poll. Targets for
  -- 'all' therefore appear lazily, the first time a hub is served.
  CREATE TABLE IF NOT EXISTS flow_dispatches (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    flow_id TEXT NOT NULL,
    flow_version INTEGER NOT NULL,
    -- The definition AS DISPATCHED. A dispatch is a decision about specific
    -- content, so it carries that content rather than a pointer: reading the
    -- flow live at poll time meant an edit made after the dispatch reached
    -- whichever children had not polled yet, stored under the OLD version
    -- number — two hubs running different flows that both report the same
    -- version, and a monotonic guard that can never converge them.
    definition_json TEXT,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('all','selected')),
    created_by_user_id TEXT,
    created_by_email TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    cancelled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_flow_dispatches_org_time ON flow_dispatches(org_id, created_at);

  -- state: pending | installed | failed | conflict. Only a report from the
  -- child moves it off pending — serving a directive is not the flow landing.
  CREATE TABLE IF NOT EXISTS flow_dispatch_targets (
    dispatch_id TEXT NOT NULL,
    child_hub_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    detail TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (dispatch_id, child_hub_id)
  );


  -- Group upgrades (CGLAB-183). The parent names a target version; each child
  -- fans it out over its OWN installations. Same shape as flow_dispatches, and
  -- for the same reasons: scope 'all' means every current AND FUTURE hub, so
  -- it is stored as intent and resolved per poll rather than expanded into
  -- target rows here.
  --
  -- confirm_downgrade travels with the dispatch: the parent admin confirms a
  -- backwards move once, in the blind, and the child carries the flag through
  -- its local fan-out instead of asking again.
  CREATE TABLE IF NOT EXISTS upgrade_dispatches (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    target_version TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('all','selected')),
    confirm_downgrade INTEGER NOT NULL DEFAULT 0,
    created_by_user_id TEXT,
    created_by_email TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    cancelled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_upgrade_dispatches_org_time ON upgrade_dispatches(org_id, created_at);

  -- state: pending | running | cancel-pending | completed | cancelled.
  --
  -- Only a report from the child moves it off pending — serving a directive is
  -- not the upgrade landing. 'cancel-pending' means the parent has ASKED this
  -- hub to stop and has not been told it did; it is deliberately distinct from
  -- 'cancelled', which the child confirmed. detail carries the child's
  -- aggregate counts and skip reasons.
  --
  -- cancel_attempts bounds how often a cancel is re-offered, so a hub that
  -- never answers one cannot starve every other directive behind it.
  CREATE TABLE IF NOT EXISTS upgrade_dispatch_targets (
    dispatch_id TEXT NOT NULL,
    child_hub_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    detail TEXT,
    -- The sequence of the last progress report accepted for this hub. Progress
    -- reports supersede one another and can arrive out of order, so the guard
    -- is monotonic in this rather than "latest write wins".
    seq INTEGER NOT NULL DEFAULT 0,
    cancel_attempts INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (dispatch_id, child_hub_id)
  );


  -- What a child hub's fan-out of a group upgrade actually did (CGLAB-183).
  --
  -- Recorded rather than recomputed, because the tick that REPORTS is almost
  -- never the tick that computed: the parent keeps re-serving a dispatch until
  -- the child reports, and by the next tick the machines this upgraded are in
  -- flight and would read as skipped. Re-deriving would hand the parent a
  -- fleet with no skips in it, which is the one thing the skip reasons exist
  -- to prevent.
  CREATE TABLE IF NOT EXISTS upgrade_dispatch_fanout (
    dispatch_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    upgraded INTEGER NOT NULL DEFAULT 0,
    skipped_json TEXT NOT NULL DEFAULT '[]',
    directive_id TEXT,
    -- Reporting bookkeeping (CGLAB-183 task 3). reported_seq is the sequence of
    -- the last report sent upstream and reported_json the snapshot it carried,
    -- so the next tick can tell whether anything actually MOVED — the cadence
    -- is on change plus a final completion, not one event per child per minute
    -- for the length of a rollout.
    reported_seq INTEGER NOT NULL DEFAULT 0,
    reported_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS federation_keys (
    token_hash TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    child_hub_id TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_federation_keys_child ON federation_keys(child_hub_id);

  -- Child-side federation outbox (CGLAB-181). Rows queued for the parent hub
  -- while this hub is a child. Durable on purpose: a parent outage must cost
  -- delivery latency, never data, and the child keeps serving throughout.
  CREATE TABLE IF NOT EXISTS federation_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    rejections INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_federation_outbox_due ON federation_outbox(next_attempt_at, seq);

  CREATE TABLE IF NOT EXISTS auth_config (
    org_id TEXT PRIMARY KEY,
    password_enabled INTEGER NOT NULL DEFAULT 1,
    google_enabled INTEGER NOT NULL DEFAULT 0,
    google_client_id TEXT,
    google_client_secret_enc TEXT,
    entra_enabled INTEGER NOT NULL DEFAULT 0,
    entra_tenant_id TEXT,
    entra_client_id TEXT,
    entra_client_secret_enc TEXT,
    email_allowlist TEXT
  );

  -- Per-org registry choice (CGLAB-138). An admin of a hub-connected company
  -- points the org's flow registry at an EXISTING repo of their own. The token
  -- is a fine-grained PAT (contents:write on that repo) held encrypted, the
  -- same way auth_config holds its OAuth secrets — it must never be read back
  -- out of the API, only used hub-side. Reads are authenticated with it too:
  -- the pre-existing registry read was an anonymous fetch, which 404s on a
  -- private repo, so a private target is only servable fleet-wide if the hub
  -- itself can authenticate. NULL repo = the public community registry.
  CREATE TABLE IF NOT EXISTS org_settings (
    org_id TEXT PRIMARY KEY,
    registry_repo TEXT,
    registry_branch TEXT NOT NULL DEFAULT 'main',
    registry_token_enc TEXT,
    registry_copied_at TEXT,
    identity_policy TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS flows (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    definition_json TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'hub' CHECK (source IN ('hub','community','parent')),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by_user_id TEXT,
    org_available INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_flows_org ON flows(org_id);

  CREATE TABLE IF NOT EXISTS flow_assignments (
    org_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'org',
    target_id TEXT NOT NULL DEFAULT '',
    flow_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by_user_id TEXT,
    PRIMARY KEY (org_id, scope, target_id)
  );

  -- Fleet upgrade directives. Story 2 of EPIC 541c12b3 (remote upgrade).
  -- Each directive records an admin's intent to push a specific agenfk
  -- version to a scoped subset of installations. Per-installation delivery
  -- state lives in upgrade_directive_targets.
  CREATE TABLE IF NOT EXISTS upgrade_directives (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    target_version TEXT NOT NULL,
    scope_type TEXT NOT NULL,    -- 'all' | 'installation'
    scope_id TEXT,               -- installation_id when scope_type='installation', else NULL
    created_by_user_id TEXT,
    created_by_email TEXT,       -- denormalised audit field (Story 5)
    request_ip TEXT,             -- audit (Story 5)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_upgrade_directives_org_time ON upgrade_directives(org_id, created_at);

  CREATE TABLE IF NOT EXISTS upgrade_directive_targets (
    directive_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',   -- pending | in_progress | succeeded | failed | cancelled
    attempted_at TEXT,
    finished_at TEXT,
    result_version TEXT,
    error_message TEXT,
    PRIMARY KEY (directive_id, installation_id)
  );
  CREATE INDEX IF NOT EXISTS idx_udt_install_state ON upgrade_directive_targets(installation_id, state);

  -- Hub-wide key/value scratch space. Used today by the org-rename flow to
  -- persist the "you still need to update AGENFK_HUB_ORG_ID" banner across
  -- page loads/sessions until an admin acks it. Intentionally generic so
  -- future operator-mode features (e.g. "pending DB migration", "cert
  -- rotation due") can reuse the same row store.
  CREATE TABLE IF NOT EXISTS system_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- First-run admin bootstrap. Single-use UUIDv4 generated on the first
  -- boot of an empty install, deleted in the same transaction that
  -- creates the initial admin (see /setup/initial-admin route).
  CREATE TABLE IF NOT EXISTS bootstrap_tokens (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Admin recovery (STORY a44f3697): the token a boot mints for the admin
  -- AGENFK_HUB_RESET_ADMIN_EMAIL names. Only its sha256 is kept; single-use,
  -- expires_at an ISO timestamp. See packages/hub/src/auth/adminRecovery.ts.
  CREATE TABLE IF NOT EXISTS admin_recovery_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  -- Config audit log (STORY a89af514): who changed which setting, when, from
  -- where, before -> after. Append-only, kept forever; secrets never stored.
  -- See packages/hub/src/services/configAudit.ts.
  CREATE TABLE IF NOT EXISTS config_audit (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    at TEXT NOT NULL,
    actor_user_id TEXT,
    actor_email TEXT,
    source TEXT NOT NULL,
    ip TEXT,
    area TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    before_json TEXT,
    after_json TEXT,
    link TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_config_audit_org_at ON config_audit(org_id, at, id);

  -- People hidden by an admin (CGLAB-31), keyed on events.user_key
  -- (lowercased git email). Membership removes the person from selection
  -- surfaces (installation lists, upgrade targeting, admin actions) and
  -- blocks their new events at ingest. Historical data (events,
  -- rollups_daily, dashboards) is deliberately untouched — the hide only
  -- affects go-forward behaviour and is fully reversible by deleting the
  -- row.
  -- Audit trail for identity merges (CGLAB-65). A merge rewrites history, so
  -- who did it, when, and how much moved must be recoverable afterwards.
  -- Repoint campaigns (CGLAB-66). A hub can change DNS name without anyone
  -- rejoining, because clients hold only {url, token, orgId} and keys are
  -- org-scoped. What was missing is push-down: a campaign tells connected
  -- installations to move, and the per-target rows are what make it safe to
  -- drop the old name once every one of them has confirmed ON the new name.
  CREATE TABLE IF NOT EXISTS repoint_campaigns (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    target_url TEXT NOT NULL,
    allowed_host TEXT NOT NULL,
    created_by_user_id TEXT,
    created_by_email TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_repoint_campaigns_org ON repoint_campaigns(org_id, created_at);

  CREATE TABLE IF NOT EXISTS repoint_campaign_targets (
    campaign_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    -- pending | succeeded | blocked_by_env | failed | cancelled
    state TEXT NOT NULL DEFAULT 'pending',
    attempted_at TEXT,
    finished_at TEXT,
    reported_url TEXT,
    error_message TEXT,
    PRIMARY KEY (campaign_id, installation_id)
  );
  CREATE INDEX IF NOT EXISTS idx_rct_install_state ON repoint_campaign_targets(installation_id, state);

  -- What each identity merge actually moved (BUG 098f8ba7). The audit row
  -- recorded only counts, so a mistaken merge — attributing one person's work to
  -- another — was permanent. A journal rather than a column on events, because a
  -- single slot is overwritten by the next merge and a chain could then never be
  -- unwound past one step.
  CREATE TABLE IF NOT EXISTS user_key_merge_events (
    merge_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    previous_user_key TEXT NOT NULL,
    PRIMARY KEY (merge_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ukme_merge ON user_key_merge_events(merge_id);

  CREATE TABLE IF NOT EXISTS user_key_merges (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    from_user_key TEXT NOT NULL,
    to_user_key TEXT NOT NULL,
    events_moved INTEGER NOT NULL DEFAULT 0,
    merged_by_user_id TEXT,
    merged_by_email TEXT,
    reverted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Where a merged-away identity went (CGLAB-72). The liveness guard only
  -- blocks a merge while a machine is still active, so an installation dormant
  -- past the window can wake later and re-derive a key that was merged away.
  -- Ingest resolves through this table, so it lands on the merged identity
  -- instead of starting a second one. Stamped with the merge that wrote it, so
  -- a revert removes exactly its own rows.
  CREATE TABLE IF NOT EXISTS user_key_aliases (
    org_id TEXT NOT NULL,
    alias_key TEXT NOT NULL,
    canonical_key TEXT NOT NULL,
    merge_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (org_id, alias_key)
  );
  CREATE INDEX IF NOT EXISTS idx_user_key_aliases_merge ON user_key_aliases(merge_id);

  -- A federation parent's record of child-hub developers' names (BUG 4159631f).
  -- They have no installation here; the name comes from the forwarded actor,
  -- recorded at /v1/federation/deliver and only for a keep-policy row.
  CREATE TABLE IF NOT EXISTS child_people (
    org_id TEXT NOT NULL,
    child_hub_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    git_name TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (org_id, child_hub_id, user_key)
  );

  CREATE TABLE IF NOT EXISTS hidden_users (
    org_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    hidden_by_user_id TEXT,
    hidden_by_email TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (org_id, user_key)
  );

  -- Admin-curated model identity, the "model" axis of user_key_aliases.
  -- A model id is free text the agent self-reports (--model <id>), so one
  -- model arrives as qwen3.8:27b, qwen38-27b, ... and the dashboards group
  -- by the raw string and show them as separate models.
  --
  -- The canonical name is the admin's literal string, deliberately NOT derived
  -- by a normalization rule: a rule that maps "-" to ":" and "38" to "3.8"
  -- eventually merges two genuinely different models, and the admin cannot see
  -- why it happened. Here the desired name is exactly what was typed, and only
  -- the listed aliases fold into it.
  --
  -- Applied at read time only. The events table keeps recording what was actually
  -- reported — this is append-only telemetry of what an agent claimed, and
  -- rewriting it would destroy that fact and be undone by the next event
  -- anyway. Deleting a row here reverts the dashboards, which is why no
  -- recompute job is needed.
  CREATE TABLE IF NOT EXISTS model_mappings (
    org_id TEXT NOT NULL,
    alias_model TEXT NOT NULL,
    canonical_model TEXT NOT NULL,
    created_by_user_id TEXT,
    created_by_email TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (org_id, alias_model)
  );
  CREATE INDEX IF NOT EXISTS idx_model_mappings_canonical
    ON model_mappings(org_id, canonical_model);

  -- Admin-curated provider + license class per model (CGLAB-133 follow-up).
  --
  -- The hub stores model as free text an agent self-reports, with no provider
  -- or license column, so the PR Overview's Provider / Open-weights /
  -- Commercial facets have to come from somewhere. They ship seeded from
  -- util/modelMetaSeed.ts and are inserted here on first read per org, then the
  -- admin edits the rows — the table is the source of truth once populated.
  --
  -- Keyed on the model id AS STORED (not the canonical name), and matched by
  -- prefix at read time, because one family spans both license classes:
  -- qwen3.8-27b is Apache-2.0 open weights while qwen3.8-max is API-only, so a
  -- family-level row would be wrong for one of them. Longest prefix wins.
  --
  -- source distinguishes a seeded row from an admin edit, so a future seed
  -- refresh can update untouched rows without clobbering a deliberate override.
  CREATE TABLE IF NOT EXISTS model_meta (
    org_id TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    license_class TEXT NOT NULL CHECK (license_class IN ('open_weights','commercial')),
    license TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'seed' CHECK (source IN ('seed','admin')),
    updated_by_user_id TEXT,
    updated_by_email TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (org_id, model)
  );


  -- Hub-centralized JIRA (CGLAB-412). org_jira is the org's Atlassian OAuth
  -- app, registered once by an admin; the secret is an AES-GCM blob
  -- (crypto.ts). Each installation connects its OWN JIRA identity:
  -- jira_connections is keyed by the installation's hub api key (its sha256),
  -- so a relay call uses the caller's token and JIRA's own permissions apply
  -- per person. token_enc holds {access_token, refresh_token}; NULL with a
  -- last_error once the grant died. jira_oauth_pending holds a flow between
  -- start and completion: the state, then the exchanged token awaiting the
  -- starting key's redemption of a one-time completion code. Timestamps are
  -- ISO TEXT written by the app, identical in both dialects.
  CREATE TABLE IF NOT EXISTS org_jira (
    org_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    client_secret_enc TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jira_connections (
    key_hash TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    token_enc TEXT,
    cloud_id TEXT,
    cloud_url TEXT,
    account_email TEXT,
    connected_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jira_connections_org ON jira_connections(org_id);

  CREATE TABLE IF NOT EXISTS jira_oauth_pending (
    state TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    return_to TEXT NOT NULL,
    completion_hash TEXT,
    token_enc TEXT,
    cloud_id TEXT,
    cloud_url TEXT,
    account_email TEXT,
    claimed_at TEXT,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jira_oauth_pending_completion ON jira_oauth_pending(completion_hash);

  -- Repository settings (RFC-002). repo_settings is the org's authoritative
  -- record for ONE canonical repository: the verify command every agent must
  -- run, the revision it is on, how CI receipts are treated, and the floor
  -- 'enforce' is measured against. The repository is identified by the same
  -- canonical URL sanitizeRemoteUrl() writes into events.remote_url, so ssh /
  -- https / with-or-without-.git are one record. shadow_threshold is NULL
  -- until an admin sets one — 'no floor yet', which is not the same as 0, and
  -- is why 'enforce' is refused while it is NULL. Timestamps are ISO TEXT
  -- written by the app, identical in both dialects.
  CREATE TABLE IF NOT EXISTS repo_settings (
    org_id TEXT NOT NULL,
    remote_url TEXT NOT NULL,
    verify_command TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    receipts_mode TEXT NOT NULL DEFAULT 'off' CHECK (receipts_mode IN ('off','shadow','enforce')),
    shadow_threshold INTEGER,
    producer_mode TEXT NOT NULL DEFAULT 'listed' CHECK (producer_mode IN ('listed','all')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (org_id, remote_url)
  );
  CREATE INDEX IF NOT EXISTS idx_repo_settings_org ON repo_settings(org_id);

  -- Airlock (GH-294). The org's Airlock policy: one row per org, which every
  -- joined installation adopts and no installation can overrule. revision
  -- moves on a policy save; ioc_revision moves when only the IOC host list
  -- changes, so an installation's cached ETag (both numbers) busts on either.
  -- policy_json holds the normalised policy WITHOUT its IOC list, which lives
  -- in ioc_hosts_json: a policy save and an IOC save each write only their own
  -- columns, each compare-and-swapped on its own revision, so neither can
  -- overwrite the other. Timestamps are ISO TEXT written by the app, identical
  -- in both dialects.
  CREATE TABLE IF NOT EXISTS airlock_policies (
    org_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    policy_json TEXT NOT NULL,
    ioc_revision INTEGER NOT NULL DEFAULT 0,
    ioc_hosts_json TEXT NOT NULL DEFAULT '[]',
    ioc_updated_at TEXT,
    updated_at TEXT NOT NULL,
    updated_by_email TEXT
  );

  -- Which Airlock policy each installation applies (GH-294, HUB-2), as it last
  -- reported through its event stream: the revision and IOC revision applied
  -- and when it first applied them (applied_at) and last said so
  -- (reported_at), and the last hub policy (revision and IOC revision) it
  -- refused as invalid. Keyed by org
  -- too, so a row is only ever read within its org. Timestamps are the
  -- reports' own ISO occurredAt, so an older report landing late is refused.
  CREATE TABLE IF NOT EXISTS airlock_installations (
    org_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    applied_revision INTEGER,
    applied_ioc_revision INTEGER,
    applied_at TEXT,
    reported_at TEXT,
    refused_revision INTEGER,
    refused_ioc_revision INTEGER,
    refused_error TEXT,
    refused_at TEXT,
    PRIMARY KEY (org_id, installation_id)
  );

  -- The org's recent Airlock denials and alerts (GH-294, HUB-1): the
  -- airlock.decision events that denied (or, in observe mode, would have) or
  -- that raised an alert, out of the events table, which keeps every decision
  -- including the far more numerous allows. Columns are the payload's fields,
  -- cut to size at ingest, so the admin's filters read columns rather than
  -- JSON. Kept as long as the events are (no hub event is purged); keyed by
  -- org, and ordered by (occurred_at, event_id) for the newest-first cursor.
  CREATE TABLE IF NOT EXISTS airlock_decisions (
    org_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    client TEXT,
    model TEXT,
    tool TEXT,
    capability_kind TEXT,
    target TEXT,
    decision TEXT NOT NULL,
    rule TEXT,
    mode TEXT,
    source TEXT NOT NULL,
    alert TEXT,
    item_id TEXT,
    revision INTEGER,
    policy_source TEXT,
    PRIMARY KEY (org_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_airlock_decisions_org_time ON airlock_decisions(org_id, occurred_at, event_id);

  -- Airlock learning proposals (GH-294, TEL-3): the latest report of each
  -- host each installation forwarded (airlock.learning-proposal), host names
  -- and counts only. The admin's list groups them by host, so the same host
  -- proposed by many installations is one row. reported_at is the event's
  -- own ISO occurredAt, so an older report landing late changes nothing.
  CREATE TABLE IF NOT EXISTS airlock_learning_reports (
    org_id TEXT NOT NULL,
    host TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    hits INTEGER NOT NULL,
    proxy_hits INTEGER NOT NULL DEFAULT 0,
    clients_json TEXT NOT NULL DEFAULT '[]',
    first_seen TEXT,
    last_seen TEXT,
    reported_at TEXT NOT NULL,
    PRIMARY KEY (org_id, host, installation_id)
  );

  -- The Airlock dataset (GH-294, DS-2): full tool-call rows and the labels joined to
  -- them, for training the semantic scorer. Kept only while the org's switch
  -- (airlock_dataset_settings, off by default) is on; never in the events table and
  -- never forwarded to a parent hub. Bounded per org by rows, age and row size
  -- (services/airlockDataset.ts), pruned at ingest. kind is 'row' or 'label';
  -- row_id joins a label to its row.
  CREATE TABLE IF NOT EXISTS airlock_dataset_settings (
    org_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    updated_by_email TEXT
  );

  CREATE TABLE IF NOT EXISTS airlock_dataset (
    org_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    row_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    imported INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (org_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_airlock_dataset_org_time ON airlock_dataset(org_id, occurred_at, event_id);
  CREATE INDEX IF NOT EXISTS idx_airlock_dataset_org_row ON airlock_dataset(org_id, row_id);

  -- The command's history. One row per revision, written by whoever moved it:
  -- the installation that claimed it first (source 'init', its installation id)
  -- or the admin who revised it (source 'admin', their user and email). A
  -- revision is never rewritten, so the trail says how the repo came to be
  -- verified, not just how it is verified now.
  CREATE TABLE IF NOT EXISTS repo_command_revisions (
    org_id TEXT NOT NULL,
    remote_url TEXT NOT NULL,
    revision INTEGER NOT NULL,
    verify_command TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('init','admin')),
    actor_user_id TEXT,
    actor_email TEXT,
    installation_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (org_id, remote_url, revision)
  );
  CREATE INDEX IF NOT EXISTS idx_repo_command_revisions_repo
    ON repo_command_revisions(org_id, remote_url);

  -- Which installations may produce receipts for this repo. Membership only:
  -- the row's presence is the allow, so adding and removing stay idempotent.
  CREATE TABLE IF NOT EXISTS repo_producers (
    org_id TEXT NOT NULL,
    remote_url TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    added_at TEXT NOT NULL,
    added_by_email TEXT,
    PRIMARY KEY (org_id, remote_url, installation_id)
  );
  CREATE INDEX IF NOT EXISTS idx_repo_producers_repo ON repo_producers(org_id, remote_url);

  -- Verification/review receipts (RFC-002). A receipt is a claim one machine
  -- makes for another to honour — "this command, run on this tree, passed on
  -- this card" — and the hub is where the claim becomes a record. It is
  -- WRITE-ONCE: the id is minted by the producing machine and is the primary
  -- key, so a retry cannot duplicate a row and a different body under a taken
  -- id is refused rather than merged. The row is keyed by the canonical remote
  -- URL like repo_settings, and its installation_id is the PUBLISHING key's
  -- installation, never anything the body claims - the credential is the
  -- producer. reusable is the hub's decision taken at write time (producer
  -- allowlist, report cap, the producer's own offer) and not_reusable_reason
  -- records which said no, so a reader never has to guess why a receipt cannot
  -- be trusted. body_json is the receipt exactly as received and body_hash the
  -- sha256 of exactly that string, which is what makes a retry recognisable as
  -- a retry. report_gz_b64 is the run log gzipped, and only while the log fits
  -- under the hub's cap (measured on the uncompressed bytes); report_bytes is
  -- the log's size either way, so "too big to keep" still says how big.
  -- received_at is ISO TEXT written by the app, as everywhere else here.
  CREATE TABLE IF NOT EXISTS receipts (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    remote_url TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('verification','review')),
    installation_id TEXT NOT NULL,
    card_id TEXT,
    content_tree TEXT,
    command_revision INTEGER,
    body_json TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    reusable INTEGER NOT NULL,
    not_reusable_reason TEXT,
    report_gz_b64 TEXT,
    report_bytes INTEGER,
    received_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_receipts_repo
    ON receipts(org_id, remote_url, kind, content_tree);

  CREATE INDEX IF NOT EXISTS idx_receipts_card
    ON receipts(org_id, remote_url, kind, card_id, received_at);
  CREATE INDEX IF NOT EXISTS idx_receipts_recent
    ON receipts(org_id, remote_url, received_at);

  -- CI read tokens (RFC-002). A ci_ token is what a CI job presents to read
  -- receipts, and nothing else: it lives in its own table so that no route
  -- taking an installation's api key can ever accept one (it cannot write
  -- events, publish receipts or claim a command), and an api key is never a CI
  -- token either. remote_url is the ONE repository the token may read, in the
  -- canonical spelling repo_settings uses; NULL is the whole organisation,
  -- which an admin has to ask for explicitly. Only the sha256 of the token is
  -- kept. Timestamps are ISO TEXT written by the app.
  CREATE TABLE IF NOT EXISTS ci_tokens (
    token_hash TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    remote_url TEXT,
    label TEXT,
    created_at TEXT NOT NULL,
    created_by_email TEXT,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ci_tokens_org ON ci_tokens(org_id);
`;

class SqliteAdapter implements HubDb {
  constructor(private raw: RawDb) {}

  async run(sql: string, params: Params = []): Promise<RunResult> {
    const stmt = this.raw.prepare(sql);
    const r = stmt.run(...(params as any[]));
    return {
      changes: Number(r.changes ?? 0),
      lastInsertRowid: r.lastInsertRowid as number | bigint | undefined,
    };
  }

  async get<T = unknown>(sql: string, params: Params = []): Promise<T | undefined> {
    const stmt = this.raw.prepare(sql);
    return stmt.get(...(params as any[])) as T | undefined;
  }

  async all<T = unknown>(sql: string, params: Params = []): Promise<T[]> {
    const stmt = this.raw.prepare(sql);
    return stmt.all(...(params as any[])) as T[];
  }

  async exec(sql: string): Promise<void> {
    this.raw.exec(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.raw.exec('BEGIN');
    try {
      const result = await fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  async close(): Promise<void> {
    this.raw.close();
  }

  /** Escape hatch for SQLite-specific tooling (PRAGMA inspections, etc). Avoid in route code. */
  __raw(): RawDb {
    return this.raw;
  }
}

export async function openSqliteDb(dbPath: string): Promise<HubDb> {
  // ':memory:' is a real SQLite filename, not a sentinel we intercept — but the
  // mkdir below would try to create a directory named '.' for it, and WAL is
  // unsupported on memory databases (the pragma silently no-ops, so it is
  // skipped for clarity). Tests use this to avoid the tmpdir entirely.
  const inMemory = dbPath === ':memory:';
  if (!inMemory) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const raw = new DatabaseSync(dbPath);
  if (!inMemory) raw.prepare('PRAGMA journal_mode = WAL').run();
  raw.prepare('PRAGMA foreign_keys = ON').run();
  raw.exec(SCHEMA_SQLITE);
  raw.exec("DELETE FROM events WHERE type = 'tokens.logged'");
  raw.exec("DELETE FROM rollups_daily");

  // Backfill columns on pre-existing event tables created before
  // item_type/remote_url/item_title/external_id existed.
  const cols = raw.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
  const have = new Set(cols.map(c => c.name));
  if (!have.has('item_type'))  raw.exec("ALTER TABLE events ADD COLUMN item_type TEXT");
  if (!have.has('remote_url')) raw.exec("ALTER TABLE events ADD COLUMN remote_url TEXT");
  if (!have.has('item_title')) raw.exec("ALTER TABLE events ADD COLUMN item_title TEXT");
  if (!have.has('external_id')) raw.exec("ALTER TABLE events ADD COLUMN external_id TEXT");
  // events.reporting_version — captures the X-Agenfk-Version header that
  // delivered each event, so the admin Recent Events view can show "this
  // event was emitted by version X" and surface stuck-process drift.
  if (!have.has('reporting_version')) raw.exec("ALTER TABLE events ADD COLUMN reporting_version TEXT");

  // users.name — every hub that predates the display-name fix has a users
  // table without it. Without this backfill the sidebar keeps showing the
  // raw UUID on exactly the deployments that already have users. (BUG
  // f44b1128 / CGLAB-354.)
  const userCols = raw.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (userCols.length > 0 && !new Set(userCols.map(c => c.name)).has('name')) {
    raw.exec("ALTER TABLE users ADD COLUMN name TEXT");
  }

  // Backfill: canonicalise remote_url forms (ssh / https / with-or-without-.git)
  // so /v1/projects shows one chip per repo. Idempotent — rows already at the
  // canonical value are skipped. SQLite has no regex, so we transform in JS.
  {
    const distinct = raw.prepare(
      "SELECT DISTINCT remote_url FROM events WHERE remote_url IS NOT NULL AND remote_url <> ''"
    ).all() as Array<{ remote_url: string }>;
    const update = raw.prepare("UPDATE events SET remote_url = ? WHERE remote_url = ?");
    for (const { remote_url } of distinct) {
      const canonical = sanitizeRemoteUrl(remote_url);
      if (canonical !== remote_url) update.run(canonical, remote_url);
    }
  }

  // Backfill: PR events ingested before the repo→remote_url fallback existed
  // have remote_url = NULL, stranding their repo inside the payload JSON and
  // hiding them from the projects filter. Derive remote_url from payload.repo
  // the same way the ingestion path now does. JS-side (SQLite has no regex).
  {
    const prRows = raw.prepare(
      "SELECT event_id, payload FROM events WHERE (remote_url IS NULL OR remote_url = '') AND type IN ('pr.opened', 'pr.updated')"
    ).all() as Array<{ event_id: string; payload: string }>;
    const update = raw.prepare("UPDATE events SET remote_url = ? WHERE event_id = ?");
    for (const { event_id, payload } of prRows) {
      let repo: unknown;
      try { repo = JSON.parse(payload)?.payload?.repo; } catch { continue; }
      if (typeof repo !== 'string') continue;
      const derived = remoteUrlFromRepo(repo);
      if (derived) update.run(sanitizeRemoteUrl(derived), event_id);
    }
  }

  // upgrade_directives audit columns — Story 5 of EPIC 541c12b3.
  const udCols = raw.prepare("PRAGMA table_info(upgrade_directives)").all() as Array<{ name: string }>;
  const udHave = new Set(udCols.map(c => c.name));
  if (udCols.length > 0) {
    if (!udHave.has('created_by_email')) raw.exec("ALTER TABLE upgrade_directives ADD COLUMN created_by_email TEXT");
    if (!udHave.has('request_ip'))      raw.exec("ALTER TABLE upgrade_directives ADD COLUMN request_ip TEXT");
  }

  // installations.agenfk_version + agenfk_version_updated_at — Story 7 of EPIC 541c12b3.
  const instCols = raw.prepare("PRAGMA table_info(installations)").all() as Array<{ name: string }>;
  const instHave = new Set(instCols.map(c => c.name));
  if (!instHave.has('agenfk_version')) raw.exec("ALTER TABLE installations ADD COLUMN agenfk_version TEXT");
  if (!instHave.has('agenfk_version_updated_at')) raw.exec("ALTER TABLE installations ADD COLUMN agenfk_version_updated_at TEXT");

  // installations retirement columns — CGLAB-64. A retired install is a dead
  // endpoint (wiped laptop, departed dev): it keeps its history but stops
  // counting as a live target, so upgrade/repoint campaign boards can drain.
  if (!instHave.has('retired_at')) raw.exec("ALTER TABLE installations ADD COLUMN retired_at TEXT");
  if (!instHave.has('retired_by_user_id')) raw.exec("ALTER TABLE installations ADD COLUMN retired_by_user_id TEXT");
  if (!instHave.has('retired_by_email')) raw.exec("ALTER TABLE installations ADD COLUMN retired_by_email TEXT");

  // user_key_merges.reverted_at — BUG 098f8ba7.
  // events.child_hub_id — CGLAB-184. Nullable, so existing rows keep meaning
  // "this hub's own data" without a backfill.
  const evCols2 = raw.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
  if (!new Set(evCols2.map(c => c.name)).has('child_hub_id')) {
    raw.exec("ALTER TABLE events ADD COLUMN child_hub_id TEXT");
  }

  // rollups_daily.child_hub_id joins the PRIMARY KEY, which SQLite cannot do
  // with ALTER. The table is rebuilt rather than migrated: every boot already
  // does DELETE FROM rollups_daily and recomputes from `events`, so there is
  // no data here worth copying — and copying is what would make this depend on
  // which other columns a given vintage of the table happens to have.
  const rdCols0 = raw.prepare("PRAGMA table_info(rollups_daily)").all() as Array<{ name: string }>;
  if (rdCols0.length > 0 && !new Set(rdCols0.map(c => c.name)).has('child_hub_id')) {
    raw.exec(`
      BEGIN;
      DROP TABLE rollups_daily;
      CREATE TABLE rollups_daily (
        org_id TEXT NOT NULL,
        user_key TEXT NOT NULL,
        day TEXT NOT NULL,
        events_count INTEGER NOT NULL DEFAULT 0,
        items_closed INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        validate_passes INTEGER NOT NULL DEFAULT 0,
        validate_fails INTEGER NOT NULL DEFAULT 0,
        prs_opened INTEGER NOT NULL DEFAULT 0,
        child_hub_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (org_id, child_hub_id, user_key, day)
      );
      COMMIT;
    `);
  }

  // child_hubs.identity_policy + org_settings.identity_policy — CGLAB-184.
  // Both tables already exist on deployed hubs, so CREATE TABLE IF NOT EXISTS
  // never adds them. Without these the ping route's SELECT throws and every
  // child in the group reads dead on the parent's roster.
  const chCols = raw.prepare("PRAGMA table_info(child_hubs)").all() as Array<{ name: string }>;
  if (chCols.length > 0 && !new Set(chCols.map(c => c.name)).has('identity_policy')) {
    raw.exec("ALTER TABLE child_hubs ADD COLUMN identity_policy TEXT");
  }
  const osCols = raw.prepare("PRAGMA table_info(org_settings)").all() as Array<{ name: string }>;
  if (osCols.length > 0 && !new Set(osCols.map(c => c.name)).has('identity_policy')) {
    raw.exec("ALTER TABLE org_settings ADD COLUMN identity_policy TEXT");
  }

  const ukmCols = raw.prepare("PRAGMA table_info(user_key_merges)").all() as Array<{ name: string }>;
  if (ukmCols.length > 0 && !new Set(ukmCols.map(c => c.name)).has('reverted_at')) {
    raw.exec("ALTER TABLE user_key_merges ADD COLUMN reverted_at TEXT");
  }

  // device_codes identity columns — BUG 159360db. Older hubs created this table
  // without them, and the device flow silently produced unbound keys.
  const dcCols = raw.prepare("PRAGMA table_info(device_codes)").all() as Array<{ name: string }>;
  const dcHave = new Set(dcCols.map(c => c.name));
  if (dcCols.length > 0) {
    if (!dcHave.has('installation_id')) raw.exec("ALTER TABLE device_codes ADD COLUMN installation_id TEXT");
    if (!dcHave.has('os_user'))         raw.exec("ALTER TABLE device_codes ADD COLUMN os_user TEXT");
    if (!dcHave.has('git_name'))        raw.exec("ALTER TABLE device_codes ADD COLUMN git_name TEXT");
    if (!dcHave.has('git_email'))       raw.exec("ALTER TABLE device_codes ADD COLUMN git_email TEXT");
  }

  // repo_settings.producer_mode — RFC-002 Amendment 1 (GH #289). Who may
  // produce a repository's receipts: 'listed' (the repo_producers allowlist,
  // which is what every repository meant before this column) or 'all' (any
  // live installation of the org). A hub that already has repo_settings keeps
  // its table through CREATE TABLE IF NOT EXISTS, so the column is added here;
  // the DEFAULT gives every existing repository today's behaviour.
  const rsCols = raw.prepare("PRAGMA table_info(repo_settings)").all() as Array<{ name: string }>;
  if (rsCols.length > 0 && !new Set(rsCols.map(c => c.name)).has('producer_mode')) {
    raw.exec("ALTER TABLE repo_settings ADD COLUMN producer_mode TEXT NOT NULL DEFAULT 'listed' CHECK (producer_mode IN ('listed','all'))");
  }

  // api_keys columns added when binding installation identity to magic-link tokens.
  const akCols = raw.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>;
  const akHave = new Set(akCols.map(c => c.name));
  if (!akHave.has('installation_id')) raw.exec("ALTER TABLE api_keys ADD COLUMN installation_id TEXT");
  if (!akHave.has('os_user'))         raw.exec("ALTER TABLE api_keys ADD COLUMN os_user TEXT");
  if (!akHave.has('git_name'))        raw.exec("ALTER TABLE api_keys ADD COLUMN git_name TEXT");
  if (!akHave.has('git_email'))       raw.exec("ALTER TABLE api_keys ADD COLUMN git_email TEXT");

  // flow_assignments multi-scope migration. Pre-existing tables had PK
  // (org_id, scope). New PK is (org_id, scope, target_id). SQLite can't
  // alter PK in place — recreate the table when needed.
  const faCols = raw.prepare("PRAGMA table_info(flow_assignments)").all() as Array<{ name: string }>;
  const faHave = new Set(faCols.map(c => c.name));
  if (faCols.length > 0 && !faHave.has('target_id')) {
    raw.exec(`
      BEGIN;
      CREATE TABLE flow_assignments_new (
        org_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'org',
        target_id TEXT NOT NULL DEFAULT '',
        flow_id TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_by_user_id TEXT,
        PRIMARY KEY (org_id, scope, target_id)
      );
      INSERT INTO flow_assignments_new (org_id, scope, target_id, flow_id, updated_at, updated_by_user_id)
        SELECT org_id, scope, '', flow_id, updated_at, updated_by_user_id FROM flow_assignments;
      DROP TABLE flow_assignments;
      ALTER TABLE flow_assignments_new RENAME TO flow_assignments;
      COMMIT;
    `);
  }

  // CGLAB-183 task 3 added reporting bookkeeping to tables task 1 and task 2
  // created. CREATE TABLE IF NOT EXISTS never adds a column to a table that
  // already exists, so a hub whose database was made by an earlier commit
  // would throw "no such column: seq" on every progress path — and on the
  // parent that happens inside the /deliver transaction, taking the child's
  // whole delivery batch down with it.
  for (const [table, column, ddl] of [
    ['flow_dispatches', 'definition_json', 'definition_json TEXT'],
    ['upgrade_dispatch_targets', 'seq', 'seq INTEGER NOT NULL DEFAULT 0'],
    ['upgrade_dispatch_targets', 'cancel_attempts', 'cancel_attempts INTEGER NOT NULL DEFAULT 0'],
    ['upgrade_dispatch_fanout', 'reported_seq', 'reported_seq INTEGER NOT NULL DEFAULT 0'],
    ['upgrade_dispatch_fanout', 'reported_json', 'reported_json TEXT'],
  ] as const) {
    const cols = raw.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some(c => c.name === column)) {
      raw.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }


  // flows.source gains 'parent' — a flow this hub received from its parent hub
  // (CGLAB-182). SQLite cannot ALTER a CHECK constraint, so an upgraded hub
  // needs the table rebuilt; without this every dispatched flow fails its
  // INSERT with a constraint error and the child silently installs nothing.
  //
  // Detected by reading the stored DDL rather than a column list: the column
  // has always existed, it is the CHECK that changed. Same reasoning as the
  // flow_assignments rebuild above — and like it, this runs in the migration
  // block, never in the schema block, because CREATE TABLE IF NOT EXISTS
  // leaves a deployed table alone.
  const flowsDdl = (raw.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='flows'",
  ).get() as { sql?: string } | undefined)?.sql ?? '';
  if (flowsDdl && !flowsDdl.includes("'parent'")) {
    raw.exec(`
      BEGIN;
      CREATE TABLE flows_new (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        definition_json TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'hub' CHECK (source IN ('hub','community','parent')),
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_by_user_id TEXT,
        org_available INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO flows_new (id, org_id, name, description, definition_json, source, version,
                             created_at, updated_at, created_by_user_id, org_available)
        SELECT id, org_id, name, description, definition_json, source, version,
               created_at, updated_at, created_by_user_id,
               COALESCE(org_available, 0)
          FROM flows;
      DROP TABLE flows;
      ALTER TABLE flows_new RENAME TO flows;
      COMMIT;
    `);
    raw.exec("CREATE INDEX IF NOT EXISTS idx_flows_org ON flows(org_id)");
  }

  // rollups_daily.prs_opened — added with the PR metrics initiative.
  const rdCols = raw.prepare("PRAGMA table_info(rollups_daily)").all() as Array<{ name: string }>;
  const rdHave = new Set(rdCols.map(c => c.name));
  if (!rdHave.has('prs_opened')) raw.exec("ALTER TABLE rollups_daily ADD COLUMN prs_opened INTEGER NOT NULL DEFAULT 0");
  // rollups_daily.transitions_judged / transitions_compliant — CGLAB-613 flow
  // adherence. NOT NULL DEFAULT 0 so existing rows stay out of both sides.
  if (!rdHave.has('transitions_judged')) raw.exec("ALTER TABLE rollups_daily ADD COLUMN transitions_judged INTEGER NOT NULL DEFAULT 0");
  if (!rdHave.has('transitions_compliant')) raw.exec("ALTER TABLE rollups_daily ADD COLUMN transitions_compliant INTEGER NOT NULL DEFAULT 0");

  // flows.org_available — org-available flag.
  const flowCols = raw.prepare("PRAGMA table_info(flows)").all() as Array<{ name: string }>;
  const flowHave = new Set(flowCols.map(c => c.name));
  if (!flowHave.has('org_available')) {
    raw.exec("ALTER TABLE flows ADD COLUMN org_available INTEGER NOT NULL DEFAULT 0");
    // One-time backfill: the flow currently set as org default is implicitly available.
    raw.exec("UPDATE flows SET org_available = 1 WHERE id IN (SELECT flow_id FROM flow_assignments WHERE scope = 'org')");
  }

  raw.exec("CREATE INDEX IF NOT EXISTS idx_events_remote_time ON events(org_id, remote_url, occurred_at)");
  raw.exec("CREATE INDEX IF NOT EXISTS idx_events_item_type_time ON events(org_id, item_type, occurred_at)");
  raw.exec("CREATE INDEX IF NOT EXISTS idx_events_external_id ON events(org_id, external_id)");
  raw.exec("CREATE INDEX IF NOT EXISTS idx_rollups_org_day_user ON rollups_daily(org_id, day, user_key)");
  // Here, not in SCHEMA_SQLITE: on an upgraded hub the column does not exist
  // until the migration above has run, and CREATE INDEX over a missing column
  // kills the boot before it gets there.
  raw.exec("CREATE INDEX IF NOT EXISTS idx_rollups_child ON rollups_daily(org_id, child_hub_id, day)");
  // Filtering the event stream by originating hub (CGLAB-184). Same placement
  // reasoning as the rollups index above: `events.child_hub_id` arrives through
  // an ALTER on an upgraded hub, so the index cannot live in SCHEMA_SQLITE.
  // A plain-column index from an earlier, unreleased commit on this branch.
  // Superseded by the expression index below; dropping it only tidies dev and
  // CI databases, since no released hub ever created it.
  raw.exec("DROP INDEX IF EXISTS idx_events_org_child_time");
  // Over COALESCE(child_hub_id, ''), matching the expression EVENTS reads use:
  // SQLite cannot use an index across `(col IS NULL OR col = '')`, so a plain
  // column index left the "this hub" selection walking the whole org.
  // rollups_daily is the other case — NOT NULL there, so it keeps the plain
  // column and its own idx_rollups_child.
  raw.exec("CREATE INDEX IF NOT EXISTS idx_events_org_childnorm_time ON events(org_id, COALESCE(child_hub_id, ''), occurred_at)");

  return new SqliteAdapter(raw);
}
