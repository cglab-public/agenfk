import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireApiKey } from '../auth/apiKey.js';
import { HubEvent } from '@agenfk/core';
import { userKeyFor } from '../util/userKey.js';
import { loadAliasMap, resolveAliasKey } from '../util/userKeyAlias.js';
import { isEmailShapedKey } from '../util/userKey.js';



/**
 * The hostname this request actually arrived on. Behind a proxy the real name
 * is in X-Forwarded-Host; req.headers.host is the internal one. Same precedence
 * as publicHubUrl in routes/connect.ts.
 */
function requestHost(req: Request): string | null {
  // X-Forwarded-Host is client-controlled unless a proxy overwrites it, and a
  // proxy APPENDS — so the leftmost element is whatever the caller supplied and
  // the rightmost is the last hop that actually handled the request. Taking [0]
  // would trust exactly the attacker-chosen value.
  const fwdRaw = req.headers['x-forwarded-host'] as string | undefined;
  const hops = fwdRaw ? fwdRaw.split(',').map(h => h.trim()).filter(Boolean) : [];
  const host = (hops.length ? hops[hops.length - 1] : undefined)
    || (req.headers.host as string | undefined)
    || null;
  return host ? host.split(':')[0].toLowerCase() : null;
}

export { sanitizeRemoteUrl } from '../util/remoteUrl.js';
import { sanitizeRemoteUrl, remoteUrlFromRepo } from '../util/remoteUrl.js';


function isValidEvent(e: any): e is HubEvent {
  return (
    e &&
    typeof e.eventId === 'string' && e.eventId.length > 0 &&
    typeof e.installationId === 'string' &&
    typeof e.orgId === 'string' &&
    typeof e.occurredAt === 'string' &&
    typeof e.type === 'string' &&
    e.actor && typeof e.actor.osUser === 'string' &&
    typeof e.payload === 'object'
  );
}

const INSERT_EVENT_SQL = `
  INSERT OR IGNORE INTO events
  (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, project_id, item_id, item_type, remote_url, item_title, external_id, reporting_version, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const UPSERT_INSTALLATION_SQL = `
  INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    last_seen = excluded.last_seen,
    os_user = COALESCE(excluded.os_user, installations.os_user),
    git_name = COALESCE(excluded.git_name, installations.git_name),
    git_email = COALESCE(excluded.git_email, installations.git_email)
  WHERE installations.org_id = excluded.org_id
`;

export function eventsRouter(ctx: HubServerContext): Router {
  const router = Router();
  const requireKey = requireApiKey(ctx.db);

  router.get('/ping', requireKey, (req: Request, res: Response) => {
    res.json({ ok: true, orgId: req.hubApiKey!.orgId });
  });

  // Fleet poll endpoint (Story 2 of EPIC 541c12b3 — remote upgrade).
  // Returns the oldest pending upgrade directive whose target row matches
  // the calling installation, or 204 if none. The caller (Story 3 client)
  // decides whether to act on it; the hub does NOT transition state here —
  // it waits for the corresponding `fleet:upgrade:*` event in /v1/events.
  router.get('/upgrade-directive', requireKey, async (req: Request, res: Response) => {
    const installationId = req.hubApiKey!.installationId;
    if (!installationId) {
      return res.status(204).end();
    }
    const row = await ctx.db.get<{
      directive_id: string; target_version: string; created_at: string;
    }>(
      `SELECT d.id AS directive_id, d.target_version, d.created_at
       FROM upgrade_directive_targets t
       JOIN upgrade_directives d ON d.id = t.directive_id
       WHERE t.installation_id = ? AND d.org_id = ?
         AND t.state = 'pending'
       ORDER BY d.created_at ASC
       LIMIT 1`,
      [installationId, req.hubApiKey!.orgId],
    );
    if (!row) return res.status(204).end();
    res.json({
      directiveId: row.directive_id,
      targetVersion: row.target_version,
      issuedAt: row.created_at,
    });
  });

  // Repoint directive (CGLAB-66). Same shape as /upgrade-directive: keyed off
  // the api_key's installation binding, so a legacy org-wide key gets nothing —
  // it cannot be attributed to a machine and therefore cannot be tracked to a
  // confirmed move.
  router.get('/repoint-directive', requireKey, async (req: Request, res: Response) => {
    const installationId = req.hubApiKey!.installationId;
    if (!installationId) return res.status(204).end();
    // A hidden person's events are dropped at ingest, so such an install would
    // rewrite hub.json and report forever without ever completing — excluded via
    // LEFT JOIN + IS NULL, the same idiom as the installations list (NOT EXISTS
    // with an outer alias is not portable to both backends).
    //
    // Newest campaign, matching what GET /v1/admin/repoint reports. Serving the
    // oldest would have clients confirming one campaign while the board watched
    // another, showing 100% pending with no explanation.
    const row = await ctx.db.get<{ id: string; target_url: string; allowed_host: string; created_at: string }>(
      `SELECT c.id, c.target_url, c.allowed_host, c.created_at
         FROM repoint_campaign_targets t
         JOIN repoint_campaigns c ON c.id = t.campaign_id
         JOIN installations i ON i.id = t.installation_id
         LEFT JOIN hidden_users h ON h.org_id = i.org_id AND h.user_key = lower(i.git_email)
        WHERE t.installation_id = ? AND c.org_id = ?
          AND c.closed_at IS NULL
          AND h.user_key IS NULL
          AND t.state IN ('pending', 'blocked_by_env', 'failed')
        ORDER BY c.created_at DESC
        LIMIT 1`,
      [installationId, req.hubApiKey!.orgId],
    );
    if (!row) return res.status(204).end();
    res.json({
      campaignId: row.id,
      targetUrl: row.target_url,
      allowedHost: row.allowed_host,
      issuedAt: row.created_at,
    });
  });

  // Strict semver allowlist for the X-Agenfk-Version batch header. Same shape
  // as the CLI/admin-route allowlist — the value will eventually be displayed
  // in the admin UI and used to drive downgrade-detection logic, so we never
  // accept anything malformed.
  const SEMVER_TAG_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

  // Hard ceiling on events processed in a single /v1/events transaction.
  const MAX_EVENTS_PER_BATCH = 500;

  router.post('/events', requireKey, async (req: Request, res: Response) => {
    const orgId = req.hubApiKey!.orgId;
    // An installation-bound key may only post events for its OWN installation.
    // Without this, any org key could stamp fleet:upgrade:* state or running
    // versions for another installation (BOLA). Legacy org-wide keys (null
    // installation_id) are exempt for backward compatibility. (Security: bug a7a448dc.)
    const keyInstallation = req.hubApiKey!.installationId ?? null;
    const installationFromHeader = (req.headers['x-installation-id'] as string | undefined) ?? null;
    const headerVerRaw = (req.headers['x-agenfk-version'] as string | undefined) ?? null;
    const agenfkVersion = headerVerRaw && SEMVER_TAG_RE.test(headerVerRaw) ? headerVerRaw : null;
    const body = req.body;
    const events: any[] = Array.isArray(body?.events) ? body.events : [];
    if (events.length === 0) {
      return res.status(400).json({ error: 'Body must contain a non-empty events array' });
    }
    // Bound the per-batch work: a single 10MB body could otherwise carry
    // thousands of events processed inside one SQLite transaction, blocking
    // every other writer (write-amplification DoS). (Security: bug 035a4736.)
    if (events.length > MAX_EVENTS_PER_BATCH) {
      return res.status(413).json({ error: `Too many events in one batch (max ${MAX_EVENTS_PER_BATCH})` });
    }

    const now = new Date().toISOString();
    let ingested = 0;
    let skipped = 0;
    let rejected = 0;
    let hiddenDropped = 0;
    const seenInstallations = new Set<string>();

    // CGLAB-31: people hidden by an admin stop emitting go-forward data.
    // Load the org's hidden user_keys once per batch; events whose user_key
    // is hidden are dropped BEFORE the event insert AND before the
    // installations upsert, so a hidden install cannot resurrect via the
    // events stream. Historical rows already in the DB are untouched.
    const hiddenRows = await ctx.db.all<{ user_key: string }>(
      'SELECT user_key FROM hidden_users WHERE org_id = ?',
      [orgId],
    );
    const hiddenUserKeys = new Set(hiddenRows.map(r => r.user_key));

    // CGLAB-72: an identity merged away must not come back. The liveness guard
    // only refuses a merge while the machine is active, so one dormant past the
    // window can wake and re-derive its old key; resolving through the alias map
    // lands it on the merged identity instead of starting a second one. Loaded
    // once per batch, like the hidden set above.
    const aliasMap = await loadAliasMap(ctx.db, orgId);

    // installations.id is a GLOBAL primary key and admin-issued keys are UNBOUND
    // by default, so the per-event binding check below does not fire for them.
    // Without this, an org-A key could name an org-B installation id: the event
    // would be stored against it and the upsert's ON CONFLICT(id) would overwrite
    // that tenant's identity fields — which feed their suggestions, merges,
    // retirement and upgrade targeting. Resolved once per batch. (CGLAB-75.)
    const claimedInstalls = [...new Set(
      events.filter(isValidEvent).map((e: HubEvent) => e.installationId).filter(Boolean),
    )];
    const foreignInstalls = new Set<string>();
    if (claimedInstalls.length > 0) {
      const placeholders = claimedInstalls.map(() => '?').join(',');
      const rows = await ctx.db.all<{ id: string }>(
        `SELECT id FROM installations WHERE org_id <> ? AND id IN (${placeholders})`,
        [orgId, ...claimedInstalls],
      );
      for (const r of rows) foreignInstalls.add(r.id);
    }

    // An installation id is machine-local and is NEVER regenerated, so a machine
    // re-onboarded into a different org keeps its id while the installations row
    // still names the old one. Rejecting those events would destroy them: the
    // flusher deletes a batch on any 200, so a legitimate tenant would lose data
    // silently and permanently.
    //
    // A BOUND key is the proof that separates a move from the attack. Binding
    // happens only when an ADMIN of this org approves this exact machine, and a
    // bound key can name no other installation (checked per event below). So the
    // machine comes with us, and its row is repointed once per batch. An unbound
    // org-wide key proves nothing about any particular machine and is still
    // refused. (CGLAB-75 / CGLAB-76 follow-up.)
    //
    // DELIBERATE TRADE-OFF, stated because it weakens tenant isolation: an admin
    // of org-B who approves a machine presenting org-A's installation id moves
    // that row OUT of org-A, which loses it from its fleet along with its
    // identity fields. Org-A keeps every event it already stored — those carry
    // their own org_id — but future ones follow the machine. We accept that
    // because the alternative is destroying a legitimately-moved machine's data,
    // and because claiming a foreign id still requires an admin of the receiving
    // org to approve an onboarding. The remaining gap is the unbound case above:
    // a genuinely-moved machine whose org issued only org-wide keys is still
    // refused, now loudly rather than silently.
    if (keyInstallation && foreignInstalls.has(keyInstallation)) {
      const moved = await ctx.db.run(
        'UPDATE installations SET org_id = ? WHERE id = ? AND org_id <> ?',
        [orgId, keyInstallation, orgId],
      );
      if (moved.changes > 0) {
        foreignInstalls.delete(keyInstallation);
        console.log(
          `[HUB] Installation ${keyInstallation} adopted into org ${orgId}: its key is bound to it, `
          + 'so an admin of that org onboarded this machine.',
        );
      } else {
        // Zero rows changed does NOT mean "still foreign". Two batches in
        // flight both snapshot the foreign set before either UPDATE commits;
        // the first adopts, and the second's UPDATE matches nothing because the
        // org already moved. Treating that as a refusal rejects the whole second
        // batch, which the client then deletes — the silent loss this path
        // exists to remove, inside the window it targets. Re-read instead.
        const current = await ctx.db.get<{ org_id: string }>(
          'SELECT org_id FROM installations WHERE id = ?', [keyInstallation],
        );
        if (current?.org_id === orgId) foreignInstalls.delete(keyInstallation);
      }
    }

    await ctx.db.transaction(async () => {
      for (const e of events) {
        if (!isValidEvent(e)) { rejected++; continue; }
        if (e.orgId !== orgId) { rejected++; continue; }
        if (keyInstallation && e.installationId !== keyInstallation) { rejected++; continue; }
        if (foreignInstalls.has(e.installationId)) { rejected++; continue; }
        if (e.type === 'tokens.logged') { skipped++; continue; }
        // Resolve BEFORE the hidden check: hiding applies to the person, so a
        // merged-away key must not be a hole in the rule.
        const userKey = resolveAliasKey(userKeyFor(e.actor, e.installationId), aliasMap);
        if (hiddenUserKeys.has(userKey)) { hiddenDropped++; continue; }
        // The installation row has to follow the identity too. The upsert below
        // COALESCEs the reported git_email over whatever is stored, so a machine
        // still configured with a merged-away address used to overwrite the
        // repoint the merge performed — leaving an inverted suggestion that
        // advised undoing the repair, and 400d when clicked. Only substitute an
        // email-shaped target: an osuser: canonical is not a git address.
        const reportedEmail = e.actor.gitEmail?.trim();
        if (reportedEmail) {
          const resolved = resolveAliasKey(reportedEmail.toLowerCase(), aliasMap);
          if (resolved !== reportedEmail.toLowerCase() && isEmailShapedKey(resolved)) {
            e.actor = { ...e.actor, gitEmail: resolved };
          }
        }
        seenInstallations.add(e.installationId);
        const itemType = (e as any).itemType
          ?? (e.payload && typeof (e.payload as any).itemType === 'string' ? (e.payload as any).itemType : null);
        // Sanitise the git remote URL for de-duplication in the projects filter.
        // - trim leading/trailing whitespace
        // - strip ALL whitespace + ASCII control characters (URLs never contain them)
        // - lowercase (GitHub paths are case-insensitive)
        // Without this, the hub UI shows the same repo as multiple chips when
        // different fleet machines store the URL with different casing or
        // accidental whitespace in their git config.
        const remoteUrlRaw = (e as any).remoteUrl ?? null;
        let remoteUrl = typeof remoteUrlRaw === 'string'
          ? sanitizeRemoteUrl(remoteUrlRaw)
          : remoteUrlRaw;
        // Prefer the emitter-resolved git remote; fall back to the repo the
        // agent declared in the payload (PR events) when it's absent. The
        // emitter resolves remoteUrl by shelling out `git remote get-url
        // origin`, which yields null when the project has no origin / projectRoot
        // — stranding the PR's repo inside the JSON blob and hiding it from the
        // remote_url project filter. Deriving from payload.repo lands the PR
        // event on the SAME chip as the repo's other events. (BUG 418ee7bd.)
        if (!remoteUrl) {
          const repo = e.payload && typeof (e.payload as any).repo === 'string'
            ? (e.payload as any).repo
            : null;
          const derived = repo ? remoteUrlFromRepo(repo) : null;
          if (derived) remoteUrl = sanitizeRemoteUrl(derived);
        }
        const itemTitle = (e as any).itemTitle
          ?? (e.payload && typeof (e.payload as any).title === 'string' ? (e.payload as any).title : null);
        const externalId = (e as any).externalId
          ?? (e.payload && typeof (e.payload as any).externalId === 'string' ? (e.payload as any).externalId : null);
        const result = await ctx.db.run(INSERT_EVENT_SQL, [
          e.eventId, e.orgId, e.installationId, userKey, e.occurredAt, now,
          e.type, e.projectId ?? null, e.itemId ?? null, itemType, remoteUrl, itemTitle, externalId,
          agenfkVersion, // validated X-Agenfk-Version header (or null)
          JSON.stringify(e),
        ]);
        if (result.changes === 0) { skipped++; continue; }
        ingested++;
        await ctx.db.run(UPSERT_INSTALLATION_SQL, [
          e.installationId, e.orgId, now, now,
          e.actor.osUser ?? null, e.actor.gitName ?? null, e.actor.gitEmail ?? null,
        ]);

        // Repoint campaign reports (CGLAB-66) transition the matching target.
        //
        // `succeeded` is only believed when the report arrives ON the campaign's
        // target hostname. A client that repointed itself is by definition
        // talking to the new name, so a success claim delivered to the old one
        // proves nothing — and trusting it would let an admin drop a DNS name
        // that installations are still using. `blocked`/`failed` are reports of
        // NOT having moved, so they are accepted from either name.
        if (e.type === 'hub:repoint:succeeded'
          || e.type === 'hub:repoint:blocked'
          || e.type === 'hub:repoint:failed') {
          const campaignId = (e.payload as any)?.campaignId;
          // A legacy org-wide key is bound to no installation, so one holder
          // could otherwise post 'succeeded' for every install in the org: the
          // board would read drained and an admin would drop a DNS record the
          // whole fleet still needs. Such keys get no repoint directive either.
          if (!keyInstallation) {
            // fall through without transitioning anything
          } else if (typeof campaignId === 'string' && campaignId) {
            const campaign = await ctx.db.get<{ allowed_host: string }>(
              'SELECT allowed_host FROM repoint_campaigns WHERE id = ? AND org_id = ?',
              [campaignId, orgId],
            );
            if (campaign) {
              const arrivedOn = requestHost(req);
              const onTargetHost = !!arrivedOn && arrivedOn === String(campaign.allowed_host).toLowerCase();
              let nextState: string;
              let errorMessage: string | null;
              if (e.type === 'hub:repoint:succeeded') {
                nextState = onTargetHost ? 'succeeded' : 'pending';
                errorMessage = onTargetHost
                  ? null
                  : `Reported success but the report arrived on host "${arrivedOn ?? 'unknown'}", not "${campaign.allowed_host}".`;
              } else if (e.type === 'hub:repoint:blocked') {
                nextState = 'blocked_by_env';
                errorMessage = (e.payload as any)?.reason ?? 'Blocked';
              } else {
                nextState = 'failed';
                errorMessage = (e.payload as any)?.error ?? 'Failed';
              }
              // A proved success is terminal: late noise from a retrying agent
              // must not un-prove a machine that demonstrably moved.
              await ctx.db.run(
                `UPDATE repoint_campaign_targets
                    SET state = ?,
                        attempted_at = COALESCE(attempted_at, ?),
                        finished_at = CASE WHEN ? = 'succeeded' THEN ? ELSE finished_at END,
                        reported_url = COALESCE(?, reported_url),
                        error_message = ?
                  WHERE campaign_id = ? AND installation_id = ?
                    AND state <> 'succeeded'`,
                [
                  nextState, now, nextState, now,
                  (e.payload as any)?.url ?? null, errorMessage,
                  campaignId, e.installationId,
                ],
              );
            }
          }
        }

        // Fleet upgrade events transition the matching directive_target.
        // Identified by directiveId in the payload + the event's installation_id.
        if (e.type === 'fleet:upgrade:started'
          || e.type === 'fleet:upgrade:succeeded'
          || e.type === 'fleet:upgrade:failed') {
          const directiveId = (e.payload as any)?.directiveId;
          // Mirror the repoint block above: a legacy org-wide key is bound to no
          // installation, so it cannot be attributed to the machine it claims to
          // speak for. One holder could otherwise post 'succeeded' for every
          // install in the org and an admin would read a broken rollout as
          // complete. (CGLAB-75.)
          if (!keyInstallation) {
            // fall through without transitioning anything
          } else if (typeof directiveId === 'string' && directiveId) {
            const nextState = e.type === 'fleet:upgrade:started' ? 'in_progress'
              : e.type === 'fleet:upgrade:succeeded' ? 'succeeded'
              : 'failed';
            const resultVersion = (e.payload as any)?.resultVersion ?? null;
            const errorMessage = (e.payload as any)?.error ?? null;
            // A late 'started' from a resurrected agent must not flip a
            // cancelled (or otherwise terminal) target back to in_progress —
            // that would re-wedge the installation the admin just force-
            // cancelled. Terminal succeeded/failed reports stay authoritative:
            // they are more truthful and cannot block future directives.
            // (Trade-off: an agent retrying after its own 'failed' report
            // won't show in_progress during the retry; its eventual terminal
            // report still lands.)
            const stateGuard = nextState === 'in_progress'
              ? `AND state IN ('pending', 'in_progress')`
              : '';
            // Terminal reports OVERWRITE error_message (null clears it):
            // otherwise a force-cancel's stamped message would survive a
            // genuine late failure reason, or linger on a succeeded row.
            const errorMessageSql = nextState === 'in_progress'
              ? 'COALESCE(?, error_message)'
              : '?';
            await ctx.db.run(
              `UPDATE upgrade_directive_targets
                 SET state = ?,
                     attempted_at = COALESCE(attempted_at, ?),
                     finished_at = CASE WHEN ? IN ('succeeded', 'failed') THEN ? ELSE finished_at END,
                     result_version = COALESCE(?, result_version),
                     error_message = ${errorMessageSql}
               WHERE directive_id = ? AND installation_id = ? ${stateGuard}
                 AND directive_id IN (SELECT id FROM upgrade_directives WHERE org_id = ?)`,
              [nextState, now, nextState, now, resultVersion, errorMessage, directiveId, e.installationId, orgId],
            );
            // Note: do NOT stamp installations.agenfk_version from
            // resultVersion here. resultVersion reflects on-disk after the
            // upgrade, but installations.agenfk_version is the actually-
            // running version (header from flusher's in-memory CURRENT_VERSION).
            // They diverge when the local process upgrades files but doesn't
            // restart — and that divergence is a signal worth surfacing in
            // the admin view, not papering over.
          }
        }
      }

      // Story 7: persist the running agenfk version once per batch when the
      // header carried one. Lifted out of the per-event loop because
      // INSERT OR IGNORE returns 0-changes for duplicates and the previous
      // per-iteration `continue` skipped this update — leaving
      // installations.agenfk_version stale across flusher restarts that
      // replay an already-ingested outbox. We only update when the header
      // is present so an absent header doesn't clobber a previously-known
      // version.
      if (agenfkVersion) {
        for (const installationId of seenInstallations) {
          await ctx.db.run(
            `UPDATE installations SET agenfk_version = ?, agenfk_version_updated_at = ?
             WHERE id = ? AND org_id = ?`,
            [agenfkVersion, now, installationId, orgId],
          );
        }
      }
    });

    if (rejected > 0) {
      // Rejections used to be invisible on both sides: the client treats any 200
      // as delivered and deletes the batch, so a systematic rejection destroys
      // events leaving no trace anywhere.
      console.warn(
        `[HUB] Rejected ${rejected} event(s) from org ${orgId}`
        + `${keyInstallation ? ` (installation ${keyInstallation})` : ' (org-wide key)'}.`,
      );
    }
    res.json({ ingested, skipped, rejected, hiddenDropped, installationId: installationFromHeader });
  });

  return router;
}
