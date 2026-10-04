import type { Request, Response, NextFunction, Express, RequestHandler } from 'express';
import type { DB } from '../db.js';
import { recordAudit, type AuditSource } from './configAudit.js';

/**
 * Which hub routes change configuration, and how each is audited (STORY
 * a89af514). The table is the one source: a route's audit entry sits next to
 * every other's, and the completeness test holds it against the routers the
 * hub actually serves - a mutating route is either here or in
 * AUDIT_EXEMPT_ROUTES with the reason it is not configuration.
 *
 * installConfigAudit puts an audit layer INTO each audited route's own stack,
 * after its guards and right before its handler (BUG 91d2941d). Express has
 * then matched the route (its case-insensitivity, its trailing-slash rule) and
 * decoded the params, and a guard has said who is asking: nothing is read for
 * a request that was refused, and the layer never parses a URL itself. The
 * row is written before the reply goes out - res.end waits for it - so a
 * client that hangs up cannot leave a committed change unrecorded.
 *
 * A row is written only when the change succeeded (2xx). `snapshot` reads the
 * target's state before the handler runs and again after, so the row says
 * from what to what; without one the row keeps the request's body as `after`.
 * Secrets in either are redacted by recordAudit.
 */
type Params = Record<string, string>;
type Snapshot = (db: DB, orgId: string, p: Params, req: Request) => Promise<unknown>;

export interface AuditedRoute {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Full path as served, with :params. */
  path: string;
  area: string;
  action: string;
  /** What was changed, in words. `body` is the handler's JSON reply, for an id it created. */
  target?: (p: Params, req: Request, body: any) => string | null;
  snapshot?: Snapshot;
  /** A create: the new row's id in the reply, so `after` is the stored row (via `snapshot`), not the request. */
  createdId?: (body: any) => string | null;
  /** The request body is not what changed (or not safe to keep): record no `after` without a snapshot. */
  noBody?: boolean;
  /** Where an older, partial trail of the same kind lives on the board. */
  link?: string;
  /** The org the row belongs to once the change is made, when the change is to the org's id itself. */
  orgAfter?: (req: Request) => string | null;
  /** Who acted, when the request carries no session or key (a sign-in that creates one). */
  actorFromReply?: (body: any) => { userId: string | null; email: string | null } | null;
  /** Who acted, from the request, when it carries no credential (the first admin's setup). */
  actorFromRequest?: (req: Request) => { userId: string | null; email: string | null } | null;
  /** Where the change came from when no credential says (default: system). */
  source?: AuditSource;
}

const parse = (s: unknown) => { try { return typeof s === 'string' ? JSON.parse(s) : s ?? null; } catch { return s; } };
const flowSnap: Snapshot = async (db, orgId, p) => {
  const r = await db.get<any>('SELECT id, name, description, definition_json, source, version, org_available FROM flows WHERE id = ? AND org_id = ?', [p.id, orgId]);
  if (!r) return null;
  const { definition_json, ...rest } = r;
  return { ...rest, org_available: Number(r.org_available), definition: parse(definition_json) };
};
// password_hash rides along so a reset reads "[secret: changed]"; recordAudit never stores it.
const userSnap: Snapshot = async (db, orgId, p) =>
  (await db.get('SELECT id, email, name, role, active, provider, password_hash FROM users WHERE id = ? AND org_id = ?', [p.id, orgId])) ?? null;
const authConfigSnap: Snapshot = async (db, orgId) => (await db.get('SELECT * FROM auth_config WHERE org_id = ?', [orgId])) ?? null;
const registrySnap: Snapshot = async (db, orgId) =>
  (await db.get('SELECT registry_repo, registry_branch, registry_token_enc, identity_policy FROM org_settings WHERE org_id = ?', [orgId])) ?? null;
const assignmentsSnap: Snapshot = async (db, orgId) =>
  db.all('SELECT scope, target_id, flow_id FROM flow_assignments WHERE org_id = ? ORDER BY scope, target_id', [orgId]);
const childHubSnap: Snapshot = async (db, orgId, p) => (await db.get('SELECT * FROM child_hubs WHERE id = ? AND org_id = ?', [p.id, orgId])) ?? null;
const identityPolicySnap: Snapshot = async (db, orgId) =>
  (await db.get('SELECT identity_policy FROM org_settings WHERE org_id = ?', [orgId])) ?? null;
/** A param, or the same field of the body (a create names its key there). */
const keyOf = (p: Params, req: Request, k: string) => (p[k] ?? (typeof req.body?.[k] === 'string' ? req.body[k] : '')).trim();
const hiddenSnap: Snapshot = async (db, orgId, p, req) =>
  (await db.get('SELECT user_key, hidden_by_email FROM hidden_users WHERE org_id = ? AND user_key = ?', [orgId, keyOf(p, req, 'userKey').toLowerCase()])) ?? null;
const mappingSnap: Snapshot = async (db, orgId, p, req) =>
  (await db.get('SELECT alias_model, canonical_model FROM model_mappings WHERE org_id = ? AND alias_model = ?', [orgId, keyOf(p, req, 'aliasModel')])) ?? null;
const modelMetaSnap: Snapshot = async (db, orgId, p, req) =>
  (await db.get('SELECT model, provider, license_class, license, source FROM model_meta WHERE org_id = ? AND model = ?', [orgId, keyOf(p, req, 'model')])) ?? null;
const installationSnap: Snapshot = async (db, orgId, p) =>
  (await db.get('SELECT * FROM installations WHERE id = ? AND org_id = ?', [p.id, orgId])) ?? null;
// The handler takes the preview in any case and revokes the one LIVE key it names (BUG 915f76ed): the snapshot
// finds that key the same way before, and by its full hash after, once it is revoked.
const apiKeySnap: Snapshot = async (db, orgId, p, req) => {
  const known = (req as any)._auditApiKeyHash as string | undefined;
  const row = known
    ? await db.get<any>('SELECT token_hash, label, created_at, revoked_at, installation_id FROM api_keys WHERE org_id = ? AND token_hash = ?', [orgId, known])
    : await db.get<any>('SELECT token_hash, label, created_at, revoked_at, installation_id FROM api_keys WHERE org_id = ? AND lower(token_hash) LIKE ? AND revoked_at IS NULL', [orgId, `${String(p.tokenHashPreview ?? '').toLowerCase()}%`]);
  if (!row) return null;
  (req as any)._auditApiKeyHash = row.token_hash;
  const { token_hash: _hash, ...rest } = row;
  return rest;
};
const jiraSnap: Snapshot = async (db, orgId) =>
  (await db.get('SELECT client_id, client_secret_enc, updated_at FROM org_jira WHERE org_id = ?', [orgId])) ?? null;

const param = (k: string, label: string) => (p: Params) => `${label} ${p[k] ?? ''}`.trim();
const bodyField = (k: string, label: string) => (_p: Params, req: Request) => (typeof req.body?.[k] === 'string' ? `${label} ${req.body[k]}` : label);

export const AUDITED_ROUTES: AuditedRoute[] = [
  // Sign-in
  { method: 'PUT', path: '/v1/admin/auth-config', area: 'sign-in', action: 'auth-config.update', target: () => 'sign-in settings', snapshot: authConfigSnap },
  { method: 'POST', path: '/auth/recover', area: 'sign-in', action: 'admin.recover', target: (_p, _r, b) => `admin ${b?.email ?? ''}`.trim(), noBody: true, actorFromReply: b => (b?.id ? { userId: b.id, email: b.email ?? null } : null) },
  { method: 'POST', path: '/setup/initial-admin', area: 'users', action: 'admin.bootstrap', target: bodyField('email', 'admin'), noBody: true, source: 'board', actorFromRequest: req => (typeof req.body?.email === 'string' ? { userId: null, email: req.body.email } : null) },
  // API keys and installations
  { method: 'POST', path: '/v1/admin/api-keys', area: 'api-keys', action: 'api-key.issue', target: bodyField('label', 'API key'), noBody: true },
  { method: 'DELETE', path: '/v1/admin/api-keys/:tokenHashPreview', area: 'api-keys', action: 'api-key.revoke', target: param('tokenHashPreview', 'API key'), snapshot: apiKeySnap },
  { method: 'POST', path: '/hub/device/approve', area: 'api-keys', action: 'device.approve', target: bodyField('userCode', 'device'), noBody: true },
  { method: 'POST', path: '/hub/invite/create', area: 'api-keys', action: 'invite.create', target: () => 'installation invite', noBody: true },
  { method: 'POST', path: '/hub/invite/redeem', area: 'api-keys', action: 'invite.redeem', target: () => 'installation invite', noBody: true, source: 'cli' },
  { method: 'POST', path: '/v1/admin/installations/:id/retire', area: 'installations', action: 'installation.retire', target: param('id', 'installation'), snapshot: installationSnap, link: '/admin/installations' },
  { method: 'DELETE', path: '/v1/admin/installations/:id/retire', area: 'installations', action: 'installation.restore', target: param('id', 'installation'), snapshot: installationSnap, link: '/admin/installations' },
  // People
  { method: 'POST', path: '/v1/admin/users/invite', area: 'users', action: 'user.invite', target: bodyField('email', 'user') },
  { method: 'PUT', path: '/v1/admin/users/:id', area: 'users', action: 'user.update', target: param('id', 'user'), snapshot: userSnap },
  { method: 'DELETE', path: '/v1/admin/users/:id', area: 'users', action: 'user.delete', target: param('id', 'user'), snapshot: userSnap },
  { method: 'POST', path: '/v1/admin/hidden-users', area: 'people', action: 'person.hide', target: bodyField('userKey', 'person'), snapshot: hiddenSnap },
  { method: 'DELETE', path: '/v1/admin/hidden-users/:userKey', area: 'people', action: 'person.unhide', target: param('userKey', 'person'), snapshot: hiddenSnap },
  { method: 'POST', path: '/v1/admin/user-keys/merge', area: 'identities', action: 'identity.merge', target: () => 'identity merge', link: '/admin/identities' },
  { method: 'POST', path: '/v1/admin/user-keys/merges/:id/revert', area: 'identities', action: 'identity.merge-revert', target: param('id', 'merge'), link: '/admin/identities' },
  { method: 'POST', path: '/v1/admin/repoint', area: 'identities', action: 'repoint.start', target: () => 'repoint', link: '/admin/repoint' },
  { method: 'POST', path: '/v1/admin/repoint/:id/close', area: 'identities', action: 'repoint.close', target: param('id', 'repoint'), link: '/admin/repoint' },
  // Models
  { method: 'PUT', path: '/v1/admin/models/meta', area: 'models', action: 'model.classify', target: bodyField('model', 'model'), snapshot: modelMetaSnap, link: '/admin/models' },
  { method: 'DELETE', path: '/v1/admin/models/meta/:model', area: 'models', action: 'model.unclassify', target: param('model', 'model'), snapshot: modelMetaSnap, link: '/admin/models' },
  { method: 'POST', path: '/v1/admin/models/mappings', area: 'models', action: 'model.map', target: bodyField('aliasModel', 'alias'), snapshot: mappingSnap, link: '/admin/models' },
  { method: 'DELETE', path: '/v1/admin/models/mappings/:aliasModel', area: 'models', action: 'model.unmap', target: param('aliasModel', 'alias'), snapshot: mappingSnap, link: '/admin/models' },
  // Flows
  { method: 'POST', path: '/v1/admin/flows', area: 'flows', action: 'flow.create', target: (_p, req, b) => `flow ${req.body?.definition?.name ?? ''} (${b?.id ?? '?'})`, snapshot: flowSnap, createdId: b => b?.id ?? null },
  { method: 'PUT', path: '/v1/admin/flows/:id', area: 'flows', action: 'flow.update', target: param('id', 'flow'), snapshot: flowSnap },
  { method: 'PUT', path: '/v1/admin/flows/:id/availability', area: 'flows', action: 'flow.availability', target: param('id', 'flow'), snapshot: flowSnap },
  { method: 'DELETE', path: '/v1/admin/flows/:id', area: 'flows', action: 'flow.delete', target: param('id', 'flow'), snapshot: flowSnap },
  { method: 'POST', path: '/v1/admin/flows/install', area: 'flows', action: 'flow.install', target: bodyField('filename', 'registry flow') },
  { method: 'PUT', path: '/v1/admin/flow-assignments', area: 'flows', action: 'flow.assign', target: (_p, req) => `${req.body?.scope ?? 'org'} ${req.body?.targetId ?? ''}`.trim(), snapshot: assignmentsSnap },
  { method: 'POST', path: '/v1/registry/flows/install', area: 'flows', action: 'flow.install', target: bodyField('filename', 'registry flow') },
  { method: 'POST', path: '/v1/registry/flows/publish', area: 'flows', action: 'flow.publish', target: (_p, req) => `flow ${req.body?.flow?.name ?? req.body?.name ?? ''}`.trim() },
  { method: 'PUT', path: '/v1/flows/selection', area: 'flows', action: 'flow.select', target: (_p, req) => `${req.body?.repo ?? req.body?.projectId ?? ''} -> ${req.body?.flowId ?? ''}` },
  // Registry
  { method: 'PUT', path: '/v1/admin/registry-config', area: 'registry', action: 'registry.update', target: () => 'flow registry', snapshot: registrySnap },
  { method: 'POST', path: '/v1/admin/registry-config/sync', area: 'registry', action: 'registry.sync', target: () => 'flow registry', noBody: true },
  // Upgrades
  { method: 'POST', path: '/v1/admin/upgrade', area: 'upgrades', action: 'upgrade.create', target: bodyField('version', 'upgrade to'), link: '/admin/upgrades' },
  { method: 'POST', path: '/v1/admin/upgrade/:directiveId/cancel', area: 'upgrades', action: 'upgrade.cancel', target: param('directiveId', 'upgrade'), link: '/admin/upgrades' },
  { method: 'POST', path: '/v1/admin/upgrade-dispatches', area: 'upgrades', action: 'upgrade.dispatch', target: bodyField('version', 'group upgrade to'), link: '/admin/upgrades' },
  { method: 'POST', path: '/v1/admin/upgrade-dispatches/:id/cancel', area: 'upgrades', action: 'upgrade.dispatch-cancel', target: param('id', 'group upgrade'), link: '/admin/upgrades' },
  // Federation
  { method: 'POST', path: '/v1/admin/flow-dispatches', area: 'federation', action: 'flow.dispatch', target: bodyField('flowId', 'flow') },
  { method: 'POST', path: '/v1/admin/flow-dispatches/:id/cancel', area: 'federation', action: 'flow.dispatch-cancel', target: param('id', 'dispatch') },
  { method: 'PUT', path: '/v1/admin/child-hubs/:id', area: 'federation', action: 'child-hub.update', target: param('id', 'child hub'), snapshot: childHubSnap },
  { method: 'POST', path: '/v1/admin/child-hubs/:id/detach', area: 'federation', action: 'child-hub.detach', target: param('id', 'child hub'), snapshot: childHubSnap },
  { method: 'POST', path: '/v1/admin/child-hubs/invite', area: 'federation', action: 'child-hub.invite', target: () => 'child hub invite', noBody: true },
  { method: 'PUT', path: '/v1/admin/child-hubs/:id/identity-policy', area: 'federation', action: 'child-hub.identity-policy', target: param('id', 'child hub'), snapshot: childHubSnap },
  { method: 'POST', path: '/v1/admin/federation/join', area: 'federation', action: 'parent.join', target: () => 'parent hub', noBody: true },
  { method: 'POST', path: '/v1/admin/federation/release-request', area: 'federation', action: 'parent.release-request', target: () => 'parent hub' },
  { method: 'DELETE', path: '/v1/admin/federation', area: 'federation', action: 'parent.leave', target: () => 'parent hub' },
  { method: 'PUT', path: '/v1/admin/federation/identity-policy', area: 'federation', action: 'identity-policy.update', target: () => 'identity policy', snapshot: identityPolicySnap },
  { method: 'POST', path: '/hub/federation/invite/create', area: 'federation', action: 'child-hub.invite', target: () => 'child hub invite', noBody: true },
  { method: 'POST', path: '/v1/federation/enroll', area: 'federation', action: 'child-hub.join', target: (_p, req) => `child hub ${req.body?.name ?? ''}`.trim(), noBody: true, source: 'federation' },
  { method: 'POST', path: '/v1/federation/release-request', area: 'federation', action: 'child-hub.leave-request', target: () => 'child hub', noBody: true },
  // JIRA (the org's app) and the org itself
  { method: 'PUT', path: '/v1/admin/jira', area: 'jira', action: 'jira.update', target: () => "the org's JIRA app", snapshot: jiraSnap },
  { method: 'POST', path: '/v1/admin/jira/disconnect-all', area: 'jira', action: 'jira.disconnect-all', target: () => 'every JIRA connection', noBody: true },
  { method: 'POST', path: '/v1/admin/orgs/rename', area: 'org', action: 'org.rename', target: () => 'org', orgAfter: req => (typeof req.body?.to === 'string' && req.body.to.trim() ? req.body.to.trim() : null) },
];

/** Mutating routes that are not configuration, and why. */
export const AUDIT_EXEMPT_ROUTES: Record<string, string> = {
  'POST /auth/login': 'a sign-in, not a change to any setting',
  'POST /auth/logout': 'a sign-out, not a change to any setting',
  'POST /v1/events': "installations' activity events, the hub's data, not its configuration",
  'POST /v1/admin/flows/contract': 'describes a draft flow and stores nothing',
  'POST /v1/admin/rollups/recompute': 'rebuilds derived statistics from the events; no setting changes',
  'POST /v1/admin/system/pending/ack': 'dismisses a notice the hub showed; no setting changes',
  'POST /hub/device/start': 'a device asking to connect; nothing changes until an admin approves it (audited)',
  'POST /hub/device/poll': 'a device waiting for approval; read-only',
  'POST /v1/jira/oauth/start': "a person connecting their own JIRA account, not the org's configuration",
  'POST /v1/jira/oauth/complete': "a person connecting their own JIRA account, not the org's configuration",
  'POST /v1/jira/disconnect': "a person disconnecting their own JIRA account, not the org's configuration",
  'POST /v1/federation/ping': "a child hub's heartbeat; no setting changes",
  'POST /v1/federation/deliver': "a child hub delivering its events, the hub's data, not configuration",
};

/**
 * Where each router was mounted, by the layer `app.use` created. Express 5's
 * router keeps no mount path on that layer (Express 4 kept a regexp it could
 * be read back from), so the hub mounts its routers through `mountRouter` and
 * the walker reads the path from here.
 */
const mountPaths = new WeakMap<object, string>();

/** `app.use(at, router)`, remembering `at` for the route walker. */
export function mountRouter(app: Express, at: string, router: RequestHandler): void {
  app.use(at, router);
  const stack: any[] = (app as any).router.stack;
  mountPaths.set(stack[stack.length - 1], at === '/' ? '' : at.replace(/\/$/, ''));
}

/** A mounted router's path. Unknown is an error: guessing would audit the wrong paths, or none. */
function mountPathOf(layer: any): string {
  if (layer.slash) return '';
  const at = mountPaths.get(layer);
  if (at === undefined) throw new Error('config audit: a router is mounted at a path the walker cannot see - mount it with mountRouter()');
  return at;
}

/** Every mutating route the app serves, as "METHOD /full/path". */
export function mutatingRoutesOf(app: Express): string[] {
  const out = new Set<string>();
  eachRoute(app, (route, full) => {
    for (const m of Object.keys(route.methods)) {
      const method = m.toUpperCase();
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) out.add(`${method} ${full}`);
    }
  });
  return [...out].sort();
}

const AUDIT_LAYER = 'configAuditLayer';

/** Who made a request, from what its guard set on it. */
async function actorOf(db: DB, req: Request): Promise<{ orgId: string | null; source: AuditSource | null; actor: { userId: string | null; email: string | null } | null }> {
  if (req.session) {
    const u = await db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [req.session.userId]);
    return { orgId: req.session.orgId, source: 'board', actor: { userId: req.session.userId, email: u?.email ?? null } };
  }
  if (req.hubApiKey) return { orgId: req.hubApiKey.orgId, source: 'cli', actor: { userId: null, email: req.hubApiKey.installationId ? `installation ${req.hubApiKey.installationId}` : 'API key' } };
  if (req.hubFederation) return { orgId: req.hubFederation.orgId, source: 'federation', actor: { userId: null, email: `child hub ${req.hubFederation.childHubId}` } };
  return { orgId: null, source: null, actor: null };
}

/** The org a request acts on: its credential's, else this hub's org as it is now (an org rename changes it). */
const orgOf = (req: Request, config: { defaultOrgId: string }) =>
  req.session?.orgId ?? req.hubApiKey?.orgId ?? req.hubFederation?.orgId ?? config.defaultOrgId;

/** The audit layer of one route: before-snapshot now, the row once the handler answers 2xx, before the reply leaves. */
function auditLayerFor(route: AuditedRoute, db: DB, config: { defaultOrgId: string }) {
  const layer = async function configAuditLayer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const params: Params = { ...(req.params as Params) };
      let before: unknown = null;
      if (route.snapshot && !route.createdId) {
        try { before = await route.snapshot(db, orgOf(req, config), params, req); } catch { before = null; }
      }
      let replyBody: any = null;
      const json = res.json.bind(res);
      res.json = (b: any) => { replyBody = b; return json(b); };
      const end = res.end.bind(res) as (...a: any[]) => Response;
      let ended = false;
      (res as any).end = (...args: any[]) => {
        if (ended || res.statusCode < 200 || res.statusCode >= 300) return end(...args);
        ended = true;
        // The reply is decided; headersSent stays false until the row is written, so say so (BUG 915f76ed).
        res.locals.auditReplyPending = true;
        const record = async () => {
          const who = await actorOf(db, req);
          const orgId = route.orgAfter?.(req) ?? who.orgId ?? config.defaultOrgId;
          const actor = who.actor ?? route.actorFromReply?.(replyBody) ?? route.actorFromRequest?.(req) ?? null;
          const source: AuditSource = who.source ?? route.source ?? 'system';
          let after: unknown = null;
          if (route.snapshot) {
            const id = route.createdId ? route.createdId(replyBody) : undefined;
            try { after = id === null ? null : await route.snapshot(db, orgId, id ? { ...params, id } : params, req); } catch { after = null; }
          } else if (!route.noBody && req.method !== 'DELETE') {
            after = req.body && typeof req.body === 'object' && Object.keys(req.body).length ? req.body : null;
          }
          let target: string | null = null;
          try { target = route.target ? route.target(params, req, replyBody) : null; } catch { target = null; }
          await recordAudit(db, { orgId, actor, source, ip: req.ip ?? null, area: route.area, action: route.action, target, before, after, link: route.link ?? null });
        };
        record().catch(err => console.error('[HUB] audit:', (err as Error).message)).finally(() => end(...args));
        return res;
      };
    } catch (err) {
      console.error('[HUB] audit layer:', (err as Error).message);
    }
    next();
  };
  return layer;
}

/** Walks the app's routers: every route layer, with the path it is served at. */
function eachRoute(app: Express, visit: (route: any, fullPath: string) => void): void {
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack ?? []) {
      if (layer.route) visit(layer.route, `${prefix}${layer.route.path === '/' ? '' : layer.route.path}` || '/');
      else if (layer.name === 'router' && layer.handle?.stack) walk(layer.handle.stack, prefix + mountPathOf(layer));
    }
  };
  walk((app as any).router?.stack ?? [], '');
}

/**
 * Puts the audit layer into every audited route, right before its handler -
 * after the route's guards. Called once routers are mounted. Throws if a
 * table entry names a route the hub does not serve: an audit that silently
 * covers nothing is the failure this exists to prevent.
 */
export function installConfigAudit(app: Express, db: DB, config: { defaultOrgId: string }): number {
  const byKey = new Map(AUDITED_ROUTES.map(r => [`${r.method} ${r.path}`, r]));
  const installed = new Set<string>();
  eachRoute(app, (route, full) => {
    for (const m of Object.keys(route.methods)) {
      const key = `${m.toUpperCase()} ${full}`;
      const entry = byKey.get(key);
      if (!entry || installed.has(key)) continue;
      const stack: any[] = route.stack;
      const handlerAt = stack.map(l => l.method).lastIndexOf(m);
      if (handlerAt === -1) continue;
      route[m](auditLayerFor(entry, db, config));
      const added = stack.pop();
      stack.splice(handlerAt, 0, added);
      installed.add(key);
    }
  });
  const missing = [...byKey.keys()].filter(k => !installed.has(k));
  if (missing.length) throw new Error(`config audit: no served route for ${missing.join(', ')}`);
  return installed.size;
}

/** The routes carrying an audit layer, as "METHOD /full/path" - for the completeness test. */
export function auditedRoutesOf(app: Express): string[] {
  const out = new Set<string>();
  eachRoute(app, (route, full) => {
    for (const l of route.stack ?? []) if (l.handle?.name === AUDIT_LAYER) out.add(`${String(l.method).toUpperCase()} ${full}`);
  });
  return [...out].sort();
}
