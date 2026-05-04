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

export function eventsRouter(ctx: HubServerContext): Router {
  const router = Router();
  const requireKey = requireApiKey(ctx.db);

  router.get('/ping', requireKey, (req: Request, res: Response) => {
    res.json({ ok: true, orgId: req.hubApiKey!.orgId });
  });

  router.post('/events', requireKey, (req: Request, res: Response) => {
    const orgId = req.hubApiKey!.orgId;
    const installationFromHeader = (req.headers['x-installation-id'] as string | undefined) ?? null;
    const body = req.body;
    const events: any[] = Array.isArray(body?.events) ? body.events : [];
    if (events.length === 0) {
      return res.status(400).json({ error: 'Body must contain a non-empty events array' });
    }

    const insertEvent = ctx.db.prepare(`
      INSERT OR IGNORE INTO events
      (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, project_id, item_id, item_type, remote_url, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const upsertInstallation = ctx.db.prepare(`
      INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_seen = excluded.last_seen,
        os_user = COALESCE(excluded.os_user, installations.os_user),
        git_name = COALESCE(excluded.git_name, installations.git_name),
        git_email = COALESCE(excluded.git_email, installations.git_email)
    `);

    const now = new Date().toISOString();
    let ingested = 0;
    let skipped = 0;
    let rejected = 0;

    ctx.db.exec('BEGIN');
    try {
      for (const e of events) {
        if (!isValidEvent(e)) { rejected++; continue; }
        if (e.orgId !== orgId) { rejected++; continue; }
        const userKey = userKeyFor(e.actor);
        // Some events still carry itemType/remoteUrl only inside their payload —
        // fall back to those before persisting so we don't lose data on legacy
        // emitters mid-rollout.
        const itemType = (e as any).itemType
          ?? (e.payload && typeof (e.payload as any).itemType === 'string' ? (e.payload as any).itemType : null);
        const remoteUrl = (e as any).remoteUrl ?? null;
        const result = insertEvent.run(
          e.eventId, e.orgId, e.installationId, userKey, e.occurredAt, now,
          e.type, e.projectId ?? null, e.itemId ?? null, itemType, remoteUrl, JSON.stringify(e),
        );
        if (result.changes === 0) { skipped++; continue; }
        ingested++;
        upsertInstallation.run(e.installationId, e.orgId, now, now, e.actor.osUser, e.actor.gitName, e.actor.gitEmail);
      }
      ctx.db.exec('COMMIT');
    } catch (err) {
      ctx.db.exec('ROLLBACK');
      throw err;
    }

    res.json({ ingested, skipped, rejected, installationId: installationFromHeader });
  });

  return router;
}
