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

  router.get('/flows/available', requireKey, async (req: Request, res: Response) => {
    const orgId = req.hubApiKey!.orgId;
    const rows = await ctx.db.all<{
      id: string; name: string; description: string | null; definition_json: string; version: number;
    }>(
      'SELECT id, name, description, definition_json, version FROM flows WHERE org_id = ? AND org_available = 1 ORDER BY updated_at DESC',
      [orgId],
    );
    const def = await ctx.db.get<{ flow_id: string }>(
      "SELECT flow_id FROM flow_assignments WHERE org_id = ? AND scope = 'org' AND target_id = ''",
      [orgId],
    );
    const defaultFlowId = def?.flow_id ?? null;
    const flows = rows.map((r) => {
      const parsed = (JSON.parse(r.definition_json) ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        ...parsed,
        version: r.version,
        isDefault: r.id === defaultFlowId,
      };
    });
    res.json({ flows, defaultFlowId });
  });

  router.put('/flows/selection', requireKey, async (req: Request, res: Response) => {
    const orgId = req.hubApiKey!.orgId;
    const body = req.body ?? {};
    const projectId: string = typeof body.projectId === 'string' ? body.projectId : '';
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    const flowId = body.flowId;

    // Clear path.
    if (flowId === null) {
      await ctx.db.run(
        "DELETE FROM flow_assignments WHERE org_id = ? AND scope = 'project' AND target_id = ?",
        [orgId, projectId],
      );
      return res.json({ projectId, flowId: null, scope: 'project' });
    }
    if (typeof flowId !== 'string' || !flowId) {
      return res.status(400).json({ error: 'flowId must be a string or null' });
    }

    // The flow must belong to this org AND be org-available (clients may only
    // pick from the org-available set).
    const flow = await ctx.db.get<{ id: string; org_available: number | boolean }>(
      'SELECT id, org_available FROM flows WHERE id = ? AND org_id = ?',
      [flowId, orgId],
    );
    if (!flow) return res.status(404).json({ error: 'Flow not found in this org' });
    if (!flow.org_available) {
      return res.status(400).json({ error: 'Flow is not org-available; cannot be selected' });
    }

    await ctx.db.transaction(async () => {
      await ctx.db.run(
        "DELETE FROM flow_assignments WHERE org_id = ? AND scope = 'project' AND target_id = ?",
        [orgId, projectId],
      );
      await ctx.db.run(
        `INSERT INTO flow_assignments (org_id, scope, target_id, flow_id, updated_by_user_id)
         VALUES (?, 'project', ?, ?, NULL)`,
        [orgId, projectId, flowId],
      );
    });
    res.json({ projectId, flowId, scope: 'project' });
  });

  return router;
}
