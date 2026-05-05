import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireApiKey } from '../auth/apiKey.js';
import { resolveEffectiveFlow } from '../services/flowResolution.js';

/**
 * Client-facing flow distribution: a connected agenfk installation calls
 * `GET /v1/flows/active` (auth'd by api_key → org) to fetch the flow assigned
 * to it. Resolution honours installation > project > org precedence.
 *
 * - `?projectId=<id>` (optional) — provides project scope for precedence.
 * - Installation scope is derived from the api_key's bound installation_id.
 *
 * ETag is keyed on `(version, scope, targetId)` so a scope change (e.g. an
 * installation override added or cleared) busts the client's cache even when
 * the underlying flow's version didn't change.
 */
export function flowsRouter(ctx: HubServerContext): Router {
  const router = Router();
  const requireKey = requireApiKey(ctx.db);

  router.get('/flows/active', requireKey, async (req: Request, res: Response) => {
    const orgId = req.hubApiKey!.orgId;
    const installationId = req.hubApiKey!.installationId ?? null;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : null;

    const resolved = await resolveEffectiveFlow({ db: ctx.db, orgId, projectId, installationId });
    if (!resolved) {
      return res.json({ flow: null });
    }

    const etag = `W/"${resolved.flow.version}:${resolved.scope}:${resolved.targetId}"`;
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    const def = (resolved.flow.definition ?? {}) as Record<string, unknown>;
    res.json({
      flow: {
        id: resolved.flow.id,
        name: resolved.flow.name,
        description: resolved.flow.description,
        ...def,
      },
      hubVersion: resolved.flow.version,
      scope: resolved.scope,
      targetId: resolved.targetId,
    });
  });

  return router;
}
