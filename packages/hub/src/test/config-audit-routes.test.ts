/**
 * STORY a89af514 (task 2/3) — every config change on the hub lands in the
 * audit log: who (the signed-in admin, an installation's key, or a federation
 * parent), from where (board / cli / federation, and the address), what (area,
 * action, target) and from what to what.
 *
 * One middleware audits the routes listed in its table; a request that is
 * refused writes nothing. The completeness test walks the routers' real stack,
 * so a new config route added without an audit entry - or an explicit,
 * explained exemption - fails here instead of going unrecorded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { listAudit, type AuditRow } from '../services/configAudit';
import { AUDITED_ROUTES, AUDIT_EXEMPT_ROUTES, mutatingRoutesOf } from '../services/configAuditRoutes';
import { installDispatchedFlow } from '../services/federation/federationSync';
import { releaseParentFlows } from '../services/federation/parentFlows';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-audit-routes-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); };

let server: any;
let app: any;
let ctx: any;
let admin = '';

beforeEach(async () => {
  cleanup();
  const out = await createHubApp({ dbPath: TEST_DB, secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org' } as any);
  app = out.app;
  server = app.listen(0);
  ctx = out.ctx;
  await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
  await createPasswordUser(ctx.db, 'org', 'second@x', 'longenough1', 'admin');
  await createPasswordUser(ctx.db, 'org', 'viewer@x', 'longenough1', 'viewer');
  admin = await loginAs(server, 'admin@x', 'longenough1');
});
afterEach(async () => { await drainApp(server); await ctx.db.close(); cleanup(); });

/** The rows recorded so far, newest first. Rows are written as the response finishes, so wait for `n` of them. */
async function rows(n = 1, area?: string): Promise<AuditRow[]> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const r = (await listAudit(ctx.db, 'org', { area, limit: 200 })).rows;
    if (r.length >= n || Date.now() > deadline) return r;
    await new Promise(res => setTimeout(res, 20));
  }
}
const as = (cookie: string) => ({
  put: (p: string, body: unknown) => supertest(server).put(p).set('Cookie', cookie).send(body as object),
  post: (p: string, body: unknown) => supertest(server).post(p).set('Cookie', cookie).send(body as object),
  del: (p: string) => supertest(server).delete(p).set('Cookie', cookie),
});
const definition = (name: string, label = 'Build') => ({
  name,
  steps: [
    { id: 's0', name: 'todo', label: 'Todo', order: 0, isAnchor: true },
    { id: 's1', name: 'build', label, order: 1, role: 'coding' },
    { id: 's2', name: 'done', label: 'Done', order: 2, isAnchor: true },
  ],
});

describe('a change on the board', () => {
  it('records the sign-in settings before and after, by whom and from where, with no secret in it', async () => {
    const r = await as(admin).put('/v1/admin/auth-config', {
      passwordEnabled: true, googleEnabled: true, google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'very-secret-value' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [row] = await rows(1);
    expect(row).toMatchObject({ area: 'sign-in', action: 'auth-config.update', actorEmail: 'admin@x', source: 'board' });
    expect(row.ip).toBeTruthy();
    expect(row.before).toBeTruthy();
    expect(row.after).toBeTruthy();
    expect(JSON.stringify(await ctx.db.all('SELECT * FROM config_audit', []))).not.toContain('very-secret-value');
  });

  it('records a flow created, edited (before -> after) and deleted', async () => {
    const created = await as(admin).post('/v1/admin/flows', { definition: definition('Main') });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const id = created.body.id;
    expect((await as(admin).put(`/v1/admin/flows/${id}`, { definition: definition('Main', 'Implement') })).status).toBe(200);
    expect((await as(admin).del(`/v1/admin/flows/${id}`)).status).toBeLessThan(300);
    const r = await rows(3, 'flows');
    expect(r.map(x => x.action)).toEqual(['flow.delete', 'flow.update', 'flow.create']);
    const [del, upd, add] = r;
    expect(add.after).toMatchObject({ name: 'Main' });
    expect(JSON.stringify(upd.before)).toContain('"Build"');
    expect(JSON.stringify(upd.after)).toContain('"Implement"');
    expect(upd.target).toContain(id);
    expect(del.before).toBeTruthy();
    expect(del.after).toBeNull();
  });

  it("records a person's role change before -> after", async () => {
    const viewer = await ctx.db.get('SELECT id FROM users WHERE email = ?', ['viewer@x']);
    expect((await as(admin).put(`/v1/admin/users/${viewer.id}`, { role: 'admin' })).status).toBe(200);
    const [row] = await rows(1, 'users');
    expect(row).toMatchObject({ action: 'user.update' });
    expect(row.before).toMatchObject({ email: 'viewer@x', role: 'viewer' });
    expect(row.after).toMatchObject({ email: 'viewer@x', role: 'admin' });
  });

  it('links a change to the older trail of the same kind', async () => {
    expect((await as(admin).post('/v1/admin/models/mappings', { aliasModel: 'opus-x', canonicalModel: 'claude-opus-5-5' })).status).toBeLessThan(300);
    const [row] = await rows(1, 'models');
    expect(row.link).toBe('/admin/models');
  });

  it('writes nothing for a refused request', async () => {
    const viewer = await loginAs(server, 'viewer@x', 'longenough1');
    expect((await as(viewer).put('/v1/admin/auth-config', { passwordEnabled: false })).status).toBe(403);
    expect((await as(admin).post('/v1/admin/flows', { definition: { nope: true } })).status).toBe(400);
    await new Promise(res => setTimeout(res, 150));
    expect((await listAudit(ctx.db, 'org')).rows).toEqual([]);
  });
});

describe('renaming the org', () => {
  it("files the rename's own row under the new org, so it survives the rename it records", async () => {
    const r = await as(admin).post('/v1/admin/orgs/rename', { from: 'org', to: 'acme' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const deadline = Date.now() + 3000;
    let mine: AuditRow[] = [];
    while (!mine.length && Date.now() < deadline) {
      mine = (await listAudit(ctx.db, 'acme')).rows.filter(x => x.action === 'org.rename');
      if (!mine.length) await new Promise(res => setTimeout(res, 20));
    }
    expect(mine).toHaveLength(1);
    expect(mine[0].after).toMatchObject({ from: 'org', to: 'acme' });
  });
});

describe('a change from an installation (the CLI)', () => {
  it("records a project's flow selection as source cli", async () => {
    const created = await as(admin).post('/v1/admin/flows', { definition: definition('Picked') });
    await as(admin).put(`/v1/admin/flows/${created.body.id}/availability`, { available: true });
    const token = await issueApiKey(ctx.db, 'org', 'client', { installationId: 'inst-1' });
    const r = await supertest(server).put('/v1/flows/selection').set('Authorization', `Bearer ${token}`).send({ repo: 'https://github.com/acme/app', flowId: created.body.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const sel = (await rows(4)).find(x => x.action === 'flow.select');
    expect(sel, JSON.stringify(await rows(4))).toMatchObject({ source: 'cli', area: 'flows' });
    expect(sel!.target).toContain('github.com/acme/app');
    expect(JSON.stringify(sel)).not.toContain(token);
  });
});

describe('a change from the federation parent', () => {
  it('records a flow the parent dispatched, and the release of parent flows', async () => {
    const ok = await installDispatchedFlow(ctx.db, 'org', { dispatchId: 'd-1', flowVersion: 2, flow: { id: 'pf-1', name: 'Parent flow', version: 2, definition: definition('Parent flow') } } as any);
    expect(ok).toBe(true);
    await releaseParentFlows(ctx.db);
    const r = await rows(2, 'federation');
    expect(r.map(x => x.action)).toEqual(['flows.release', 'flow.dispatch-install']);
    expect(r[1]).toMatchObject({ source: 'federation', target: expect.stringContaining('Parent flow') });
  });
});

describe('completeness', () => {
  it('every mutating route the hub serves is audited, or exempt with a reason', () => {
    const served = mutatingRoutesOf(app);
    expect(served.length).toBeGreaterThan(40);
    const known = new Set([...AUDITED_ROUTES.map(r => `${r.method} ${r.path}`), ...Object.keys(AUDIT_EXEMPT_ROUTES)]);
    expect(served.filter(r => !known.has(r))).toEqual([]);
    for (const [route, why] of Object.entries(AUDIT_EXEMPT_ROUTES)) expect(why.length, route).toBeGreaterThan(10);
    // Nothing listed that the hub does not serve: a stale entry would hide a renamed route.
    expect([...known].filter(r => !served.includes(r))).toEqual([]);
  });
});
