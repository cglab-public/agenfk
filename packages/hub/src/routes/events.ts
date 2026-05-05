import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireApiKey } from '../auth/apiKey.js';
import { HubEvent } from '@agenfk/core';

function userKeyFor(actor: HubEvent['actor']): string {
  return (actor.gitEmail?.toLowerCase() || actor.osUser || 'unknown').trim();
}

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
  (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, project_id, item_id, item_type, remote_url, item_title, external_id, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const UPSERT_INSTALLATION_SQL = `
  INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    last_seen = excluded.last_seen,
    os_user = COALESCE(excluded.os_user, installations.os_user),
    git_name = COALESCE(excluded.git_name, installations.git_name),
    git_email = COALESCE(excluded.git_email, installations.git_email)
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

  // Strict semver allowlist for the X-Agenfk-Version batch header. Same shape
  // as the CLI/admin-route allowlist — the value will eventually be displayed
  // in the admin UI and used to drive downgrade-detection logic, so we never
  // accept anything malformed.
  const SEMVER_TAG_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

  router.post('/events', requireKey, async (req: Request, res: Response) => {
    const orgId = req.hubApiKey!.orgId;
    const installationFromHeader = (req.headers['x-installation-id'] as string | undefined) ?? null;
    const headerVerRaw = (req.headers['x-agenfk-version'] as string | undefined) ?? null;
    const agenfkVersion = headerVerRaw && SEMVER_TAG_RE.test(headerVerRaw) ? headerVerRaw : null;
    const body = req.body;
    const events: any[] = Array.isArray(body?.events) ? body.events : [];
    if (events.length === 0) {
      return res.status(400).json({ error: 'Body must contain a non-empty events array' });
    }

    const now = new Date().toISOString();
    let ingested = 0;
    let skipped = 0;
    let rejected = 0;

    await ctx.db.transaction(async () => {
      for (const e of events) {
        if (!isValidEvent(e)) { rejected++; continue; }
        if (e.orgId !== orgId) { rejected++; continue; }
        const userKey = userKeyFor(e.actor);
        const itemType = (e as any).itemType
          ?? (e.payload && typeof (e.payload as any).itemType === 'string' ? (e.payload as any).itemType : null);
        const remoteUrl = (e as any).remoteUrl ?? null;
        const itemTitle = (e as any).itemTitle
          ?? (e.payload && typeof (e.payload as any).title === 'string' ? (e.payload as any).title : null);
        const externalId = (e as any).externalId
          ?? (e.payload && typeof (e.payload as any).externalId === 'string' ? (e.payload as any).externalId : null);
        const result = await ctx.db.run(INSERT_EVENT_SQL, [
          e.eventId, e.orgId, e.installationId, userKey, e.occurredAt, now,
          e.type, e.projectId ?? null, e.itemId ?? null, itemType, remoteUrl, itemTitle, externalId, JSON.stringify(e),
        ]);
        if (result.changes === 0) { skipped++; continue; }
        ingested++;
        await ctx.db.run(UPSERT_INSTALLATION_SQL, [
          e.installationId, e.orgId, now, now,
          e.actor.osUser ?? null, e.actor.gitName ?? null, e.actor.gitEmail ?? null,
        ]);

        // Story 7: persist the running agenfk version when the batch header
        // carried one. We only update when present so an absent header doesn't
        // clobber a previously-known version.
        if (agenfkVersion) {
          await ctx.db.run(
            `UPDATE installations SET agenfk_version = ?, agenfk_version_updated_at = ?
             WHERE id = ? AND org_id = ?`,
            [agenfkVersion, now, e.installationId, e.orgId],
          );
        }

        // Fleet upgrade events transition the matching directive_target.
        // Identified by directiveId in the payload + the event's installation_id.
        if (e.type === 'fleet:upgrade:started'
          || e.type === 'fleet:upgrade:succeeded'
          || e.type === 'fleet:upgrade:failed') {
          const directiveId = (e.payload as any)?.directiveId;
          if (typeof directiveId === 'string' && directiveId) {
            const nextState = e.type === 'fleet:upgrade:started' ? 'in_progress'
              : e.type === 'fleet:upgrade:succeeded' ? 'succeeded'
              : 'failed';
            const resultVersion = (e.payload as any)?.resultVersion ?? null;
            const errorMessage = (e.payload as any)?.error ?? null;
            await ctx.db.run(
              `UPDATE upgrade_directive_targets
                 SET state = ?,
                     attempted_at = COALESCE(attempted_at, ?),
                     finished_at = CASE WHEN ? IN ('succeeded', 'failed') THEN ? ELSE finished_at END,
                     result_version = COALESCE(?, result_version),
                     error_message = COALESCE(?, error_message)
               WHERE directive_id = ? AND installation_id = ?`,
              [nextState, now, nextState, now, resultVersion, errorMessage, directiveId, e.installationId],
            );
          }
        }
      }
    });

    res.json({ ingested, skipped, rejected, installationId: installationFromHeader });
  });

  return router;
}
