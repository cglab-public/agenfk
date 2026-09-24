import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { registryInstallSteps } from '@agenfk/core';
import { HubServerContext } from '../server.js';
import { requireApiKey } from '../auth/apiKey.js';
import { resolveEffectiveFlow } from '../services/flowResolution.js';
import { sanitizeRemoteUrl } from '../util/remoteUrl.js';
import { resolveRegistryRead, ghHeaders, listRegistryFiles, getRegistryConfig, registryToken, publishFlowPullRequest, slugify } from '../services/flowRegistry.js';
import { rateLimit, clientIp } from '../util/rateLimit.js';
import { asyncRoute } from '../util/asyncRoute.js';

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

  router.get('/flows/active', requireKey, asyncRoute(async (req: Request, res: Response) => {
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
  }));

  router.get('/flows/available', requireKey, asyncRoute(async (req: Request, res: Response) => {
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
  }));

  // ── Registry proxy for connected installations (CGLAB-138) ──────────
  //
  // A client's FlowEditorModal browses through the LOCAL server's
  // /registry/flows. When the installation belongs to an org that moved to a
  // private registry, the local server cannot do that read itself: the org's
  // GitHub token lives on the hub and must not be copied onto every laptop. So
  // the client asks the hub, which answers with the catalogue of ITS chosen
  // repo — the same repo the hub admin sees. One source of truth.
  //
  // The response carries `repo` so the client can show which registry the
  // entries came from; a list of flows with no label is how a private repo
  // gets mistaken for the public one.
  router.get('/registry/flows', requireKey, asyncRoute(async (req: Request, res: Response) => {
    const orgId = req.hubApiKey!.orgId;
    try {
      const { repo, branch, token } = await resolveRegistryRead(ctx.db, orgId, ctx.config.secretKey);
      const files = await listRegistryFiles(fetch, repo, branch, token);
      const flows = await Promise.all(files.map(async (file) => {
        try {
          const r = await fetch(file.download_url, { headers: ghHeaders(token) });
          if (!r.ok) throw new Error(`download ${r.status}`);
          const content: any = await r.json();
          return {
            filename: file.name,
            name: content.name ?? file.name.replace('.json', ''),
            author: content.author,
            version: content.version,
            stepCount: Array.isArray(content.steps) ? content.steps.length : 0,
            description: content.description,
            steps: Array.isArray(content.steps)
              ? content.steps.map((s: any) => ({ name: s.name ?? '', label: s.label ?? s.name ?? '' }))
              : undefined,
          };
        } catch {
          return { filename: file.name, name: file.name.replace('.json', ''), stepCount: 0 };
        }
      }));
      res.json({ repo, branch, flows });
    } catch (e: any) {
      // Never answer 200-with-empty here. An installation that cannot learn its
      // org registry must see a failure, not an empty catalogue it may then
      // assume is authoritative.
      res.status(502).json({ error: 'Failed to fetch registry', detail: e?.message });
    }
  }));

  // Install one registry flow on behalf of a connected installation. The
  // installation cannot fetch this itself — a private org repo is readable
  // only with the hub-held token — so the hub fetches and hands back the
  // definition, and the client creates it locally.
  router.post('/registry/flows/install', requireKey, asyncRoute(async (req: Request, res: Response) => {
    const orgId = req.hubApiKey!.orgId;
    const filename = typeof req.body?.filename === 'string' ? req.body.filename : null;
    if (!filename) return res.status(400).json({ error: 'filename is required' });
    try {
      const { repo, branch, token } = await resolveRegistryRead(ctx.db, orgId, ctx.config.secretKey);
      const url = `https://api.github.com/repos/${repo}/contents/flows/${encodeURIComponent(filename)}?ref=${encodeURIComponent(branch)}`;
      const r = await fetch(url, { headers: ghHeaders(token) });
      if (!r.ok) return res.status(r.status).json({ error: 'Failed to fetch registry file' });
      const fileInfo: any = await r.json();
      const raw = Buffer.from(fileInfo.content, 'base64').toString('utf8');
      const flowData = JSON.parse(raw);
      // Normalise exactly as the hub admin install and the local server do, so
      // a flow behaves the same however it arrived, contract included.
      const steps = registryInstallSteps(flowData.steps, randomUUID);
      res.json({ repo, flow: { name: flowData.name ?? filename.replace('.json', ''), description: flowData.description ?? '', steps } });
    } catch (e: any) {
      res.status(502).json({ error: 'Failed to install flow', detail: e?.message });
    }
  }));

  // Publish a flow from an installation to the ORG's registry, as a pull
  // request the admin reviews on GitHub (CGLAB-367). The local server used to
  // push to the public community repo with the laptop's own gh login; an org
  // on a private registry now publishes the same way it browses - through the
  // hub, which holds the token. The target repo comes ONLY from the org's
  // config: a repo named in the body is ignored, never honoured.
  //
  // Rate-limited per api key: every call creates a branch and a PR on the
  // org's repository.
  const publishRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    keyFn: (req) => req.hubApiKey?.tokenHash ?? clientIp(req),
    message: 'Too many publish requests, slow down.',
  });
  // And per ORG: N laptops would otherwise get N times the budget against one
  // repository.
  const publishOrgRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    keyFn: (req) => `org:${req.hubApiKey?.orgId ?? clientIp(req)}`,
    message: 'Too many publish requests for this organisation, slow down.',
  });
  router.post('/registry/flows/publish', requireKey, publishRateLimit, publishOrgRateLimit, asyncRoute(async (req: Request, res: Response) => {
    const orgId = req.hubApiKey!.orgId;
    const flow = req.body?.flow;
    if (!flow || typeof flow !== 'object') return res.status(400).json({ error: 'flow is required' });
    // Bounded before anything reaches GitHub: the name becomes a branch and a
    // path, and GitHub caps a PR body at 65,536 characters.
    if (typeof flow.name !== 'string' || !slugify(flow.name) || flow.name.length > 100) {
      return res.status(400).json({ error: 'flow.name must be 1-100 characters and contain at least one letter or digit' });
    }
    if (flow.description !== undefined && flow.description !== null
      && (typeof flow.description !== 'string' || flow.description.length > 2000)) {
      return res.status(400).json({ error: 'flow.description must be a string of at most 2000 characters' });
    }
    if (flow.version !== undefined && flow.version !== null
      && (typeof flow.version !== 'string' || flow.version.length > 50)) {
      return res.status(400).json({ error: 'flow.version must be a string of at most 50 characters' });
    }
    const tooLong = (v: unknown, max: number) => v !== undefined && v !== null && (typeof v !== 'string' || v.length > max);
    if (!Array.isArray(flow.steps) || flow.steps.length > 200
      || flow.steps.some((st: any) => !st || typeof st !== 'object' || typeof st.name !== 'string'
        || !st.name.trim() || st.name.length > 100
        || tooLong(st.label, 200) || tooLong(st.exitCriteria, 10000))) {
      return res.status(400).json({
        error: 'flow.steps must be at most 200 steps, each with a name of 1-100 characters, '
          + 'a label of at most 200 and exit criteria of at most 10000',
      });
    }
    // Shown in the PR and credited in the file; reported by the installation,
    // not verified, and labelled so. Control characters and length are bounded.
    const reported = typeof req.body?.publisher === 'string' ? req.body.publisher : '';
    const publisher = reported.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || 'unknown';

    const cfg = await getRegistryConfig(ctx.db, orgId);
    if (cfg.isPublic) {
      return res.status(409).json({
        error: 'this org uses the public community registry; the hub does not write there. '
          + 'Publish from the installation, which opens the pull request with its own GitHub login.',
        public: true,
        repo: cfg.repo,
      });
    }
    const token = await registryToken(ctx.db, orgId, ctx.config.secretKey);
    if (!token) {
      return res.status(409).json({ error: `no GitHub token is stored for the org registry ${cfg.repo}; an admin must set one in Admin > Flows`, repo: cfg.repo });
    }
    try {
      const result = await publishFlowPullRequest(fetch, {
        repo: cfg.repo, branch: cfg.branch, token, flow, publisher,
        // The one attribution the hub itself can vouch for.
        installationId: req.hubApiKey!.installationId ?? null,
        allowContractRemoval: req.body?.allowContractRemoval === true,
      });
      if (result.kind === 'error') return res.status(result.status).json({ error: result.error, repo: cfg.repo });
      res.json(result);
    } catch (e: any) {
      res.status(502).json({ error: `Failed to publish to ${cfg.repo}`, detail: e?.message, repo: cfg.repo });
    }
  }));

  router.put('/flows/selection', requireKey, asyncRoute(async (req: Request, res: Response) => {
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
  }));

  return router;
}
