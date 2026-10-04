import type { Request, Response, NextFunction, Express } from 'express';
import type { DB } from '../db.js';
import { recordAudit, type AuditSource } from './configAudit.js';

/**
 * Which hub routes change configuration, and how each is audited (STORY
 * a89af514). One middleware reads this table, so a route's audit entry sits
 * next to every other's and the completeness test can hold the table against
 * the routers the hub actually serves: a mutating route is either here or in
 * AUDIT_EXEMPT_ROUTES with the reason it is not configuration.
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
}

const parse = (s: unknown) => { try { return typeof s === 'string' ? JSON.parse(s) : s ?? null; } catch { return s; } };
const flowSnap: Snapshot = async (db, orgId, p) => {
  const r = await db.get<any>('SELECT id, name, description, definition_json, source, version, org_available FROM flows WHERE id = ? AND org_id = ?', [p.id, orgId]);
  if (!r) return null;
  const { definition_json, ...rest } = r;
  return { ...rest, org_available: Number(r.org_available), definition: parse(definition_json) };
};
const userSnap: Snapshot = async (db, orgId, p) =>
  (await db.get('SELECT id, email, name, role, active, provider FROM users WHERE id = ? AND org_id = ?', [p.id, orgId])) ?? null;
const authConfigSnap: Snapshot = async (db, orgId) => (await db.get('SELECT * FROM auth_config WHERE org_id = ?', [orgId])) ?? null;
const registrySnap: Snapshot = async (db, orgId) =>
  (await db.get('SELECT registry_repo, registry_branch, registry_token_enc, identity_policy FROM org_settings WHERE org_id = ?', [orgId])) ?? null;
const assignmentsSnap: Snapshot = async (db, orgId) =>
  db.all('SELECT scope, target_id, flow_id FROM flow_assignments WHERE org_id = ? ORDER BY scope, target_id', [orgId]);
const childHubSnap: Snapshot = async (db, orgId, p) => (await db.get('SELECT * FROM child_hubs WHERE id = ? AND org_id = ?', [p.id, orgId])) ?? null;
const identityPolicySnap: Snapshot = async (db, orgId) =>
  (await db.get('SELECT identity_policy FROM org_settings WHERE org_id = ?', [orgId])) ?? null;

const param = (k: string, label: string) => (p: Params) => `${label} ${p[k] ?? ''}`.trim();
const bodyField = (k: string, label: string) => (_p: Params, req: Request) => (typeof req.body?.[k] === 'string' ? `${label} ${req.body[k]}` : label);

export const AUDITED_ROUTES: AuditedRoute[] = [
  // Sign-in
  { method: 'PUT', path: '/v1/admin/auth-config', area: 'sign-in', action: 'auth-config.update', target: () => 'sign-in settings', snapshot: authConfigSnap },
  { method: 'POST', path: '/auth/recover', area: 'sign-in', action: 'admin.recover', target: (_p, _r, b) => `admin ${b?.email ?? ''}`.trim(), noBody: true, actorFromReply: b => (b?.id ? { userId: b.id, email: b.email ?? null } : null) },
  { method: 'POST', path: '/setup/initial-admin', area: 'users', action: 'admin.bootstrap', target: bodyField('email', 'admin'), noBody: true },
  // API keys and installations
  { method: 'POST', path: '/v1/admin/api-keys', area: 'api-keys', action: 'api-key.issue', target: bodyField('label', 'API key'), noBody: true },
  { method: 'DELETE', path: '/v1/admin/api-keys/:tokenHashPreview', area: 'api-keys', action: 'api-key.revoke', target: param('tokenHashPreview', 'API key') },
  { method: 'POST', path: '/hub/device/approve', area: 'api-keys', action: 'device.approve', target: bodyField('userCode', 'device'), noBody: true },
  { method: 'POST', path: '/hub/invite/create', area: 'api-keys', action: 'invite.create', target: () => 'installation invite', noBody: true },
  { method: 'POST', path: '/hub/invite/redeem', area: 'api-keys', action: 'invite.redeem', target: () => 'installation invite', noBody: true },
  { method: 'POST', path: '/v1/admin/installations/:id/retire', area: 'installations', action: 'installation.retire', target: param('id', 'installation'), link: '/admin/installations' },
  { method: 'DELETE', path: '/v1/admin/installations/:id/retire', area: 'installations', action: 'installation.restore', target: param('id', 'installation'), link: '/admin/installations' },
  // People
  { method: 'POST', path: '/v1/admin/users/invite', area: 'users', action: 'user.invite', target: bodyField('email', 'user') },
  { method: 'PUT', path: '/v1/admin/users/:id', area: 'users', action: 'user.update', target: param('id', 'user'), snapshot: userSnap },
  { method: 'DELETE', path: '/v1/admin/users/:id', area: 'users', action: 'user.delete', target: param('id', 'user'), snapshot: userSnap },
  { method: 'POST', path: '/v1/admin/hidden-users', area: 'people', action: 'person.hide', target: bodyField('userKey', 'person') },
  { method: 'DELETE', path: '/v1/admin/hidden-users/:userKey', area: 'people', action: 'person.unhide', target: param('userKey', 'person') },
  { method: 'POST', path: '/v1/admin/user-keys/merge', area: 'identities', action: 'identity.merge', target: () => 'identity merge', link: '/admin/identities' },
  { method: 'POST', path: '/v1/admin/user-keys/merges/:id/revert', area: 'identities', action: 'identity.merge-revert', target: param('id', 'merge'), link: '/admin/identities' },
  { method: 'POST', path: '/v1/admin/repoint', area: 'identities', action: 'repoint.start', target: () => 'repoint', link: '/admin/repoint' },
  { method: 'POST', path: '/v1/admin/repoint/:id/close', area: 'identities', action: 'repoint.close', target: param('id', 'repoint'), link: '/admin/repoint' },
  // Models
  { method: 'PUT', path: '/v1/admin/models/meta', area: 'models', action: 'model.classify', target: bodyField('model', 'model'), link: '/admin/models' },
  { method: 'DELETE', path: '/v1/admin/models/meta/:model', area: 'models', action: 'model.unclassify', target: param('model', 'model'), link: '/admin/models' },
  { method: 'POST', path: '/v1/admin/models/mappings', area: 'models', action: 'model.map', target: bodyField('aliasModel', 'alias'), link: '/admin/models' },
  { method: 'DELETE', path: '/v1/admin/models/mappings/:aliasModel', area: 'models', action: 'model.unmap', target: param('aliasModel', 'alias'), link: '/admin/models' },
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
  { method: 'POST', path: '/v1/federation/enroll', area: 'federation', action: 'child-hub.join', target: (_p, req) => `child hub ${req.body?.name ?? ''}`.trim(), noBody: true },
  { method: 'POST', path: '/v1/federation/release-request', area: 'federation', action: 'child-hub.leave-request', target: () => 'child hub', noBody: true },
  // JIRA (the org's app) and the org itself
  { method: 'PUT', path: '/v1/admin/jira', area: 'jira', action: 'jira.update', target: () => "the org's JIRA app" },
  { method: 'POST', path: '/v1/admin/jira/disconnect-all', area: 'jira', action: 'jira.disconnect-all', target: () => 'every JIRA connection' },
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

/** Express 4: a mounted router's path, from the regexp it was mounted with. */
function mountPathOf(layer: any): string {
  if (layer.regexp?.fast_slash) return '';
  const src: string = layer.regexp?.source ?? '';
  const m = src.match(/^\^((?:\\\/[^\\?()]+)+)\\\/\?\(\?=\\\/\|\$\)$/);
  return m ? m[1].replace(/\\\//g, '/') : '';
}

/** Every mutating route the app serves, as "METHOD /full/path". */
export function mutatingRoutesOf(app: Express): string[] {
  const out = new Set<string>();
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack ?? []) {
      if (layer.route) {
        const full = `${prefix}${layer.route.path === '/' ? '' : layer.route.path}` || '/';
        for (const m of Object.keys(layer.route.methods)) {
          const method = m.toUpperCase();
          if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) out.add(`${method} ${full}`);
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPathOf(layer));
      }
    }
  };
  walk((app as any)._router?.stack ?? [], '');
  return [...out].sort();
}

const compiled = AUDITED_ROUTES.map(r => {
  const names: string[] = [];
  const re = new RegExp(`^${r.path.replace(/:([A-Za-z]+)/g, (_m, n) => { names.push(n); return '([^/]+)'; })}/?$`);
  return { route: r, re, names };
});

function matchRoute(method: string, pathname: string): { route: AuditedRoute; params: Params } | null {
  for (const c of compiled) {
    if (c.route.method !== method) continue;
    const m = c.re.exec(pathname);
    if (!m) continue;
    const params: Params = {};
    c.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    return { route: c.route, params };
  }
  return null;
}

/** Who made a request, from what the guards set on it. */
async function actorOf(db: DB, req: Request): Promise<{ orgId: string | null; source: AuditSource; actor: { userId: string | null; email: string | null } | null }> {
  if (req.session) {
    const u = await db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [req.session.userId]);
    return { orgId: req.session.orgId, source: 'board', actor: { userId: req.session.userId, email: u?.email ?? null } };
  }
  if (req.hubApiKey) return { orgId: req.hubApiKey.orgId, source: 'cli', actor: { userId: null, email: req.hubApiKey.installationId ? `installation ${req.hubApiKey.installationId}` : 'API key' } };
  if (req.hubFederation) return { orgId: req.hubFederation.orgId, source: 'federation', actor: { userId: null, email: `child hub ${req.hubFederation.childHubId}` } };
  return { orgId: null, source: 'federation', actor: null };
}

/**
 * The audit middleware. Mounted before the routers: it reads the target's
 * state before the handler runs, then records the row once a 2xx response has
 * finished - by which time the guards have said who made the request.
 */
export function configAuditMiddleware(db: DB, defaultOrgId: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const hit = matchRoute(req.method, req.path);
    if (!hit) return next();
    const { route, params } = hit;
    // The org is known only once a guard has run; the snapshot reads the default org's row, which is this hub's.
    let before: unknown = null;
    try { before = route.snapshot && !route.createdId ? await route.snapshot(db, defaultOrgId, params, req) : null; } catch { before = null; }
    let replyBody: any = null;
    const json = res.json.bind(res);
    res.json = (b: any) => { replyBody = b; return json(b); };
    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      void (async () => {
        const who = await actorOf(db, req);
        const orgId = route.orgAfter?.(req) ?? who.orgId ?? defaultOrgId;
        const actor = who.actor ?? route.actorFromReply?.(replyBody) ?? null;
        const source: AuditSource = who.actor ? who.source : route.actorFromReply ? 'board' : who.source;
        let after: unknown = null;
        if (route.snapshot) {
          const id = route.createdId ? route.createdId(replyBody) : undefined;
          const at = id ? { ...params, id } : params;
          try { after = id === null ? null : await route.snapshot(db, orgId, at, req); } catch { after = null; }
        } else if (!route.noBody && req.method !== 'DELETE') {
          after = req.body && typeof req.body === 'object' && Object.keys(req.body).length ? req.body : null;
        }
        let target: string | null = null;
        try { target = route.target ? route.target(params, req, replyBody) : null; } catch { target = null; }
        await recordAudit(db, { orgId, actor, source, ip: req.ip ?? null, area: route.area, action: route.action, target, before, after, link: route.link ?? null });
      })().catch(err => console.error('[HUB] audit middleware:', (err as Error).message));
    });
    next();
  };
}
