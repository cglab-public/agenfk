import { Router, Request, Response } from 'express';
import { HubServerContext } from '../server.js';
import { requireAdmin } from '../auth/session.js';
import { issueApiKey } from '../auth/apiKey.js';
import { encryptSecret } from '../crypto.js';
import { createPasswordUser, hashPassword } from '../auth/password.js';
import { randomUUID } from 'crypto';
import { DEFAULT_FLOW } from '@agenfk/core';
import { getAgenfkReleases } from '../services/githubReleases.js';

interface AuthConfigRow {
  org_id: string;
  password_enabled: number;
  google_enabled: number;
  google_client_id: string | null;
  google_client_secret_enc: string | null;
  entra_enabled: number;
  entra_tenant_id: string | null;
  entra_client_id: string | null;
  entra_client_secret_enc: string | null;
  email_allowlist: string | null;
}

function publicAuthConfig(row: AuthConfigRow) {
  return {
    passwordEnabled: !!row.password_enabled,
    googleEnabled: !!row.google_enabled,
    google: { clientId: row.google_client_id ?? '', clientSecretSet: !!row.google_client_secret_enc },
    entraEnabled: !!row.entra_enabled,
    entra: {
      tenantId: row.entra_tenant_id ?? '',
      clientId: row.entra_client_id ?? '',
      clientSecretSet: !!row.entra_client_secret_enc,
    },
    emailAllowlist: row.email_allowlist ? JSON.parse(row.email_allowlist) : [],
  };
}

export function adminRouter(ctx: HubServerContext): Router {
  const router = Router();
  const guard = requireAdmin(ctx.config.sessionSecret);

  // ── Auth config ──────────────────────────────────────────────────────────
  router.get('/auth-config', guard, async (req: Request, res: Response) => {
    const row = await ctx.db.get<AuthConfigRow>('SELECT * FROM auth_config WHERE org_id = ?', [req.session!.orgId]);
    if (!row) return res.status(404).json({ error: 'auth_config row missing for org' });
    res.json(publicAuthConfig(row));
  });

  router.put('/auth-config', guard, async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    const b = req.body ?? {};
    const updates: string[] = [];
    const params: any[] = [];
    const setField = (col: string, val: any) => { updates.push(`${col} = ?`); params.push(val); };

    if (b.passwordEnabled !== undefined) setField('password_enabled', b.passwordEnabled ? 1 : 0);
    if (b.googleEnabled !== undefined) setField('google_enabled', b.googleEnabled ? 1 : 0);
    if (b.google?.clientId !== undefined) setField('google_client_id', b.google.clientId || null);
    if (typeof b.google?.clientSecret === 'string' && b.google.clientSecret) {
      setField('google_client_secret_enc', encryptSecret(b.google.clientSecret, ctx.config.secretKey));
    }
    if (b.entraEnabled !== undefined) setField('entra_enabled', b.entraEnabled ? 1 : 0);
    if (b.entra?.tenantId !== undefined) setField('entra_tenant_id', b.entra.tenantId || null);
    if (b.entra?.clientId !== undefined) setField('entra_client_id', b.entra.clientId || null);
    if (typeof b.entra?.clientSecret === 'string' && b.entra.clientSecret) {
      setField('entra_client_secret_enc', encryptSecret(b.entra.clientSecret, ctx.config.secretKey));
    }
    if (Array.isArray(b.emailAllowlist)) setField('email_allowlist', JSON.stringify(b.emailAllowlist));

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    params.push(orgId);
    await ctx.db.run(`UPDATE auth_config SET ${updates.join(', ')} WHERE org_id = ?`, params);
    const row = await ctx.db.get<AuthConfigRow>('SELECT * FROM auth_config WHERE org_id = ?', [orgId]);
    if (!row) return res.status(404).json({ error: 'auth_config row missing for org' });
    res.json(publicAuthConfig(row));
  });

  // ── API keys (installation tokens) ───────────────────────────────────────
  router.get('/api-keys', guard, async (req: Request, res: Response) => {
    const rows = await ctx.db.all<any>(
      'SELECT token_hash, label, created_at, revoked_at, installation_id, os_user, git_name, git_email FROM api_keys WHERE org_id = ? ORDER BY created_at DESC',
      [req.session!.orgId],
    );
    res.json(rows.map(r => ({
      tokenHashPreview: r.token_hash.slice(0, 8),
      label: r.label,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
      installationId: r.installation_id ?? null,
      osUser: r.os_user ?? null,
      gitName: r.git_name ?? null,
      gitEmail: r.git_email ?? null,
    })));
  });

  router.post('/api-keys', guard, async (req: Request, res: Response) => {
    const label = typeof req.body?.label === 'string' ? req.body.label : null;
    const token = await issueApiKey(ctx.db, req.session!.orgId, label ?? undefined);
    res.status(201).json({ token, label });
  });

  router.delete('/api-keys/:tokenHashPreview', guard, async (req: Request, res: Response) => {
    const preview = req.params.tokenHashPreview;
    const result = await ctx.db.run(
      "UPDATE api_keys SET revoked_at = datetime('now') WHERE org_id = ? AND token_hash LIKE ? AND revoked_at IS NULL",
      [req.session!.orgId, `${preview}%`],
    );
    res.json({ revoked: result.changes });
  });

  // ── Users ────────────────────────────────────────────────────────────────
  router.get('/users', guard, async (req: Request, res: Response) => {
    const rows = await ctx.db.all(
      'SELECT id, email, provider, role, active, created_at, last_login_at FROM users WHERE org_id = ? ORDER BY created_at DESC',
      [req.session!.orgId],
    );
    res.json(rows);
  });

  router.post('/users/invite', guard, async (req: Request, res: Response) => {
    const { email, password, role } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'email + password (≥8 chars) required' });
    }
    if (role !== 'admin' && role !== 'viewer') return res.status(400).json({ error: 'role must be admin or viewer' });
    try {
      const u = await createPasswordUser(ctx.db, req.session!.orgId, email, password, role);
      res.status(201).json({ id: u.id, email: u.email, role: u.role });
    } catch (e: any) {
      res.status(409).json({ error: 'A user with that email already exists' });
    }
  });

  router.put('/users/:id', guard, async (req: Request, res: Response) => {
    const { role, active, password } = req.body ?? {};
    const sets: string[] = [];
    const params: any[] = [];
    if (role === 'admin' || role === 'viewer') { sets.push('role = ?'); params.push(role); }
    if (active === true || active === false) { sets.push('active = ?'); params.push(active ? 1 : 0); }
    if (typeof password === 'string' && password.length >= 8) { sets.push('password_hash = ?'); params.push(hashPassword(password)); }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.params.id, req.session!.orgId);
    const result = await ctx.db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`, params);
    if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  });

  router.delete('/users/:id', guard, async (req: Request, res: Response) => {
    if (req.session!.userId === req.params.id) return res.status(400).json({ error: 'Cannot delete the signed-in user' });
    const result = await ctx.db.run('DELETE FROM users WHERE id = ? AND org_id = ?', [req.params.id, req.session!.orgId]);
    if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  });

  // ── Flows ────────────────────────────────────────────────────────────────
  interface FlowRow {
    id: string;
    org_id: string;
    name: string;
    description: string | null;
    definition_json: string;
    source: 'hub' | 'community';
    version: number;
    created_at: string;
    updated_at: string;
    created_by_user_id: string | null;
  }

  const presentFlow = (r: FlowRow) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    source: r.source,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    definition: JSON.parse(r.definition_json),
  });

  // Validate that a flow definition body has the minimal shape we expect.
  // Mirrors core's `Flow` type contract (name + non-empty steps[] with id/name/order).
  const validateDefinition = (def: any): string | null => {
    if (!def || typeof def !== 'object') return 'definition must be an object';
    if (typeof def.name !== 'string' || !def.name.trim()) return 'definition.name is required';
    if (!Array.isArray(def.steps) || def.steps.length === 0) return 'definition.steps must be a non-empty array';
    for (const s of def.steps) {
      if (!s || typeof s !== 'object') return 'each step must be an object';
      if (typeof s.id !== 'string' || !s.id) return 'each step requires an id';
      if (typeof s.name !== 'string' || !s.name) return 'each step requires a name';
      if (typeof s.order !== 'number') return 'each step requires a numeric order';
    }
    return null;
  };

  // ── Project discovery (for assignment UI pickers) ───────────────────────
  // Returns the distinct project ids ever ingested for this org, with the
  // most-recent occurrence timestamp. Used by the hub-ui Assignments panel.
  router.get('/projects', guard, async (req: Request, res: Response) => {
    // remote_url enrichment (BUG b976a525): the hub admin sees these IDs in
    // the Flow Assignments UI, but project IDs are unique-per-installation
    // and meaningless across the fleet. Surface the latest known git remote
    // URL alongside, so chips and pickers can render the recognizable name.
    const rows = await ctx.db.all<{ project_id: string; last_seen: string; remote_url: string | null }>(
      `SELECT
         e.project_id,
         MAX(e.occurred_at) AS last_seen,
         (
           SELECT remote_url FROM events e2
           WHERE e2.org_id = e.org_id AND e2.project_id = e.project_id AND e2.remote_url IS NOT NULL
           ORDER BY e2.occurred_at DESC LIMIT 1
         ) AS remote_url
       FROM events e
       WHERE e.org_id = ? AND e.project_id IS NOT NULL AND e.project_id != ''
       GROUP BY e.project_id
       ORDER BY last_seen DESC`,
      [req.session!.orgId],
    );
    res.json(rows.map(r => ({
      projectId: r.project_id,
      lastSeen: r.last_seen,
      remoteUrl: r.remote_url ?? null,
    })));
  });

  // Built-in default flow — declared BEFORE /flows/:id so the literal ":id"
  // doesn't swallow `/flows/default`.
  router.get('/flows/default', guard, (_req: Request, res: Response) => {
    res.json(DEFAULT_FLOW);
  });

  router.get('/flows', guard, async (req: Request, res: Response) => {
    const rows = await ctx.db.all<FlowRow>(
      'SELECT * FROM flows WHERE org_id = ? ORDER BY updated_at DESC',
      [req.session!.orgId],
    );
    res.json(rows.map(presentFlow));
  });

  router.post('/flows', guard, async (req: Request, res: Response) => {
    const definition = req.body?.definition;
    const sourceIn = req.body?.source;
    const source: 'hub' | 'community' = sourceIn === 'community' ? 'community' : 'hub';
    const err = validateDefinition(definition);
    if (err) return res.status(400).json({ error: err });
    const id = randomUUID();
    await ctx.db.run(
      `INSERT INTO flows (id, org_id, name, description, definition_json, source, version, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        id,
        req.session!.orgId,
        definition.name,
        definition.description ?? null,
        JSON.stringify(definition),
        source,
        req.session!.userId ?? null,
      ],
    );
    const row = await ctx.db.get<FlowRow>('SELECT * FROM flows WHERE id = ?', [id]);
    res.status(201).json(presentFlow(row!));
  });

  router.get('/flows/:id', guard, async (req: Request, res: Response) => {
    const row = await ctx.db.get<FlowRow>(
      'SELECT * FROM flows WHERE id = ? AND org_id = ?',
      [req.params.id, req.session!.orgId],
    );
    if (!row) return res.status(404).json({ error: 'Flow not found' });
    res.json(presentFlow(row));
  });

  router.put('/flows/:id', guard, async (req: Request, res: Response) => {
    const existing = await ctx.db.get<FlowRow>(
      'SELECT * FROM flows WHERE id = ? AND org_id = ?',
      [req.params.id, req.session!.orgId],
    );
    if (!existing) return res.status(404).json({ error: 'Flow not found' });
    const definition = req.body?.definition;
    const err = validateDefinition(definition);
    if (err) return res.status(400).json({ error: err });
    await ctx.db.run(
      `UPDATE flows
       SET name = ?, description = ?, definition_json = ?, version = version + 1, updated_at = datetime('now')
       WHERE id = ? AND org_id = ?`,
      [
        definition.name,
        definition.description ?? null,
        JSON.stringify(definition),
        req.params.id,
        req.session!.orgId,
      ],
    );
    const row = await ctx.db.get<FlowRow>('SELECT * FROM flows WHERE id = ?', [req.params.id]);
    res.json(presentFlow(row!));
  });

  router.delete('/flows/:id', guard, async (req: Request, res: Response) => {
    // Refuse to delete a flow that is currently assigned at any scope.
    const assignments = await ctx.db.all<{ scope: string; target_id: string }>(
      'SELECT scope, target_id FROM flow_assignments WHERE org_id = ? AND flow_id = ?',
      [req.session!.orgId, req.params.id],
    );
    if (assignments.length > 0) {
      const summary = assignments
        .map(a => a.scope === 'org' ? 'org default' : `${a.scope} ${a.target_id}`)
        .join(', ');
      return res.status(409).json({
        error: `Flow is currently assigned (${summary}) — clear the assignment(s) first.`,
      });
    }
    const result = await ctx.db.run(
      'DELETE FROM flows WHERE id = ? AND org_id = ?',
      [req.params.id, req.session!.orgId],
    );
    if (result.changes === 0) return res.status(404).json({ error: 'Flow not found' });
    res.json({ ok: true });
  });

  // ── Flow assignments (multi-scope) ───────────────────────────────────────
  // List shape: array of { scope, targetId, flowId, updatedAt } so hub-ui can
  // render org/project/installation overrides in one pass.
  router.get('/flow-assignments', guard, async (req: Request, res: Response) => {
    const rows = await ctx.db.all<{ scope: string; target_id: string; flow_id: string; updated_at: string }>(
      'SELECT scope, target_id, flow_id, updated_at FROM flow_assignments WHERE org_id = ? ORDER BY scope, target_id',
      [req.session!.orgId],
    );

    // BUG b976a525: enrich project-scoped rows with their git remote URL so
    // the admin UI can render a recognizable identity instead of a UUID.
    const projectTargetIds = rows
      .filter(r => r.scope === 'project')
      .map(r => r.target_id);
    const remoteByProjectId = new Map<string, string | null>();
    if (projectTargetIds.length > 0) {
      const placeholders = projectTargetIds.map(() => '?').join(',');
      const remoteRows = await ctx.db.all<{ project_id: string; remote_url: string | null }>(
        `SELECT e.project_id,
           (SELECT remote_url FROM events e2
            WHERE e2.org_id = e.org_id AND e2.project_id = e.project_id AND e2.remote_url IS NOT NULL
            ORDER BY e2.occurred_at DESC LIMIT 1) AS remote_url
         FROM events e
         WHERE e.org_id = ? AND e.project_id IN (${placeholders})
         GROUP BY e.project_id`,
        [req.session!.orgId, ...projectTargetIds],
      );
      for (const rr of remoteRows) remoteByProjectId.set(rr.project_id, rr.remote_url ?? null);
    }

    res.json(rows.map(r => ({
      scope: r.scope,
      targetId: r.target_id,
      flowId: r.flow_id,
      updatedAt: r.updated_at,
      remoteUrl: r.scope === 'project' ? (remoteByProjectId.get(r.target_id) ?? null) : null,
    })));
  });

  // ── Community registry proxy ────────────────────────────────────────────
  // Mirrors the local server's /registry/flows surface so the FlowEditorModal
  // running inside hub-ui can browse and install community flows without
  // talking to a per-installation agenfk server.
  const REGISTRY_OWNER = process.env.AGENFK_REGISTRY_OWNER ?? 'cglab-public';
  const REGISTRY_REPO = process.env.AGENFK_REGISTRY_REPO ?? 'agenfk-flows';
  const REGISTRY_BRANCH = process.env.AGENFK_REGISTRY_BRANCH ?? 'main';
  const GITHUB_API = 'https://api.github.com';

  interface RegistryFlowEntry {
    filename: string;
    name: string;
    author?: string;
    version?: string;
    stepCount: number;
    description?: string;
    steps?: { name: string; label: string }[];
  }

  router.get('/registry/flows', guard, async (_req: Request, res: Response) => {
    const url = `${GITHUB_API}/repos/${REGISTRY_OWNER}/${REGISTRY_REPO}/contents/flows?ref=${REGISTRY_BRANCH}`;
    try {
      const resp = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agenfk-hub' } });
      if (resp.status === 404) return res.json([]);
      if (!resp.ok) return res.status(resp.status).json({ error: 'Failed to fetch registry' });
      const entries: any = await resp.json();
      if (!Array.isArray(entries)) return res.json([]);
      const jsonFiles = entries.filter((e: any) => e.type === 'file' && e.name.endsWith('.json'));
      const flows: RegistryFlowEntry[] = await Promise.all(
        jsonFiles.map(async (file: any) => {
          try {
            const r = await fetch(file.download_url, { headers: { 'User-Agent': 'agenfk-hub' } });
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
        }),
      );
      res.json(flows);
    } catch (e: any) {
      res.status(502).json({ error: 'Failed to fetch registry', detail: e?.message });
    }
  });

  // ── Install from registry into the org's flows table (source='community') ──
  router.post('/flows/install', guard, async (req: Request, res: Response) => {
    const filename = typeof req.body?.filename === 'string' ? req.body.filename : null;
    if (!filename) return res.status(400).json({ error: 'filename is required' });
    const url = `${GITHUB_API}/repos/${REGISTRY_OWNER}/${REGISTRY_REPO}/contents/flows/${encodeURIComponent(filename)}?ref=${REGISTRY_BRANCH}`;
    try {
      const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agenfk-hub' } });
      if (!r.ok) return res.status(r.status).json({ error: 'Failed to fetch registry file' });
      const fileInfo: any = await r.json();
      const rawContent = Buffer.from(fileInfo.content, 'base64').toString('utf8');
      const flowData = JSON.parse(rawContent);

      // Normalise step shape: drop anchors and add fresh ones (matches local
      // server's /registry/flows/install transform, so installed flows behave
      // identically wherever they land).
      const rawSteps: any[] = Array.isArray(flowData.steps) ? flowData.steps : [];
      const middle = rawSteps
        .filter((s: any) => !s.isAnchor && s.name?.toUpperCase() !== 'TODO' && s.name?.toUpperCase() !== 'DONE')
        .map((s: any, i: number) => ({
          id: randomUUID(),
          name: s.name ?? `step-${i}`,
          label: s.label ?? s.name ?? `Step ${i + 1}`,
          order: i + 1,
          exitCriteria: s.exitCriteria ?? '',
          isSpecial: s.isSpecial ?? false,
        }));
      const steps = [
        { id: randomUUID(), name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true },
        ...middle,
        { id: randomUUID(), name: 'DONE', label: 'Done', order: middle.length + 1, exitCriteria: '', isAnchor: true },
      ];
      const definition = {
        name: flowData.name ?? filename.replace('.json', ''),
        description: flowData.description ?? '',
        steps,
      };

      const id = randomUUID();
      await ctx.db.run(
        `INSERT INTO flows (id, org_id, name, description, definition_json, source, version, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, 'community', 1, ?)`,
        [id, req.session!.orgId, definition.name, definition.description, JSON.stringify(definition), req.session!.userId ?? null],
      );
      const row = await ctx.db.get<FlowRow>('SELECT * FROM flows WHERE id = ?', [id]);
      res.status(201).json(presentFlow(row!));
    } catch (e: any) {
      res.status(502).json({ error: 'Failed to install flow', detail: e?.message });
    }
  });

  router.put('/flow-assignments', guard, async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    const body = req.body ?? {};
    // Default scope to 'org' for legacy callers that send only `{ flowId }`.
    const scope: 'org' | 'project' | 'installation' = body.scope ?? 'org';
    if (!['org', 'project', 'installation'].includes(scope)) {
      return res.status(400).json({ error: "scope must be 'org', 'project', or 'installation'" });
    }
    const targetId: string = scope === 'org' ? '' : (body.targetId ?? '');
    if (scope !== 'org' && !targetId) {
      return res.status(400).json({ error: `targetId is required for scope='${scope}'` });
    }
    const flowId = body.flowId;

    // Clear path: flowId === null deletes the assignment row.
    if (flowId === null) {
      await ctx.db.run(
        'DELETE FROM flow_assignments WHERE org_id = ? AND scope = ? AND target_id = ?',
        [orgId, scope, targetId],
      );
      return res.json({ scope, targetId: targetId || null, flowId: null });
    }
    if (typeof flowId !== 'string' || !flowId) {
      return res.status(400).json({ error: 'flowId must be a string or null' });
    }

    // Validate flowId belongs to this org.
    const owned = await ctx.db.get<FlowRow>(
      'SELECT id FROM flows WHERE id = ? AND org_id = ?',
      [flowId, orgId],
    );
    if (!owned) return res.status(404).json({ error: 'Flow not found in this org' });

    // Validate targetId for installation scope.
    if (scope === 'installation') {
      const inst = await ctx.db.get<{ id: string }>(
        'SELECT id FROM installations WHERE id = ? AND org_id = ?',
        [targetId, orgId],
      );
      if (!inst) return res.status(404).json({ error: 'Installation not found in this org' });
    }
    // Project scope: project ids are not enforced here — the events table is
    // the only source of project ids and we don't want to refuse pre-creating
    // an override before any event has been ingested. Validation could be added
    // later via /v1/admin/projects discovery.

    await ctx.db.transaction(async () => {
      await ctx.db.run(
        'DELETE FROM flow_assignments WHERE org_id = ? AND scope = ? AND target_id = ?',
        [orgId, scope, targetId],
      );
      await ctx.db.run(
        `INSERT INTO flow_assignments (org_id, scope, target_id, flow_id, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?)`,
        [orgId, scope, targetId, flowId, req.session!.userId ?? null],
      );
    });
    res.json({ scope, targetId: targetId || null, flowId });
  });

  // ── Fleet upgrade directives (Story 2 of EPIC 541c12b3) ────────────────
  // Strict semver allowlist mirrors the CLI's SEMVER_TAG_RE — a directive's
  // targetVersion is interpolated into shell calls on the fleet side
  // (gh release view / git tag), so we never accept anything else.
  const SEMVER_TAG_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

  // GET /v1/admin/upgrade/available-versions — versions an admin can target,
  // sourced from the public agenfk GitHub release list and filtered to
  // releases >= the org's fleet floor (the oldest agenfk_version any
  // installation in this org has reported). Sorted newest → oldest.
  router.get('/upgrade/available-versions', guard, async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    let releases: string[];
    try {
      releases = await getAgenfkReleases();
    } catch (e: any) {
      return res.status(503).json({ error: `Could not fetch release list: ${e?.message ?? e}` });
    }

    const versionRows = await ctx.db.all<{ agenfk_version: string }>(
      `SELECT agenfk_version FROM installations
        WHERE org_id = ? AND agenfk_version IS NOT NULL AND agenfk_version <> ''`,
      [orgId],
    );
    const fleetFloor = versionRows.length === 0
      ? null
      : versionRows
          .map(r => r.agenfk_version)
          .reduce((oldest, v) => (compareSemver(v, oldest) < 0 ? v : oldest));

    const filtered = fleetFloor
      ? releases.filter(v => compareSemver(v, fleetFloor) >= 0)
      : releases.slice();
    filtered.sort((a, b) => compareSemver(b, a)); // newest → oldest

    res.json({ versions: filtered, fleetFloor });
  });

  router.post('/upgrade', guard, async (req: Request, res: Response) => {
    const { targetVersion, scope, confirmDowngrade } = req.body ?? {};
    if (typeof targetVersion !== 'string' || !SEMVER_TAG_RE.test(targetVersion)) {
      return res.status(400).json({ error: 'targetVersion must be a semver string (e.g. 0.3.1 or 0.3.0-beta.22)' });
    }
    if (!scope || (scope.type !== 'all' && scope.type !== 'installation')) {
      return res.status(400).json({ error: "scope.type must be 'all' or 'installation'" });
    }
    if (scope.type === 'installation' && (typeof scope.installationId !== 'string' || !scope.installationId)) {
      return res.status(400).json({ error: 'scope.installationId required when scope.type=installation' });
    }

    const releaseExists = ctx.config.releaseExists ?? defaultReleaseExists;
    const exists = await releaseExists(targetVersion);
    if (!exists) {
      return res.status(422).json({ error: `Release ${targetVersion} not found` });
    }

    const orgId = req.session!.orgId;
    type Inst = { id: string; agenfk_version: string | null };
    let installations: Inst[];
    if (scope.type === 'all') {
      installations = await ctx.db.all<Inst>(
        'SELECT id, agenfk_version FROM installations WHERE org_id = ?',
        [orgId],
      );
    } else {
      const inst = await ctx.db.get<Inst>(
        'SELECT id, agenfk_version FROM installations WHERE id = ? AND org_id = ?',
        [scope.installationId, orgId],
      );
      if (!inst) return res.status(404).json({ error: 'Installation not found in this org' });
      installations = [inst];
    }

    // Story 5: single-pending guard. Refuse if any in-scope installation
    // already has a pending or in_progress target on a prior directive.
    if (installations.length > 0) {
      const ids = installations.map(i => i.id);
      const placeholders = ids.map(() => '?').join(',');
      const conflicts = await ctx.db.all<{ installation_id: string; directive_id: string }>(
        `SELECT t.installation_id, t.directive_id
         FROM upgrade_directive_targets t
         JOIN upgrade_directives d ON d.id = t.directive_id
         WHERE d.org_id = ?
           AND t.installation_id IN (${placeholders})
           AND t.state IN ('pending', 'in_progress')`,
        [orgId, ...ids],
      );
      if (conflicts.length > 0) {
        return res.status(409).json({
          error: 'One or more installations already have an upgrade in progress',
          conflicts: conflicts.map(c => ({
            installationId: c.installation_id,
            conflictingDirectiveId: c.directive_id,
          })),
        });
      }
    }

    // Story 5: downgrade confirmation. Compare against each installation's
    // last-known agenfk_version; if the target moves any of them backwards,
    // require confirmDowngrade=true.
    if (confirmDowngrade !== true) {
      const downgrades: Array<{ installationId: string; currentVersion: string; targetVersion: string }> = [];
      for (const inst of installations) {
        if (inst.agenfk_version && compareSemver(targetVersion, inst.agenfk_version) < 0) {
          downgrades.push({
            installationId: inst.id,
            currentVersion: inst.agenfk_version,
            targetVersion,
          });
        }
      }
      if (downgrades.length > 0) {
        return res.status(409).json({
          error: 'Directive would downgrade one or more installations. Re-submit with confirmDowngrade=true to proceed.',
          downgrades,
        });
      }
    }

    const directiveId = randomUUID();
    const requestIp = (req.ip || req.socket?.remoteAddress || '').toString();
    let createdByEmail: string | null = null;
    if (req.session?.userId) {
      const u = await ctx.db.get<{ email: string }>(
        'SELECT email FROM users WHERE id = ?',
        [req.session.userId],
      );
      createdByEmail = u?.email ?? null;
    }
    await ctx.db.transaction(async () => {
      await ctx.db.run(
        `INSERT INTO upgrade_directives
           (id, org_id, target_version, scope_type, scope_id, created_by_user_id, created_by_email, request_ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          directiveId, orgId, targetVersion,
          scope.type, scope.type === 'installation' ? scope.installationId : null,
          req.session!.userId ?? null,
          createdByEmail,
          requestIp,
        ],
      );
      for (const inst of installations) {
        await ctx.db.run(
          `INSERT INTO upgrade_directive_targets (directive_id, installation_id, state)
           VALUES (?, ?, 'pending')`,
          [directiveId, inst.id],
        );
      }
    });

    res.status(201).json({ directiveId, targetVersion, targetCount: installations.length });
  });

  router.get('/upgrade', guard, async (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    const directives = await ctx.db.all<{
      id: string; target_version: string; scope_type: string; scope_id: string | null;
      created_by_user_id: string | null; created_by_email: string | null; request_ip: string | null;
      created_at: string; expires_at: string | null;
    }>(
      `SELECT id, target_version, scope_type, scope_id, created_by_user_id, created_by_email, request_ip, created_at, expires_at
       FROM upgrade_directives WHERE org_id = ? ORDER BY created_at DESC`,
      [orgId],
    );
    const out: any[] = [];
    for (const d of directives) {
      const targets = await ctx.db.all<{
        installation_id: string; state: string;
        attempted_at: string | null; finished_at: string | null;
        result_version: string | null; error_message: string | null;
        agenfk_version: string | null; agenfk_version_updated_at: string | null;
      }>(
        `SELECT t.installation_id, t.state, t.attempted_at, t.finished_at, t.result_version, t.error_message,
                i.agenfk_version, i.agenfk_version_updated_at
         FROM upgrade_directive_targets t
         LEFT JOIN installations i ON i.id = t.installation_id
         WHERE t.directive_id = ?`,
        [d.id],
      );
      const progress = { pending: 0, in_progress: 0, succeeded: 0, failed: 0 };
      for (const t of targets) {
        if (t.state in progress) (progress as any)[t.state] = Number((progress as any)[t.state]) + 1;
      }
      out.push({
        directiveId: d.id,
        targetVersion: d.target_version,
        scope: { type: d.scope_type, installationId: d.scope_id },
        createdAt: d.created_at,
        createdByUserId: d.created_by_user_id,
        createdByEmail: d.created_by_email,
        requestIp: d.request_ip,
        expiresAt: d.expires_at,
        progress,
        targets: targets.map(t => ({
          installationId: t.installation_id,
          state: t.state,
          attemptedAt: t.attempted_at,
          finishedAt: t.finished_at,
          resultVersion: t.result_version,
          errorMessage: t.error_message,
          agenfkVersion: t.agenfk_version,
          agenfkVersionUpdatedAt: t.agenfk_version_updated_at,
        })),
      });
    }
    res.json({ directives: out });
  });

  return router;
}

/**
 * Lightweight semver comparator (returns negative/zero/positive) for the
 * downgrade-detection guard. Handles the 0.x.y[-prerelease] shape the agenfk
 * release pipeline emits; falls back to lexical comparison for anything we
 * can't parse, which is conservative — unknown shapes won't trigger a false
 * downgrade-warning.
 */
function compareSemver(a: string, b: string): number {
  const parse = (s: string) => {
    const m = s.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? '' };
  };
  const pa = parse(a); const pb = parse(b);
  if (!pa || !pb) return a.localeCompare(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  // Per semver: a release is greater than its prerelease ("1.0.0" > "1.0.0-rc.1").
  if (pa.pre === '' && pb.pre !== '') return 1;
  if (pa.pre !== '' && pb.pre === '') return -1;
  return pa.pre.localeCompare(pb.pre);
}

/**
 * Default version-existence check: hits the GitHub Releases API. Replaced by
 * the test stub via HubServerConfig.releaseExists.
 */
async function defaultReleaseExists(version: string): Promise<boolean> {
  const tag = version.startsWith('v') ? version : `v${version}`;
  try {
    const resp = await fetch(`https://api.github.com/repos/cglab-public/agenfk/releases/tags/${tag}`, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'agenfk-hub' },
    });
    return resp.status === 200;
  } catch {
    return false;
  }
}
