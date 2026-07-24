import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireApiKey } from '../auth/apiKey.js';
import { resolveEffectiveFlow } from '../services/flowResolution.js';
import { sanitizeRemoteUrl } from '../util/remoteUrl.js';

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
    const remoteUrl = typeof req.query.repo === 'string' ? req.query.repo : null;

    const resolved = await resolveEffectiveFlow({ db: ctx.db, orgId, projectId, remoteUrl, installationId });
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
      let parsed: Record<string, unknown> = {};
      try { parsed = (JSON.parse(r.definition_json) ?? {}) as Record<string, unknown>; } catch { parsed = {}; }
      return {
        name: r.name,
        description: r.description,
        ...parsed,
        id: r.id,
        version: r.version,
        isDefault: r.id === defaultFlowId,
      };
    });
    res.json({ flows, defaultFlowId });
  });

  router.put('/flows/selection', requireKey, async (req: Request, res: Response) => {
    const orgId = req.hubApiKey!.orgId;
    const installationId = req.hubApiKey!.installationId ?? null;
    // Selection is a per-installation action; a fleet api_key without an
    // installation binding may not write project selections.
    if (!installationId) {
      return res.status(403).json({ error: 'selection requires an installation-bound api key' });
    }
    const body = req.body ?? {};
    // Primary axis: repo (normalized remote URL). `projectId` is accepted only
    // for back-compat with un-upgraded clients and maps to the legacy 'project'
    // scope. The repo is the globally-shared identity; a local projectId is not.
    const repoRaw: string = typeof body.repo === 'string' ? body.repo : '';
    const projectId: string = typeof body.projectId === 'string' ? body.projectId : '';

    let scope: 'repo' | 'project';
    let targetId: string;
    if (repoRaw) {
      if (repoRaw.length > 1024) return res.status(400).json({ error: 'repo too long' });
      scope = 'repo';
      targetId = sanitizeRemoteUrl(repoRaw);
      // TRUST MODEL (intentional): repo flow selection is COLLABORATIVE and
      // org-scoped. A repo assignment fans out to every installation of that
      // repo, and the ownership gate below is based on self-reported event
      // remote_url — so any org member who works on a repo can set its flow for
      // the whole org. This is acceptable because: (a) flows are workflow
      // definitions, not code execution; (b) the blast radius is bounded to the
      // org (a valid installation-bound api key is required); and (c) a hub
      // admin can always override via an installation-scoped assignment (higher
      // precedence) or the org default. Admin-managed repo assignments go
      // through the admin-guarded PUT /v1/admin/flow-assignments instead.
      // Ownership: a repo is legitimately shared across installations, so allow
      // any installation that has itself touched the repo (has events for it),
      // or trust-on-first-use when the repo is entirely unknown to the org.
      // Refuse only when the repo is known to OTHER installations but not this one.
      const seen = await ctx.db.get<{ own: number; other: number }>(
        `SELECT
           SUM(CASE WHEN installation_id = ? THEN 1 ELSE 0 END) AS own,
           SUM(CASE WHEN installation_id IS NOT NULL AND installation_id <> ? THEN 1 ELSE 0 END) AS other
         FROM events WHERE org_id = ? AND remote_url = ?`,
        [installationId, installationId, orgId, targetId],
      );
      const own = Number(seen?.own ?? 0);
      const other = Number(seen?.other ?? 0);
      if (own === 0 && other > 0) {
        return res.status(403).json({ error: 'repo belongs to a different installation' });
      }
    } else if (projectId) {
      if (projectId.length > 256) return res.status(400).json({ error: 'projectId too long' });
      scope = 'project';
      targetId = projectId;
      // Legacy ownership check: refuse a projectId attributed to another install.
      const foreign = await ctx.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM events
         WHERE org_id = ? AND project_id = ? AND installation_id IS NOT NULL AND installation_id <> ?`,
        [orgId, projectId, installationId],
      );
      if (foreign && Number(foreign.n) > 0) {
        return res.status(403).json({ error: 'projectId belongs to a different installation' });
      }
    } else {
      return res.status(400).json({ error: 'repo is required' });
    }

    const respKey = scope === 'repo' ? { repo: targetId } : { projectId: targetId };
    const flowId = body.flowId;
    // Clear path.
    if (flowId === null) {
      await ctx.db.run(
        'DELETE FROM flow_assignments WHERE org_id = ? AND scope = ? AND target_id = ?',
        [orgId, scope, targetId],
      );
      return res.json({ ...respKey, flowId: null, scope });
    }
    if (typeof flowId !== 'string' || !flowId) {
      return res.status(400).json({ error: 'flowId must be a string or null' });
    }
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
        'DELETE FROM flow_assignments WHERE org_id = ? AND scope = ? AND target_id = ?',
        [orgId, scope, targetId],
      );
      await ctx.db.run(
        `INSERT INTO flow_assignments (org_id, scope, target_id, flow_id, updated_by_user_id)
         VALUES (?, ?, ?, ?, NULL)`,
        [orgId, scope, targetId, flowId],
      );
    });
    res.json({ ...respKey, flowId, scope });
  });

  return router;
}
