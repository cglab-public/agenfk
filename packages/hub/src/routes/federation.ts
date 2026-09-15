import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes, randomUUID } from 'crypto';
import { HubServerContext } from '../server.js';
import { requireAdmin } from '../auth/session.js';
import { signInviteToken, verifyInviteToken, burnInviteNonce, INVITE_TTL_MS } from '../auth/inviteToken.js';
import { semverOrNull } from '../util/semver.js';
import { effectiveIdentityPolicy } from '../services/federation/forwarding.js';
import { sanitizeRemoteUrl, remoteUrlFromRepo } from '../util/remoteUrl.js';
import { loadAliasMap, resolveAliasKey } from '../util/userKeyAlias.js';
import { recomputeRollups } from '../rollup.js';
import { issueFederationKey, requireFederationKey } from '../auth/federationKey.js';
import { publicHubUrl } from '../util/publicUrl.js';
import { rateLimit } from '../util/rateLimit.js';
import { MAX_CHILD_HUB_NAME_LEN, validChildHubName } from '../util/childHubRow.js';

// Hub federation, parent side (CGLAB-181). A child hub enrolls by redeeming an
// admin-issued invite of kind 'child-hub', then heartbeats and polls for
// directives with the federation key it received. Two routers are exported
// because the enrollment invite lives under the session-guarded /hub prefix
// (next to the installation invite) while the child-facing API lives under
// /v1 like every other machine-to-machine route.

// An invite is ~200 chars. Cap the input before it reaches createHmac so an
// unauthenticated caller cannot make the hub HMAC megabytes per request.
const MAX_INVITE_TOKEN_LEN = 4096;
/** Same ceiling as /v1/events: one delivery must not be able to monopolise a writer. */
const MAX_DELIVER_ROWS = 500;

/**
 * The id a forwarded event is stored under. Namespaced by child hub because
 * `events.event_id` is the primary key on its own and two children mint ids
 * independently — an unnamespaced collision would drop the second silently.
 */
/**
 * A created_at as milliseconds, whatever shape the backend handed back.
 *
 * An unusable value sorts LAST, not first. Oldest WINS here, so mapping a null
 * or malformed timestamp to 0 would promote that one broken row ahead of every
 * correct one, on every poll, for the rest of the hub's life.
 *
 * Postgres (and pg-mem) return a Date here; SQLite returns an ISO string.
 * Within ONE backend a bare `<` happens to be correct for both shapes — Dates
 * compare by valueOf, ISO strings compare lexicographically — so this is
 * defensive rather than load-bearing today. It earns its place by not caring:
 * the two dispatch tables are separate, and the day one of their columns
 * diverges in type from the other, a bare `<` between a Date and a string
 * silently yields false and serves the wrong directive forever.
 */
export function msOf(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(String(v ?? ''));
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

export function forwardedEventId(childHubId: string, eventId: string): string {
  return `ch:${childHubId}:${eventId}`;
}

/** Admin-facing: mint a child-hub invite. Mounted under /hub/federation. */
export function federationInviteRouter(ctx: HubServerContext): Router {
  const router = Router();
  const adminGuard = requireAdmin(ctx.config.sessionSecret);

  router.post('/invite/create', adminGuard, (req: Request, res: Response) => {
    res.json(mintChildHubInvite(req.session!.orgId, ctx.config.secretKey, publicHubUrl(req)));
  });

  return router;
}

/** Mint a child-hub invite. Shared by the /hub route and the admin tab's button. */
export function mintChildHubInvite(orgId: string, secretKey: string, parentUrl: string) {
  const nonce = randomBytes(18).toString('base64url');
  const exp = Date.now() + INVITE_TTL_MS;
  return {
    inviteToken: signInviteToken({ orgId, nonce, exp, kind: 'child-hub' }, secretKey),
    parentUrl,
    expiresAt: new Date(exp).toISOString(),
  };
}

/** Child-facing: enroll, heartbeat, poll directives. Mounted under /v1/federation. */
export function federationRouter(ctx: HubServerContext): Router {
  const router = Router();
  const requireKey = requireFederationKey(ctx.db);

  // /enroll is the one unauthenticated federation route, so it carries its own
  // limiter rather than relying on one an unrelated router happens to apply at
  // the shared /v1 mount. Same budget as /hub/device/start.
  const enrollRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, max: 60,
    message: 'Too many enrollment attempts, slow down.',
  });

  router.post('/enroll', enrollRateLimit, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inviteToken = String(req.body?.inviteToken ?? '');
      if (!inviteToken) { res.status(400).json({ error: 'inviteToken required' }); return; }
      if (inviteToken.length > MAX_INVITE_TOKEN_LEN) { res.status(400).json({ error: 'invalid invite token' }); return; }
      const parsed = verifyInviteToken(inviteToken, ctx.config.secretKey, 'child-hub');
      if (!parsed) { res.status(400).json({ error: 'invalid invite token' }); return; }
      if (parsed.exp < Date.now()) { res.status(400).json({ error: 'invite token expired' }); return; }

      const rawName = req.body?.childHub?.name;
      const name = validChildHubName(rawName);
      if (!name) {
        const tooLong = typeof rawName === 'string' && rawName.trim().length > MAX_CHILD_HUB_NAME_LEN;
        res.status(400).json({
          error: tooLong ? `childHub.name exceeds ${MAX_CHILD_HUB_NAME_LEN} characters` : 'childHub.name required',
        });
        return;
      }
      const hubVersion = semverOrNull(req.body?.childHub?.hubVersion);

      const childHubId = randomUUID();
      const now = new Date().toISOString();

      // One transaction for all three writes. Burning the nonce first makes the
      // PRIMARY KEY the concurrency control, and rolling back together means a
      // failure part-way leaves neither an orphan child_hubs row nor a spent
      // invite — the admin's invite stays usable.
      const outcome = await ctx.db.transaction(async () => {
        if (!await burnInviteNonce(ctx.db, parsed.nonce, parsed.orgId)) return null;
        await ctx.db.run(
          'INSERT INTO child_hubs (id, org_id, name, hub_version, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
          [childHubId, parsed.orgId, name, hubVersion, now, now],
        );
        return issueFederationKey(ctx.db, parsed.orgId, childHubId, `child-hub:${name}`);
      });
      if (!outcome) { res.status(400).json({ error: 'invite token already used' }); return; }

      // Hand the policy over at enrolment, not on the first heartbeat a minute
      // later: a hub joining a group that already opted out would otherwise
      // forward real identities for that first minute.
      const group = await ctx.db.get<{ identity_policy: string | null }>(
        'SELECT identity_policy FROM org_settings WHERE org_id = ?', [parsed.orgId],
      );
      res.json({
        token: outcome, childHubId, orgId: parsed.orgId, parentUrl: publicHubUrl(req),
        identityPolicy: effectiveIdentityPolicy(group?.identity_policy as any ?? null, null),
      });
    } catch (err) {
      // express 4 does not forward a rejected promise, so without this the
      // child would hang until timeout instead of seeing a 500.
      next(err);
    }
  });

  router.post('/ping', requireKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { childHubId, orgId } = req.hubFederation!;
      const hubVersion = semverOrNull(req.body?.hubVersion);
      await ctx.db.run(
        'UPDATE child_hubs SET last_seen = ?, hub_version = COALESCE(?, hub_version) WHERE id = ? AND org_id = ?',
        [new Date().toISOString(), hubVersion, childHubId, orgId],
      );
      // The effective identity policy rides back on the heartbeat, so the
      // child learns of a change within a tick without a new endpoint or a
      // directive kind. Group default, overridden per child in either
      // direction.
      const group = await ctx.db.get<{ identity_policy: string | null }>(
        'SELECT identity_policy FROM org_settings WHERE org_id = ?', [orgId],
      );
      const child = await ctx.db.get<{ identity_policy: string | null }>(
        'SELECT identity_policy FROM child_hubs WHERE id = ? AND org_id = ?', [childHubId, orgId],
      );
      res.json({
        ok: true, childHubId, orgId,
        identityPolicy: effectiveIdentityPolicy(
          group?.identity_policy as any ?? null,
          child?.identity_policy as any ?? null,
        ),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Ingest what a child hub forwarded (CGLAB-184).
   *
   * The child's outbox deletes a row only once this answers, and two replicas
   * of a child share no lease, so delivery is at-least-once BY DESIGN. That
   * makes idempotency the other half of the contract rather than a nicety:
   * INSERT OR IGNORE on (event_id, child_hub_id) is what stops a redelivered
   * batch counting twice.
   *
   * child_hub_id is taken from the CREDENTIAL, never from the payload — a
   * child that claimed another's id would otherwise write into its series.
   *
   * The stored event_id is namespaced by child hub. `events.event_id` is the
   * primary key on its own, and two children generate ids in their own
   * spaces, so without this the second child's event would silently collide
   * with the first's and vanish. Namespacing keeps the existing primary key —
   * and therefore the existing idempotency — rather than migrating it.
   */
  // Authenticated, but a child can still loop batches; give it the same kind
  // of ceiling the other machine-facing routes have.
  const deliverRateLimit = rateLimit({
    windowMs: 60 * 1000, max: 120,
    message: 'Too many deliveries, slow down.',
  });

  /**
   * A child answering for a flow we dispatched (CGLAB-182).
   *
   * This is the ONLY thing that moves a target off `pending`. The parent never
   * marks one installed because it SERVED the directive — serving is not
   * landing, and showing what actually happened per hub is the whole reason
   * the target table exists.
   *
   * The child hub comes from the CREDENTIAL, never from the payload. Otherwise
   * one key holder could report `installed` for every sibling and an admin
   * would read a broken rollout as complete — the same reason the
   * fleet:upgrade ingest refuses to attribute a report without a key-bound
   * installation.
   *
   * The state guard sits IN THE STATEMENT rather than in a preceding read: as
   * a read-then-write, two concurrent deliveries would both see `pending` and
   * both write.
   *
   * It is MONOTONIC (pending -> failed -> installed), not first-writer-wins,
   * and that is not a detail. `failed` is terminal for an ATTEMPT, not for the
   * dispatch: the child retries. A transient install error queues `failed`; if
   * the parent is unreachable that row waits while the next tick installs
   * cleanly and queues `installed`; both then drain together, oldest first, so
   * `failed` ARRIVES FIRST. Under first-writer-wins the target would pin at
   * failed with the flow actually installed — and unrecoverably, because
   * /directives deliberately never re-serves a failed target, so the child is
   * never asked again and can never correct the record. `installed` therefore
   * overrides `failed`, while a late `failed` can never override `installed`.
   *
   * A report naming a dispatch that is not this org's, or a target row that
   * does not exist because the hub was never served, matches nothing and is
   * silently a no-op. Both are the right outcome: it is still stored as an
   * event, it just moves no state.
   */
  /**
   * The oldest dispatch of one kind that this child still owes an answer for.
   *
   * Both kinds share one predicate, and it encodes two rules that are easy to
   * get subtly different if written twice:
   *  - a hub is targeted when the scope is 'all' OR an explicit target row
   *    names it. 'all' means every current AND FUTURE hub, so it is never
   *    expanded into rows at creation and the row appears lazily, here, the
   *    first time a hub is served;
   *  - only `pending` is outstanding. A terminal target is not re-served —
   *    re-sending something the child already rejected would loop forever —
   *    so correcting one needs an admin to dispatch again.
   *
   * The table names are compile-time literals from the two call sites, never
   * anything a request can reach.
   */
  const outstandingDispatch = (
    dispatchTable: 'flow_dispatches' | 'upgrade_dispatches',
    targetTable: 'flow_dispatch_targets' | 'upgrade_dispatch_targets',
    extraColumns: string,
    childHubId: string,
    orgId: string,
  ) => ctx.db.get<any>(
    `SELECT d.id, d.created_at, ${extraColumns}
       FROM ${dispatchTable} d
       LEFT JOIN ${targetTable} t
         ON t.dispatch_id = d.id AND t.child_hub_id = ?
      WHERE d.org_id = ?
        AND d.cancelled_at IS NULL
        AND (d.scope_type = 'all' OR t.child_hub_id IS NOT NULL)
        AND (t.state IS NULL OR t.state = 'pending')
      ORDER BY d.created_at ASC
      LIMIT 1`,
    [childHubId, orgId],
  );

  const isDispatchReport = (e: any) =>
    e?.type === 'fleet:flow-dispatch:installed' || e?.type === 'fleet:flow-dispatch:failed';

  const applyFlowDispatchReport = async (
    e: any,
    args: {
      orgId: string;
      childHubId: string;
      now: string;
      str: (v: unknown) => string | null;
    },
  ): Promise<void> => {
    if (!isDispatchReport(e)) return;
    const dispatchId = args.str(e.payload?.dispatchId);
    if (!dispatchId) return;
    const installed = e.type === 'fleet:flow-dispatch:installed';
    const state = installed ? 'installed' : 'failed';
    // Capped like every other free-form string a child supplies (the
    // release-request reason uses the same 500). messageOf(err) upstream can
    // be an arbitrarily long driver message.
    const detail = args.str(e.payload?.detail)?.slice(0, 500) ?? null;
    const fromStates = installed ? `('pending', 'failed')` : `('pending')`;
    await ctx.db.run(
      `UPDATE flow_dispatch_targets
          SET state = ?, detail = ?, updated_at = ?
        WHERE dispatch_id = ? AND child_hub_id = ? AND state IN ${fromStates}
          AND dispatch_id IN (SELECT id FROM flow_dispatches WHERE org_id = ?)`,
      [state, detail, args.now, dispatchId, args.childHubId, args.orgId],
    );
  };

  router.post('/deliver', requireKey, deliverRateLimit, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { childHubId, orgId } = req.hubFederation!;
      const rows: any[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
      if (rows.length > MAX_DELIVER_ROWS) {
        res.status(413).json({ error: `Too many rows in one delivery (max ${MAX_DELIVER_ROWS})` });
        return;
      }

      // The same two guards /v1/events applies. Without them a person an admin
      // hid, or an identity deliberately merged away, walks back in through
      // the federation door — both controls exist to stop go-forward data, and
      // forwarded events are go-forward data.
      const hiddenRows = await ctx.db.all<{ user_key: string }>(
        'SELECT user_key FROM hidden_users WHERE org_id = ?', [orgId],
      );
      const hidden = new Set(hiddenRows.map(r => r.user_key));
      const aliases = await loadAliasMap(ctx.db, orgId);

      let accepted = 0;
      let duplicates = 0;
      let rejected = 0;
      let ignored = 0;
      let hiddenDropped = 0;
      let earliestDay: string | null = null;
      const rejections: Array<{ id: string | null; reason: string }> = [];
      const now = new Date().toISOString();
      /** Only strings reach the driver: an object or a boolean throws on bind. */
      const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

      await ctx.db.transaction(async () => {
        for (const r of rows) {
          // Kinds this build does not implement are counted, not fatal: an
          // older parent must not choke on a newer child.
          if (r?.kind !== 'event') { ignored++; continue; }
          const e = r?.payload?.event;
          const reject = (reason: string) => {
            rejected++;
            rejections.push({ id: typeof r?.id === 'string' ? r.id : null, reason });
          };
          if (!e || typeof e !== 'object') { reject('invalid_event'); continue; }
          if (typeof e.eventId !== 'string' || !e.eventId) { reject('invalid_event'); continue; }
          if (typeof e.type !== 'string' || !e.type) { reject('invalid_event'); continue; }
          if (typeof e.occurredAt !== 'string' || !e.occurredAt) { reject('invalid_event'); continue; }

          const userKey = resolveAliasKey(str(e.userKey) ?? 'unknown', aliases);
          // The hidden-people control filters PEOPLE. A dispatch report is
          // control plane riding the same pipe under a non-person key, and an
          // admin who happened to hide that key would otherwise stall every
          // rollout silently: the target stays pending, /directives keeps
          // serving, and the child re-installs forever with nothing logged.
          if (hidden.has(userKey) && !isDispatchReport(e)) { hiddenDropped++; continue; }

          // Canonicalise like /v1/events, or the same repo shows up as two
          // chips in the projects filter depending on which hub reported it.
          let remoteUrl = str(e.remoteUrl) ? sanitizeRemoteUrl(str(e.remoteUrl)!) : null;
          if (!remoteUrl) {
            const repo = str(e.payload?.repo);
            const derived = repo ? remoteUrlFromRepo(repo) : null;
            if (derived) remoteUrl = sanitizeRemoteUrl(derived);
          }

          const result = await ctx.db.run(
            `INSERT OR IGNORE INTO events
             (event_id, org_id, installation_id, user_key, occurred_at, received_at, type,
              project_id, item_id, item_type, remote_url, item_title, external_id,
              reporting_version, payload, child_hub_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              forwardedEventId(childHubId, e.eventId), orgId, str(e.installationId) ?? 'unknown',
              userKey, e.occurredAt, now, e.type,
              str(e.projectId), str(e.itemId), str(e.itemType),
              remoteUrl, str(e.itemTitle), str(e.externalId),
              null, JSON.stringify(e), childHubId,
            ],
          );
          if (result.changes === 0) { duplicates++; continue; }
          accepted++;

          await applyFlowDispatchReport(e, { orgId, childHubId, now, str });
          const day = e.occurredAt.slice(0, 10);
          if (!earliestDay || day < earliestDay) earliestDay = day;
        }
      });

      // Roll up the days this delivery actually landed on. recomputeRollups is
      // forward-only by default — it anchors on MAX(day) already rolled up —
      // which is fine for live telemetry but wrong for a retrying outbox: a
      // child offline for a week delivers events dated days ago, and without
      // this they would never appear in /v1/metrics at all.
      if (earliestDay) {
        try {
          await recomputeRollups(ctx.db, { since: earliestDay, orgId });
        } catch (err) {
          // The rows are stored; a rollup failure must not make the child
          // redeliver them.
          console.warn('[FEDERATION] delivered events but could not recompute rollups:', (err as Error).message);
        }
      }

      res.json({ accepted, duplicates, rejected, ignored, hiddenDropped, rejections });
    } catch (err) { next(err); }
  });

  /**
   * A child asking to be let go. Recording it is all this does: the parent's
   * existing detach is the approval, so there is no approve verb and no second
   * state machine to drift out of step with detached_at.
   */
  router.post('/release-request', requireKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { childHubId, orgId } = req.hubFederation!;
      const raw = req.body?.reason;
      const reason = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 500) : null;
      // COALESCE keeps the ORIGINAL timestamp: an impatient child re-asking
      // must not jump the queue an admin is working through. The reason is
      // COALESCEd the other way round — a NEW reason replaces, but re-asking
      // with none must not erase the sentence the admin was reading.
      await ctx.db.run(
        `UPDATE child_hubs
            SET release_requested_at = COALESCE(release_requested_at, ?),
                release_reason = COALESCE(?, release_reason)
          WHERE id = ? AND org_id = ?`,
        [new Date().toISOString(), reason, childHubId, orgId],
      );
      res.json({ ok: true, childHubId });
    } catch (err) { next(err); }
  });

  /**
   * What this child should do next, or 204 for nothing.
   *
   * Flow dispatch (CGLAB-182) is the first kind. Upgrade dispatch (CGLAB-183)
   * will add another; a child that does not recognise a kind records it and
   * carries on, which is what lets an older child sit under a newer parent.
   *
   * The org and the child hub come from the CREDENTIAL, never from the request,
   * and a detached hub never gets this far — requireKey refuses it.
   *
   * A dispatch is served while its target row says `pending`, or while no target
   * row exists at all. That second case is scope 'all': it means every current
   * AND FUTURE child hub, so it cannot be expanded into target rows when the
   * dispatch is created — the row appears here, the first time a hub is served.
   * A `failed` target is deliberately NOT re-served: retrying a definition the
   * child has already rejected would loop forever, so it needs an admin to
   * dispatch again once they have seen why.
   */
  router.get('/directives', requireKey, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { childHubId, orgId } = req.hubFederation!;
      const row = await outstandingDispatch(
        'flow_dispatches', 'flow_dispatch_targets', 'd.flow_id, d.flow_version', childHubId, orgId,
      );

      // Group upgrades share this feed (CGLAB-183). A child takes ONE directive
      // per poll, so the two kinds are picked separately and the older wins:
      // that keeps them in the order the admin actually issued them instead of
      // letting one kind starve the other. Two small indexed lookups rather
      // than a UNION, which the pg-mem parity backend does not handle.
      const upgradeRow = await outstandingDispatch(
        'upgrade_dispatches', 'upgrade_dispatch_targets', 'd.target_version, d.confirm_downgrade', childHubId, orgId,
      );

      // Resolve the flow candidate FIRST. A dispatch whose flow has since been
      // deleted can never be served and can never leave `pending` — no target
      // row is ever created for it — so if it were merely allowed to win the
      // pick and then 204, it would starve every upgrade behind it on every
      // child, permanently and invisibly. Dropping it from the running instead
      // means the feed keeps moving.
      const flow = row
        ? await ctx.db.get<any>(
            'SELECT id, name, description, definition_json, version FROM flows WHERE id = ? AND org_id = ?',
            [row.flow_id, orgId],
          )
        : null;
      const flowCandidate = flow ? row : null;

      if (upgradeRow && (!flowCandidate || msOf(upgradeRow.created_at) < msOf(flowCandidate.created_at))) {
        // Serving is not the upgrade landing: the row stays pending until the
        // child reports what its own installations actually did.
        await ctx.db.run(
          `INSERT OR IGNORE INTO upgrade_dispatch_targets (dispatch_id, child_hub_id, state, updated_at)
           VALUES (?, ?, 'pending', ?)`,
          [upgradeRow.id, childHubId, new Date().toISOString()],
        );
        res.json({
          kind: 'upgrade.dispatch',
          dispatchId: upgradeRow.id,
          targetVersion: upgradeRow.target_version,
          confirmDowngrade: !!upgradeRow.confirm_downgrade,
        });
        return;
      }

      // Nothing outstanding, or the only thing outstanding was a flow dispatch
      // whose flow is gone — serving a half-directive would just fail on the
      // child.
      if (!flowCandidate || !flow) { res.status(204).end(); return; }

      // Record that this hub has now SEEN it. Still pending: serving is not
      // landing, and only a report from the child moves this off pending.
      await ctx.db.run(
        `INSERT OR IGNORE INTO flow_dispatch_targets (dispatch_id, child_hub_id, state, updated_at)
         VALUES (?, ?, 'pending', ?)`,
        [row.id, childHubId, new Date().toISOString()],
      );

      res.json({
        kind: 'flow.dispatch',
        dispatchId: row.id,
        flowVersion: Number(row.flow_version),
        flow: {
          id: flow.id,
          name: flow.name,
          description: flow.description ?? null,
          version: Number(flow.version),
          definition: JSON.parse(flow.definition_json),
        },
      });
    } catch (err) { next(err); }
  });

  return router;
}
